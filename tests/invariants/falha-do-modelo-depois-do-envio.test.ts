import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";

/**
 * Falha do modelo DEPOIS de o turno já ter falado com o paciente.
 *
 * Caso real (25/11/2026, número de teste): o agente enviou as 3 mensagens do turno e,
 * na chamada seguinte, a OpenRouter devolveu 502 "Provider returned an empty response"
 * (o Gemini não tinha mais nada a dizer). O turno lançava, a fila o refazia INTEIRO e o
 * modelo, rodando de novo, tomou outra decisão: transferiu o paciente com um motivo de
 * outra conversa ("urgência, dor no peito"). Nada saiu em dobro só porque o ledger de
 * envio reaproveitou a mesma sequência.
 *
 * A regra: depois que algo chegou ao paciente (ou a conversa foi transferida), a falha
 * do modelo encerra o turno sem refazê-lo, como já vale para o checkpoint
 * (fechar-checkpoint.ts). Antes disso, a falha continua voltando à fila: refazer é a
 * única forma de o paciente não ficar sem resposta.
 *
 * Postgres real e handler REAL do turno; só o modelo e o canal são dublês.
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

const ORG = "fd0dfd0d-0000-4000-8000-000000000001";
const CONTACT = "fd0dfd0d-0000-4000-8000-000000000002";
const SESSION = "fd0dfd0d-0000-4000-8000-000000000003";
const CONV = "fd0dfd0d-0000-4000-8000-000000000004";
const MSG = "fd0dfd0d-0000-4000-8000-000000000005";
const EVENTO = "fd0dfd0d-0000-4000-8000-000000000006";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: string[] = [];
let logs: string[] = [];
let chamadasAoModelo = 0;

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Chamada = { toolName: string; input: Record<string, unknown> };

/** O erro que a OpenRouter devolve quando o Gemini responde vazio (medido em 25/11). */
const RESPOSTA_VAZIA = "Provider returned an empty response";

/** Modelo roteirizado: cada passo é uma lista de tool calls; acabou o roteiro, o provider falha. */
function modeloQueFalhaDepois(passos: Chamada[][]) {
  let n = 0;
  return async () => {
    chamadasAoModelo += 1;
    const passo = passos[n++];
    if (passo === undefined) throw new Error(RESPOSTA_VAZIA);
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

/** Dentro da janela horária do anti-ban (12h BRT). */
const DENTRO_DA_JANELA = new Date("2026-07-30T15:00:00Z");

function montaHandler(doGenerate: unknown) {
  const registra = (msg: string) => {
    logs.push(msg);
  };
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 6,
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
    log: { info: registra, warn: registra, error: registra },
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push(i.body);
          return { kind: "sent" as const, idempotencyKey: "k", messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => DENTRO_DA_JANELA,
    sleep: async () => {},
  });
}

/** Roda o turno e devolve o erro (ou null) e o status final do job na fila. */
async function rodaTurno(
  handler: ReturnType<typeof montaHandler>,
): Promise<{ erro: Error | null; status: string }> {
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
    maxAttempts: 3,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "fdm", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  let erro: Error | null = null;
  try {
    await handler(claimed!, pool, { workerId: "fdm" });
    await m.queue.completeJob(pool, claimed!.id, "fdm");
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "fdm", err);
    erro = err as Error;
  }
  const { rows } = await pool.query<{ status: string }>(`select status from job_queue where id = $1`, [job.id]);
  return { erro, status: rows[0]!.status };
}

async function avisosNaCentral(): Promise<string[]> {
  const { rows } = await pool.query<{ title: string }>(
    `select title from agent_inbox_items where organization_id = $1 and ref_id = $2 and status = 'open'
      order by created_at`,
    [ORG, CONTACT],
  );
  return rows.map((r) => r.title);
}

