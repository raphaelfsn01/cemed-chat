import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as TurnNoReply from "@/lib/agent-engine/agent/turn-no-reply";

/**
 * Turno que conclui `done` sem mensagem ao paciente abre aviso na Central (kind
 * `turn_no_reply`, migration 0125), e o veto deixa trilha sem PII no trace.
 *
 * Contra Postgres real e com o handler REAL do turno (só o modelo e o canal são
 * dublês): o que se prova aqui é a cadeia inteira — fecho do turno → regra do
 * silêncio → INSERT aceito pelo CHECK → dedup por contato. Um unit com dublê do
 * banco não pegaria o CHECK recusando o kind, que é exatamente o modo de falha
 * que já deixou aviso sem chegar à tela (ver vocabulario-banco-x-typescript).
 *
 * Caso de origem: 23/10 14:45 BRT, job `done`, `messages_sent: 0`, nada na Central.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG = "0125aaaa-0000-4000-8000-000000000001";
const CONTACT = "0125aaaa-0000-4000-8000-000000000002";
const SESSION = "0125aaaa-0000-4000-8000-000000000003";
const CONV = "0125aaaa-0000-4000-8000-000000000004";
const MSG = "0125aaaa-0000-4000-8000-000000000005";
const EVENTO = "0125aaaa-0000-4000-8000-000000000006";
const VERSAO_TABELA = "0125aaaa-0000-4000-8000-000000000007";
/** Segundo contato, de OUTRA organização: o dedup não pode cruzar tenant. */
const ORG_B = "0125bbbb-0000-4000-8000-000000000001";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  turnNoReply: typeof TurnNoReply;
};
let m: Modules;

let enviados: string[] = [];

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Chamada = { toolName: string; input: Record<string, unknown> };

/** Modelo roteirizado: cada passo é uma lista de tool calls; acabou o roteiro, encerra com texto. */
function modeloComPassos(passos: Chamada[][]) {
  let n = 0;
  return async () => {
    const passo = passos[n++];
    if (passo === undefined) {
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: passo.map((c, i) => ({
        type: "tool-call" as const,
        toolCallId: `c${n}-${i}`,
        toolName: c.toolName,
        input: JSON.stringify(c.input),
      })),
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

function montaHandler(doGenerate: unknown) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 4,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push(i.body);
          return { kind: "sent" as const, idempotencyKey: "k", messageId: "m1" };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Dentro da janela horária do anti-ban.
    clock: () => new Date("2026-07-30T15:00:00Z"),
    sleep: async () => {},
  });
}

async function rodaTurno(handler: ReturnType<typeof montaHandler>): Promise<Error | null> {
  // O PG efêmero é compartilhado: neutraliza jobs alheios para o claim FIFO pegar o deste.
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: EVENTO,
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "tsr", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "tsr" });
    await m.queue.completeJob(pool, claimed!.id, "tsr");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "tsr", err);
    return err as Error;
  }
}

interface Aviso {
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  ref_kind: string | null;
  status: string;
}

async function avisosDoContato(kind?: string): Promise<Aviso[]> {
  const { rows } = await pool.query<Aviso>(
    `select kind, severity, title, body, ref_kind, status from agent_inbox_items
      where organization_id = $1 and ref_id = $2 and ($3::text is null or kind = $3)
      order by created_at`,
    [ORG, CONTACT, kind ?? null],
  );
  return rows;
}

