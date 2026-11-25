import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as TurnNoReply from "@/lib/agent-engine/agent/turn-no-reply";
import type * as Scheduler from "@/lib/agent-engine/cron/scheduler";

/**
 * PR-1b: transferência para a equipe sem NENHUMA mensagem ao paciente.
 *
 * Caso real (15/11/2026 13h13 BRT, domingo): "estou com dor no peito e falta de ar"; a
 * resposta do modelo foi barrada pela janela de envio, o modelo pediu a transferência e o
 * runtime a concluiu — zero mensagens, conversa com a equipe. O mesmo acontecia, em qualquer
 * horário, quando o paciente pedia atendente ("quero falar com um atendente"): o sistema
 * transferia sem responder nada.
 *
 * Decisão do Raphael (15/11): fora da janela, transfere NA HORA (a equipe é avisada) e o
 * paciente recebe um aviso fixo na abertura da janela — só se ninguém da equipe tiver
 * respondido antes. Dentro da janela, o aviso sai antes da transferência.
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

const ORG = "a7a7aaaa-0000-4000-8000-000000000001";
const CONTACT = "a7a7aaaa-0000-4000-8000-000000000002";
const SESSION = "a7a7aaaa-0000-4000-8000-000000000003";
const CONV = "a7a7aaaa-0000-4000-8000-000000000004";
const MSG = "a7a7aaaa-0000-4000-8000-000000000005";
const EVENTO = "a7a7aaaa-0000-4000-8000-000000000006";
const VERSAO_TABELA = "a7a7aaaa-0000-4000-8000-000000000007";
const JOB_DE_ORIGEM = "a7a7aaaa-0000-4000-8000-000000000009";
/** Segundo contato, de OUTRA organização: o dedup não pode cruzar tenant. */
const ORG_B = "a7a7bbbb-0000-4000-8000-000000000001";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  turnNoReply: typeof TurnNoReply;
  scheduler: typeof Scheduler;
};
let m: Modules;

let enviados: string[] = [];
/** Mensagens de log do turno: os testes de dispensa afirmam o MOTIVO, não só o silêncio. */
let logs: string[] = [];
/** Desfecho que o canal falso devolve (o padrão é `sent`). */
let desfechoDoCanal: "sent" | "failed" = "sent";

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

/** Dentro da janela horária do anti-ban (12h BRT). */
const DENTRO_DA_JANELA = new Date("2026-07-30T15:00:00Z");
/** Quinta, 05h BRT: fora da janela 7h–22h. */
const FORA_DA_JANELA = new Date("2026-07-30T08:00:00Z");

function montaHandler(doGenerate: unknown, agora: Date = DENTRO_DA_JANELA) {
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
    log: { info: registra, warn: registra, error: registra },
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          if (desfechoDoCanal === "failed") return { kind: "failed" as const, reason: "canal_falso" };
          enviados.push(i.body);
          return { kind: "sent" as const, idempotencyKey: "k", messageId: "m1" };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => agora,
    sleep: async () => {},
  });
}

