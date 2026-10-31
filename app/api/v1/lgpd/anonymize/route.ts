/**
 * POST /api/v1/lgpd/anonymize
 *
 * Anonimização irreversível de um contato (Spec 05 §LGPD). Só `admin` na org do
 * contato (ou platform_admin). Idempotente: re-anonimizar devolve 200 com
 * `action: "already_anonymized"`.
 *
 * A cascata inteira (contacts, conversations, messages, atividades, leads, fila
 * de remoção de mídia/avatar) é a MESMA do worker de pedidos LGPD:
 * `cascadeRedactContact` → RPC `fn_lgpd_cascade_redact_contact`, numa única
 * transação. A rota não faz UPDATE próprio: o antigo gravava `email_normalized`
 * (coluna GERADA) e o Postgres recusava, então nada era anonimizado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { cascadeRedactContact } from "@/lib/lgpd/redact-cascade";
import { lgpdAnonymizeSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  let input;
  try {
    input = await validateRequest(lgpdAnonymizeSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Fetch contact (RLS scoped).
  const { data: existing, error: selErr } = await supabase
    .from("contacts")
    .select("id, organization_id, is_anonymized, anonymized_at")
    .eq("id", input.contact_id)
    .maybeSingle();
  if (selErr) {
    return fail("internal_error", selErr.message, 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Contato não encontrado.", 404, { requestId });
  }

  // Permission: admin NA ORG DO CONTATO (pode diferir da org ativa do cookie)
  // OR platform_admin. Org do contato vem de query RLS-scoped (fonte confiável).
  const authz = await requireRole("admin", {
    requestId,
    resource: "contact",
    allowPlatformAdmin: true,
    organizationId: existing.organization_id,
  });
  if (!authz.ok) return authz.response;

  // Idempotency.
  if (existing.is_anonymized) {
    return ok(
      {
        contact_id: existing.id,
        anonymized_at: existing.anonymized_at,
        action: "already_anonymized",
      },
      { requestId },
    );
  }

  // O client de service role só entra aqui: a org do contato veio da query
  // RLS-scoped acima (nunca do body) e o gate de papel já passou nela.
  let cascata;
  try {
    cascata = await cascadeRedactContact({
      organizationId: existing.organization_id,
      contactId: existing.id,
      requestId,
    });
  } catch (err) {
    console.error("[lgpd.anonymize] cascata falhou", err instanceof Error ? err.message : err);
    return fail("internal_error", "Não foi possível anonimizar o contato.", 500, { requestId });
  }

  // Outra chamada anonimizou entre o SELECT e a cascata: nada a emitir nem auditar.
  if (cascata.alreadyAnonymized) {
    return ok(
      { contact_id: existing.id, anonymized_at: null, action: "already_anonymized" },
      { requestId },
    );
  }

  const nowIso = new Date().toISOString();

  // Emit + audit.
  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.anonymized",
      p_entity_kind: "contact",
      p_entity_id: existing.id,
      p_payload: {
        contact_id: existing.id,
        actor_user_id: user.id,
        justification: input.justification,
      },
      p_metadata: { request_id: requestId },
      p_organization_id: existing.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lgpd.anonymize] emit_event failed", error.message);
    });

  await audit({
    action: "lgpd.anonymize_executed",
    actorUserId: user.id,
    organizationId: existing.organization_id,
    resourceType: "contact",
    resourceId: existing.id,
    requestId,
    metadata: {
      contact_id: existing.id,
      justification: input.justification,
      cascade_counts: cascata.counts,
      media_paths_enqueued: cascata.mediaPaths.length,
    },
  });

  return ok(
    { contact_id: existing.id, anonymized_at: nowIso, action: "anonymized" },
    { requestId },
  );
}