async function entradasDeVeto(): Promise<Array<{ gate: string; code: string; detail: Record<string, unknown> }>> {
  const { rows } = await pool.query<{ trace: Array<Record<string, unknown>> }>(
    `select trace from before_send_traces
      where organization_id = $1 and contact_id = $2 and vetoed_code is not null
      order by created_at`,
    [ORG, CONTACT],
  );
  return rows.flatMap((r) =>
    r.trace
      .filter((e) => e.verdict === "veto")
      .map((e) => ({
        gate: String(e.gate),
        code: String(e.code),
        detail: (e.detail ?? {}) as Record<string, unknown>,
      })),
  );
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    turnNoReply: await import("@/lib/agent-engine/agent/turn-no-reply"),
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'turno-sem-resposta','Turno Sem Resposta','Turno Sem Resposta'),
            ($2,'turno-sem-resposta-b','Turno Sem Resposta B','Turno Sem Resposta B')
     on conflict (id) do nothing`,
    [ORG, ORG_B],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Paciente Fictício','+5511900000125') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name,
                                   status, webhook_secret_encrypted)
     values ($1,$2,'waha','tsr-waha','WORKING','\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
  // Tabela de promessa com piso de R$ 100,00: preço abaixo disso vira `promise_out_of_table`.
  await pool.query(
    `insert into promise_table_versions (id, organization_id, values)
     values ($1,$2,'{"minPriceCents": 10000}'::jsonb) on conflict (id) do nothing`,
    [VERSAO_TABELA, ORG],
  );
  await pool.query(
    `insert into promise_table_pointers (organization_id, version_id) values ($2,$1)
     on conflict (organization_id) do nothing`,
    [VERSAO_TABELA, ORG],
  );
});

beforeEach(async () => {
  enviados = [];
  await pool.query(
    `update contacts set force_human = false, is_blocked = false where organization_id = $1 and id = $2`,
    [ORG, CONTACT],
  );
  await pool.query(
    `update conversations set status = 'ai_handling', bot_silenced_until = null
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  await pool.query(`delete from outbound_copies where organization_id = $1 and channel_session_id = $2`, [
    ORG,
    SESSION,
  ]);
  await pool.query(`delete from pacing_ledger where organization_id = $1 and channel_session_id = $2`, [
    ORG,
    SESSION,
  ]);
  await pool.query(`delete from before_send_traces where organization_id = $1 and contact_id = $2`, [
    ORG,
    CONTACT,
  ]);
  await pool.query(`delete from agent_inbox_items where ref_id = $1`, [CONTACT]);
});

/** Texto que o gate de promessa veta (abaixo do piso). Único no arquivo: serve de isca de vazamento. */
const PRECO_VETADO = "O exame sai por R$ 5,00 nesta semana.";
const RESPOSTA = "Claro, me conta o que você precisa.";