async function rodaTurno(
  handler: ReturnType<typeof montaHandler>,
  extraPayload: Record<string, unknown> = {},
): Promise<Error | null> {
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
      ...extraPayload,
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "adt", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "adt" });
    await m.queue.completeJob(pool, claimed!.id, "adt");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "adt", err);
    return err as Error;
  }
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    turnNoReply: await import("@/lib/agent-engine/agent/turn-no-reply"),
    scheduler: await import("@/lib/agent-engine/cron/scheduler"),
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'aviso-de-transferencia','Aviso de Transferência','Aviso de Transferência'),
            ($2,'aviso-de-transferencia-b','Aviso de Transferência B','Aviso de Transferência B')
     on conflict (id) do nothing`,
    [ORG, ORG_B],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Paciente Fictício','+5511900000128') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name,
                                   status, webhook_secret_encrypted)
     values ($1,$2,'waha','adt-waha','WORKING','\\x00'::bytea)
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
  logs = [];
  desfechoDoCanal = "sent";
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
  await pool.query(`delete from cron_jobs where organization_id = $1 and contact_id = $2`, [ORG, CONTACT]);
  await pool.query(
    `delete from messages where organization_id = $1 and conversation_id = $2 and direction = 'outbound'`,
    [ORG, CONV],
  );
});


interface CronAgendado {
  job_kind: string;
  enabled: boolean;
  next_run_at: Date;
  payload: Record<string, unknown>;
}

async function cronsDoContato(): Promise<CronAgendado[]> {
  const { rows } = await pool.query<CronAgendado>(
    `select job_kind, enabled, next_run_at, payload from cron_jobs
      where organization_id = $1 and contact_id = $2 order by created_at`,
    [ORG, CONTACT],
  );
  return rows;
}

async function forceHuman(): Promise<boolean> {
  const { rows } = await pool.query<{ force_human: boolean }>(
    `select force_human from contacts where organization_id = $1 and id = $2`,
    [ORG, CONTACT],
  );
  return rows[0]!.force_human;
}

async function mensagemDoPaciente(texto: string): Promise<void> {
  await pool.query(`update messages set body = $3 where organization_id = $1 and id = $2`, [ORG, MSG, texto]);
}

const PEDE_ATENDENTE = "Quero falar com um atendente";
const RESPOSTA = "Claro, me conta o que você precisa.";
const AVISO_NA_HORA = /^Entendi\. Vou passar sua conversa agora para uma pessoa da nossa equipe\./;
const AVISO_NA_ABERTURA = /^Recebemos sua mensagem e passamos sua conversa para a nossa equipe\./;
/** Quinta 05h BRT → a janela reabre às 07h BRT (10h UTC), com jitter para depois. */
const ABERTURA = new Date("2026-07-30T10:00:00Z");

beforeEach(async () => {
  await mensagemDoPaciente("Oi");
  await pool.query(`update messages set sent_at = now() where organization_id = $1 and id = $2`, [ORG, MSG]);
  await pool.query(`update conversations set status = 'ai_handling' where organization_id = $1 and id = $2`, [ORG, CONV]);
  await pool.query(
    `delete from messages where organization_id = $1 and conversation_id = $2 and direction = 'inbound' and id <> $3`,
    [ORG, CONV, MSG],
  );
});

/**
 * Revisão do PR-1b: os avisos são texto fixo, iguais para todo paciente, e o anti-repetição
 * (3ª cópia igual nas últimas 20 do número) os vetava — a transferência voltava a sair calada.
 * Semeia 2 cópias de cada variante dos dois avisos.
 */
async function semeiaCopiasDosAvisos(): Promise<void> {
  const { hashNormalized, normalizeCopy } = await import("@/lib/agent-engine/spinning/engine");
  const { mensagemDeFallbackDoVeto } = await import("@/lib/agent-engine/agent/human-handoff");
  const { mensagemDeTransferenciaFeita } = await import("@/lib/agent-engine/agent/aviso-de-transferencia");
  const textos = [
    mensagemDeFallbackDoVeto(null),
    mensagemDeFallbackDoVeto({ disponiveis: 1, total: 1 }),
    mensagemDeTransferenciaFeita(null),
    mensagemDeTransferenciaFeita({ disponiveis: 1, total: 1 }),
  ];
  for (const texto of textos) {
    const normalizado = normalizeCopy(texto);
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `insert into outbound_copies (organization_id, channel_session_id, normalized_text, normalized_hash)
         values ($1,$2,$3,$4)`,
        [ORG, SESSION, normalizado, hashNormalized(normalizado)],
      );
    }
  }
}

describe("transferência DENTRO da janela: o aviso sai antes", () => {
  it("paciente pede atendente → o aviso fixo sai e só então a conversa vai para a equipe", async () => {
    await mensagemDoPaciente(PEDE_ATENDENTE);
    expect(await rodaTurno(montaHandler(modeloComPassos([])))).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatch(AVISO_NA_HORA);
    expect(await forceHuman()).toBe(true);
    expect((await cronsDoContato()).filter((c) => "aviso_de_transferencia" in c.payload)).toEqual([]);
  });

  it("o aviso já saiu 2× no número hoje → o 3º pedido de atendente também recebe", async () => {
    await semeiaCopiasDosAvisos();
    await mensagemDoPaciente(PEDE_ATENDENTE);
    expect(await rodaTurno(montaHandler(modeloComPassos([])))).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatch(AVISO_NA_HORA);
  });

  it("pedido de atendente junto com opt-out ambíguo → transfere sem mandar nada", async () => {
    await mensagemDoPaciente("Quero falar com um atendente, para de me mandar mensagem");
    expect(await rodaTurno(montaHandler(modeloComPassos([])))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await forceHuman()).toBe(true);
  });

  it("modelo transfere sem ter mandado nada → o código manda o aviso fixo antes de concluir", async () => {
    const handoff = { toolName: "request_human_handoff", input: { reason: "pediu_humano" } };
    expect(await rodaTurno(montaHandler(modeloComPassos([[handoff]])))).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatch(AVISO_NA_HORA);
    expect(await forceHuman()).toBe(true);
  });
});

describe("transferência FORA da janela: transfere já, avisa na abertura", () => {
  it("paciente pede atendente às 5h → equipe avisada na hora, aviso agendado para a abertura", async () => {
    await mensagemDoPaciente(PEDE_ATENDENTE);
    expect(await rodaTurno(montaHandler(modeloComPassos([]), FORA_DA_JANELA))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await forceHuman()).toBe(true);
    const crons = await cronsDoContato();
    expect(crons).toHaveLength(1);
    expect(crons[0]).toMatchObject({ job_kind: "inbound_turn", enabled: true });
    expect(typeof crons[0]!.payload.aviso_de_transferencia).toBe("string");
    expect(crons[0]!.payload).toMatchObject({ conversation_id: CONV, channel_session_id: SESSION });
    expect(crons[0]!.payload).not.toHaveProperty("reschedule_of");
    expect(crons[0]!.next_run_at.getTime()).toBeGreaterThanOrEqual(ABERTURA.getTime());
  });

  it("caso de 15/11: resposta barrada, modelo transfere → transferência feita e UM aviso agendado (sem turno reagendado)", async () => {
    const envio = { toolName: "send_message", input: { body: RESPOSTA } };
    const handoff = { toolName: "request_human_handoff", input: { reason: "pediu_humano" } };
    expect(await rodaTurno(montaHandler(modeloComPassos([[envio], [handoff]]), FORA_DA_JANELA))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await forceHuman()).toBe(true);
    const crons = await cronsDoContato();
    expect(crons).toHaveLength(1);
    expect(typeof crons[0]!.payload.aviso_de_transferencia).toBe("string");
    expect(crons[0]!.next_run_at.getTime()).toBeGreaterThanOrEqual(ABERTURA.getTime());
  });

  // Desde 25/11 a falha do modelo depois da transferência não derruba mais o turno (ver
  // falha-do-modelo-depois-do-envio.test.ts): ele conclui sem voltar à fila. O que este
  // teste guarda continua valendo — a transferência e o aviso já agendado sobrevivem à falha.
  it("o modelo falha DEPOIS da transferência → o turno conclui e o aviso já ficou agendado", async () => {
    const envio = { toolName: "send_message", input: { body: RESPOSTA } };
    const handoff = { toolName: "request_human_handoff", input: { reason: "pediu_humano" } };
    const roteiro = modeloComPassos([[envio], [handoff], [handoff]]);
    let chamadas = 0;
    const modelo = async (...args: unknown[]) => {
      chamadas += 1;
      if (chamadas === 4) throw new Error("provedor de LLM fora");
      return (roteiro as (...a: unknown[]) => Promise<unknown>)(...args);
    };
    const erro = await rodaTurno(montaHandler(modelo, FORA_DA_JANELA));
    expect(chamadas).toBe(4);
    expect(erro).toBeNull();
    expect(await forceHuman()).toBe(true);
    const avisos = (await cronsDoContato()).filter((c) => "aviso_de_transferencia" in c.payload && c.enabled);
    expect(avisos).toHaveLength(1);
    expect(typeof avisos[0]!.payload.aviso_desde).toBe("string");
  });

  it("duas transferências na mesma noite → um só aviso por conversa", async () => {
    await mensagemDoPaciente(PEDE_ATENDENTE);
    expect(await rodaTurno(montaHandler(modeloComPassos([]), FORA_DA_JANELA))).toBeNull();
    await pool.query(`update contacts set force_human = false where organization_id = $1 and id = $2`, [ORG, CONTACT]);
    await pool.query(`update conversations set bot_silenced_until = null where organization_id = $1 and id = $2`, [
      ORG,
      CONV,
    ]);
    expect(await rodaTurno(montaHandler(modeloComPassos([]), FORA_DA_JANELA))).toBeNull();
    // A 2ª transferência cancela os agendamentos do contato (o 1º aviso fica desligado) e
    // agenda o seu: ativo, sempre UM.
    const avisos = (await cronsDoContato()).filter((c) => "aviso_de_transferencia" in c.payload);
    expect(avisos.filter((c) => c.enabled)).toHaveLength(1);
  });
});

describe("o aviso agendado, na abertura da janela", () => {
  const AVISO = { aviso_de_transferencia: JOB_DE_ORIGEM };

  async function transferido(): Promise<void> {
    await pool.query(`update contacts set force_human = true where organization_id = $1 and id = $2`, [ORG, CONTACT]);
  }

  it("contato com a equipe e ninguém respondeu → o aviso sai, sem chamar o modelo", async () => {
    await transferido();
    const erro = await rodaTurno(
      montaHandler(async () => {
        throw new Error("o aviso não pode chamar o modelo");
      }),
      AVISO,
    );
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatch(AVISO_NA_ABERTURA);
    expect(enviados[0]).not.toMatch(/\d/);
  });

  it("alguém da equipe já respondeu → o aviso é dispensado", async () => {
    await transferido();
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,'text','outbound','sent','Bom dia! Sou da equipe.','crm', now() + interval '1 minute')`,
      [ORG, CONV, SESSION, CONTACT],
    );
    expect(await rodaTurno(montaHandler(modeloComPassos([])), AVISO)).toBeNull();
    expect(enviados).toEqual([]);
    expect(logs).toContain("aviso de transferência dispensado: a equipe já respondeu");
  });

  it("contato pediu para sair (opt-out) → nada sai", async () => {
    await transferido();
    await pool.query(`update contacts set is_blocked = true where organization_id = $1 and id = $2`, [ORG, CONTACT]);
    expect(await rodaTurno(montaHandler(modeloComPassos([])), AVISO)).toBeNull();
    expect(enviados).toEqual([]);
    const { rows } = await pool.query<{ vetoed_code: string }>(
      `select vetoed_code from before_send_traces where organization_id = $1 and contact_id = $2`,
      [ORG, CONTACT],
    );
    expect(rows.map((r) => r.vetoed_code)).toEqual(["contato_bloqueado"]);
  });

  it("a equipe respondeu depois da transferência e o paciente respondeu depois dela → dispensado", async () => {
    // A última palavra é do paciente, mas o atendimento humano já está em andamento.
    await transferido();
    const desde = new Date(Date.now() - 60 * 60 * 1000);
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,'text','outbound','sent','Oi, sou da equipe.','crm', $5::timestamptz + interval '1 minute')`,
      [ORG, CONV, SESSION, CONTACT, desde.toISOString()],
    );
    await pool.query(`update messages set sent_at = $3::timestamptz + interval '2 minutes' where organization_id = $1 and id = $2`, [
      ORG,
      MSG,
      desde.toISOString(),
    ]);
    expect(
      await rodaTurno(montaHandler(modeloComPassos([])), { ...AVISO, aviso_desde: desde.toISOString() }),
    ).toBeNull();
    expect(enviados).toEqual([]);
    expect(logs).toContain("aviso de transferência dispensado: a equipe já respondeu");
  });

  it("conversa encerrada durante a noite → dispensado", async () => {
    await transferido();
    await pool.query(`update conversations set status = 'closed' where organization_id = $1 and id = $2`, [ORG, CONV]);
    expect(await rodaTurno(montaHandler(modeloComPassos([])), AVISO)).toBeNull();
    expect(enviados).toEqual([]);
    expect(logs).toContain("aviso de transferência dispensado: a conversa foi encerrada");
  });

  it("paciente escreveu um opt-out ambíguo depois da transferência → dispensado", async () => {
    await transferido();
    const desde = new Date(Date.now() - 60 * 60 * 1000);
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,'text','inbound','delivered','não quero mais receber mensagens','external_device', now())`,
      [ORG, CONV, SESSION, CONTACT],
    );
    expect(
      await rodaTurno(montaHandler(modeloComPassos([])), { ...AVISO, aviso_desde: desde.toISOString() }),
    ).toBeNull();
    expect(enviados).toEqual([]);
    expect(logs).toContain("aviso de transferência dispensado: o paciente pediu para não receber mensagens");
  });

  it("o canal falha ao enviar o aviso → o job falha para a fila tentar de novo", async () => {
    await transferido();
    desfechoDoCanal = "failed";
    const erro = await rodaTurno(montaHandler(modeloComPassos([])), AVISO);
    expect(erro).not.toBeNull();
  });

  it("o mesmo aviso já saiu 2× no número hoje → sai de novo (texto fixo não é disparo em massa)", async () => {
    await transferido();
    await semeiaCopiasDosAvisos();
    expect(await rodaTurno(montaHandler(modeloComPassos([])), AVISO)).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatch(AVISO_NA_ABERTURA);
  });

  it("a equipe devolveu ao automático antes da abertura → o aviso é descartado (e o modelo não roda)", async () => {
    // Revisão do PR-1b: deixar cair no turno normal respondia de novo uma mensagem velha, ou
    // re-transferia uma conversa que a equipe tinha acabado de devolver.
    const erro = await rodaTurno(
      montaHandler(async () => {
        throw new Error("o aviso descartado não pode chamar o modelo");
      }),
      AVISO,
    );
    expect(erro).toBeNull();
    expect(enviados).toEqual([]);
    expect(logs).toContain("aviso de transferência dispensado: a conversa voltou ao automático");
  });
});