async function forceHuman(): Promise<boolean> {
  const { rows } = await pool.query<{ force_human: boolean }>(
    `select force_human from contacts where organization_id = $1 and id = $2`,
    [ORG, CONTACT],
  );
  return rows[0]!.force_human;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'falha-do-modelo','Falha do Modelo','Falha do Modelo') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Paciente Fictício','+5511900000131') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name,
                                   status, webhook_secret_encrypted)
     values ($1,$2,'waha','fdm-waha','WORKING','\\x00'::bytea)
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Quanto custa uma consulta?','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  // Cada arquivo semeia o que usa: o turno precisa de um playbook de plataforma.
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(async () => {
  enviados = [];
  logs = [];
  chamadasAoModelo = 0;
  await pool.query(
    `update contacts set force_human = false, is_blocked = false where organization_id = $1 and id = $2`,
    [ORG, CONTACT],
  );
  await pool.query(
    `update conversations set status = 'ai_handling', bot_silenced_until = null
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  for (const tabela of ["outbound_copies", "pacing_ledger"]) {
    await pool.query(`delete from ${tabela} where organization_id = $1 and channel_session_id = $2`, [
      ORG,
      SESSION,
    ]);
  }
  await pool.query(`delete from agent_inbox_items where ref_id = $1`, [CONTACT]);
  await pool.query(`delete from cron_jobs where organization_id = $1 and contact_id = $2`, [ORG, CONTACT]);
  await pool.query(
    `delete from messages where organization_id = $1 and conversation_id = $2 and direction = 'outbound'`,
    [ORG, CONV],
  );
});

const RESPOSTA = "Os valores variam conforme o procedimento.";

describe("falha do modelo depois de o turno já ter falado com o paciente", () => {
  it("mensagem entregue e o provider falha no passo seguinte: o turno conclui e não volta à fila", async () => {
    const envio = { toolName: "send_message", input: { body: RESPOSTA } };
    const { erro, status } = await rodaTurno(montaHandler(modeloQueFalhaDepois([[envio]])));

    expect(erro).toBeNull();
    expect(status).toBe("done");
    expect(enviados).toEqual([RESPOSTA]);
    expect(logs).toContain("modelo falhou depois de o turno já ter falado com o paciente — turno concluído sem refazer");
    // O checkpoint não é pedido: a fita do run se perdeu com a falha. O próximo turno lê o anterior.
    expect(logs).toContain("checkpoint descartado — turno concluído com a memória do checkpoint anterior");
    expect(chamadasAoModelo).toBe(2);
    expect(await forceHuman()).toBe(false);
    // A resposta pode ter ficado pela metade: a equipe é avisada na Central.
    expect(await avisosNaCentral()).toEqual(["Atendimento do assistente interrompido"]);
  });

  it("transferiu com aviso e o provider falha depois: o turno conclui e a conversa segue com a equipe", async () => {
    const envio = { toolName: "send_message", input: { body: "Vou passar sua conversa para a nossa equipe." } };
    const handoff = { toolName: "request_human_handoff", input: { reason: "pediu_humano" } };
    const { erro, status } = await rodaTurno(montaHandler(modeloQueFalhaDepois([[envio], [handoff]])));

    expect(erro).toBeNull();
    expect(status).toBe("done");
    expect(enviados).toHaveLength(1);
    expect(await forceHuman()).toBe(true);
    // Transferido, a equipe já tem a conversa: o aviso é o da transferência, não o de interrupção.
    expect(await avisosNaCentral()).not.toContain("Atendimento do assistente interrompido");
  });

  it("nada chegou ao paciente: a falha volta à fila, senão o paciente fica sem resposta", async () => {
    const { erro, status } = await rodaTurno(montaHandler(modeloQueFalhaDepois([])));

    expect(erro?.message).toContain(RESPOSTA_VAZIA);
    expect(status).toBe("pending");
    expect(enviados).toEqual([]);
    expect(await avisosNaCentral()).toEqual([]);
  });
});