describe("turno que termina sem resposta ao paciente", () => {
  it("modelo encerra sem chamar send_message → 1 aviso turn_no_reply, sem dado do paciente", async () => {
    const erro = await rodaTurno(montaHandler(modeloComPassos([])));
    expect(erro).toBeNull();
    expect(enviados).toEqual([]);

    const avisos = await avisosDoContato("turn_no_reply");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ severity: "warn", ref_kind: "contact", status: "open" });
    expect(avisos[0]!.body).toContain("não chegou a tentar responder");
    const texto = `${avisos[0]!.title} ${avisos[0]!.body}`;
    for (const pii of ["Paciente Fictício", "5511900000125", "Oi"]) {
      expect(texto).not.toContain(pii);
    }
  });

  it("dois turnos mudos seguidos → o segundo NÃO duplica; resolvido o primeiro, o próximo abre outro", async () => {
    expect(await rodaTurno(montaHandler(modeloComPassos([])))).toBeNull();
    expect(await rodaTurno(montaHandler(modeloComPassos([])))).toBeNull();
    expect(await avisosDoContato("turn_no_reply")).toHaveLength(1);

    await pool.query(
      `update agent_inbox_items set status = 'resolved' where organization_id = $1 and ref_id = $2`,
      [ORG, CONTACT],
    );
    expect(await rodaTurno(montaHandler(modeloComPassos([])))).toBeNull();
    const avisos = await avisosDoContato("turn_no_reply");
    expect(avisos.map((a) => a.status)).toEqual(["resolved", "open"]);
  });

  it("única tentativa vetada → aviso conta o veto por gate; trace leva attempt e body_len, nunca o texto", async () => {
    const envio = { toolName: "send_message", input: { body: PRECO_VETADO } };
    const erro = await rodaTurno(montaHandler(modeloComPassos([[envio]])));
    expect(erro).toBeNull();
    expect(enviados).toEqual([]);

    const vetos = await entradasDeVeto();
    expect(vetos).toHaveLength(1);
    expect(vetos[0]).toMatchObject({ gate: "promise", code: "promise_out_of_table" });
    expect(vetos[0]!.detail).toMatchObject({ attempt: 1, body_len: PRECO_VETADO.length });
    expect(vetos[0]!.detail).not.toHaveProperty("fallback");

    const avisos = await avisosDoContato("turn_no_reply");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.body).toContain("promise ×1");

    // O texto vetado não pode estar em NENHUM dos dois registros duráveis.
    const { rows } = await pool.query<{ bruto: string }>(
      `select coalesce((select string_agg(trace::text, ' ') from before_send_traces
                         where organization_id = $1 and contact_id = $2), '')
              || ' ' ||
              coalesce((select string_agg(coalesce(title,'') || ' ' || coalesce(body,''), ' ')
                          from agent_inbox_items where organization_id = $1 and ref_id = $2), '') as bruto`,
      [ORG, CONTACT],
    );
    expect(rows[0]!.bruto).not.toContain("5,00");
    expect(rows[0]!.bruto).not.toContain("exame");
  });

  it("duas tentativas vetadas → o fallback fixo sai, a 2ª entrada leva attempt 2, e NÃO há aviso de silêncio", async () => {
    const envio1 = { toolName: "send_message", input: { body: PRECO_VETADO } };
    const envio2 = { toolName: "send_message", input: { body: "Consigo fazer por R$ 7,00 para você." } };
    const erro = await rodaTurno(montaHandler(modeloComPassos([[envio1], [envio2]])));
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1); // o fallback fixo do código

    const vetos = await entradasDeVeto();
    expect(vetos.map((v) => v.detail.attempt)).toEqual([1, 2]);
    expect(await avisosDoContato("turn_no_reply")).toEqual([]);
  });

  it("turno que responde normalmente → nenhum aviso", async () => {
    const envio = { toolName: "send_message", input: { body: RESPOSTA } };
    expect(await rodaTurno(montaHandler(modeloComPassos([[envio]])))).toBeNull();
    expect(enviados).toEqual([RESPOSTA]);
    expect(await avisosDoContato("turn_no_reply")).toEqual([]);
  });

  it("handoff concluído no turno → a equipe já foi avisada pelo item handoff; sem turn_no_reply", async () => {
    const envio = { toolName: "send_message", input: { body: "Vou te passar para a equipe." } };
    const handoff = { toolName: "request_human_handoff", input: { reason: "pediu_humano" } };
    expect(await rodaTurno(montaHandler(modeloComPassos([[envio, handoff]])))).toBeNull();
    expect(await avisosDoContato("handoff")).toHaveLength(1);
    expect(await avisosDoContato("turn_no_reply")).toEqual([]);
  });

  it("contato com opt-out → silêncio é o comportamento certo; sem aviso", async () => {
    await pool.query(`update contacts set is_blocked = true where organization_id = $1 and id = $2`, [
      ORG,
      CONTACT,
    ]);
    const erro = await rodaTurno(montaHandler(modeloComPassos([])));
    expect(erro).toBeNull();
    expect(enviados).toEqual([]);
    expect(await avisosDoContato("turn_no_reply")).toEqual([]);
  });

  it("dedup não cruza organização: aviso aberto na org B não cala o da org A", async () => {
    // Mesmo ref_id, outra organização — só para provar o filtro por organization_id do dedup.
    expect(
      await m.turnNoReply.alertarTurnoSemResposta(pool, { tenantId: ORG_B, leadId: CONTACT, vetosPorGate: {} }),
    ).toBe(1);
    expect(
      await m.turnNoReply.alertarTurnoSemResposta(pool, { tenantId: ORG, leadId: CONTACT, vetosPorGate: {} }),
    ).toBe(1);
    expect(
      await m.turnNoReply.alertarTurnoSemResposta(pool, { tenantId: ORG, leadId: CONTACT, vetosPorGate: {} }),
    ).toBe(0);
  });
});
