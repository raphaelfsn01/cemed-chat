/**
 * Épico Operação Visível (F2ii) — knobs do anti-ban por conexão.
 *
 * GET  → todas as conexões da org com knobs efetivos (override sobre default),
 *        overrides crus, defaults e bounds (a tela explica sem cravar números).
 * PUT  → upsert de channel_knobs para UMA conexão + teto diário em
 *        channel_sessions.daily_message_limit (fonte única — regra dura nº 3).
 *        Campo null = volta ao default conservador do engine.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  pacingKnobsUpdateSchema,
  knobsView,
  effectiveKnobs,
  windowIsValid,
  type ChannelKnobsRow,
} from "@/lib/ai/pacing-knobs";

export const dynamic = "force-dynamic";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Data sugerida para a ativação do número: a MAIS ANTIGA entre a criação da conexão no
 * sistema e o 1º envio do agente registrado (`pacing_ledger`). O ledger sozinho não basta:
 * ele só registra envio do AGENTE, e um número antigo que só passou a ter agente agora
 * pareceria novo — o teto de aquecimento voltaria (caso real de 14/11/2026: 20/dia).
 */
async function ativoDesdeSugerido(
  admin: Admin,
  orgId: string,
  sessionId: string,
  sessionCreatedAt: string | null,
): Promise<string | null> {
  const { data } = await admin
    .from("pacing_ledger")
    .select("sent_at")
    .eq("organization_id", orgId)
    .eq("channel_session_id", sessionId)
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const candidatas = [sessionCreatedAt, (data?.sent_at as string | undefined) ?? null].filter(
    (d): d is string => typeof d === "string" && d.length >= 10,
  );
  if (candidatas.length === 0) return null;
  return candidatas.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

const KNOB_COLUMNS =
  "throttle_ms, jitter_max_ms, window_start_hour, window_end_hour, allow_sunday, timezone, warmup_daily_caps, number_activated_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "channel_knobs" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();
  const [{ data: sessions, error: sErr }, { data: knobs, error: kErr }] = await Promise.all([
    admin
      .from("channel_sessions")
      .select("id, waha_session_name, display_name, phone_number, status, daily_message_limit, created_at")
      .eq("organization_id", org.orgId)
      // Canal arquivado foi excluído pelo usuário: não volta como opção aqui.
      .is("archived_at", null)
      .order("created_at", { ascending: true }),
    admin
      .from("channel_knobs")
      .select(`channel_session_id, ${KNOB_COLUMNS}`)
      .eq("organization_id", org.orgId),
  ]);
  if (sErr || kErr) {
    return fail("internal_error", "Falha ao carregar conexões/knobs.", 500, { requestId });
  }

  const byuSession = new Map<string, ChannelKnobsRow>(
    (knobs ?? []).map((k) => [k.channel_session_id as string, k as unknown as ChannelKnobsRow]),
  );
  // A tela sugere esta data quando a conexão ainda não tem configuração (sem ela, salvar
  // gravaria a data de hoje). Poucas conexões por org: uma consulta por conexão basta.
  const sugeridas = await Promise.all(
    (sessions ?? []).map(
      async (s) =>
        [s.id, await ativoDesdeSugerido(admin, org.orgId, s.id, (s.created_at as string | null) ?? null)] as const,
    ),
  );
  const sugerida = new Map(sugeridas);
  const items = (sessions ?? []).map((s) => ({
    channel_session: s,
    ...knobsView(byuSession.get(s.id) ?? null),
    ativo_desde_sugerido: sugerida.get(s.id) ?? null,
  }));
  return ok({ items }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_knobs" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = pacingKnobsUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { channel_session_id, daily_message_limit, ...camposEnviados } = parsed.data;
  const knobFields = { ...camposEnviados };

  const admin = createAdminClient();
  const { data: session } = await admin
    .from("channel_sessions")
    .select("id, created_at")
    .eq("id", channel_session_id)
    .eq("organization_id", org.orgId)
    // O MESMO filtro do GET, e não por simetria: sem ele a tela sumia com a
    // conexão excluída e a rota continuava aceitando gravar knobs e teto diário
    // nela — configuração viva pendurada num canal que não envia mais, à espera
    // de confundir quem investigar o próximo envio que não saiu.
    .is("archived_at", null)
    .maybeSingle();
  if (!session) {
    return fail("session_not_found", "Conexão não encontrada nesta organização.", 404, {
      requestId,
    });
  }

  // Valida a JANELA RESULTANTE (enviado sobre o estado atual): update parcial
  // não pode deixar start >= end no efetivo.
  const { data: currentRow } = await admin
    .from("channel_knobs")
    .select(KNOB_COLUMNS)
    .eq("organization_id", org.orgId)
    .eq("channel_session_id", channel_session_id)
    .maybeSingle();
  const merged: ChannelKnobsRow = {
    ...((currentRow as unknown as ChannelKnobsRow) ?? {
      throttle_ms: null,
      jitter_max_ms: null,
      window_start_hour: null,
      window_end_hour: null,
      allow_sunday: null,
      timezone: null,
      warmup_daily_caps: null,
    }),
    ...knobFields,
  };
  const eff = effectiveKnobs(merged);
  if (!windowIsValid(eff.windowStartHour, eff.windowEndHour)) {
    return fail(
      "validation_failed",
      `Janela inválida: início (${eff.windowStartHour}h) precisa ser antes do fim (${eff.windowEndHour}h).`,
      422,
      { requestId },
    );
  }

  // Conexão sem configuração e sem data enviada (cliente antigo, chamada por API): a
  // coluna é NOT NULL DEFAULT now() e gravaria HOJE — o número voltaria a ser tratado
  // como novo. Usa a data sugerida no lugar.
  if (Object.keys(knobFields).length > 0 && !currentRow && knobFields.number_activated_at === undefined) {
    const sugestao = await ativoDesdeSugerido(
      admin,
      org.orgId,
      channel_session_id,
      (session.created_at as string | null) ?? null,
    );
    if (sugestao !== null) knobFields.number_activated_at = sugestao.slice(0, 10);
  }

  if (Object.keys(knobFields).length > 0) {
    const { error: upErr } = await admin.from("channel_knobs").upsert(
      {
        organization_id: org.orgId,
        channel_session_id,
        ...knobFields,
      },
      { onConflict: "organization_id,channel_session_id" },
    );
    if (upErr) {
      return fail("internal_error", "Falha ao salvar os knobs.", 500, { requestId });
    }
  }

  if (daily_message_limit !== undefined) {
    const { error: dlErr } = await admin
      .from("channel_sessions")
      .update({ daily_message_limit })
      .eq("id", channel_session_id)
      .eq("organization_id", org.orgId);
    if (dlErr) {
      return fail("internal_error", "Falha ao salvar o teto diário.", 500, { requestId });
    }
  }

  await audit({
    action: "ai.pacing_knobs_updated",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "channel_knobs",
    resourceId: channel_session_id,
    metadata: { ...knobFields, daily_message_limit: daily_message_limit ?? null },
  });

  const { data: savedRow } = await admin
    .from("channel_knobs")
    .select(KNOB_COLUMNS)
    .eq("organization_id", org.orgId)
    .eq("channel_session_id", channel_session_id)
    .maybeSingle();
  return ok(
    { channel_session_id, ...knobsView((savedRow as unknown as ChannelKnobsRow) ?? null) },
    { requestId },
  );
}
