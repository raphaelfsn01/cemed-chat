import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as MedicalEmergency from "@/lib/agent-engine/agent/medical-emergency";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * Detector de EMERGÊNCIA MÉDICA (spec da clínica §10.1) no turno REAL, com agente
 * publicado no Postgres (M7 da auditoria: "o detector de emergência está desligado").
 *
 * Decisão de 15/11/2026 (Raphael): o detector vem LIGADO por padrão; só desliga com
 * `ai_agents.config.medical_emergency_gate.enabled = false`. Até aqui nenhum teste
 * passava pelo caminho do turno com o detector ligado — só o detector isolado
 * (`tests/unit/emergencia-medica-detector.test.ts`).
 *
 * Só o modelo e o canal são dublês. O modelo aqui FALHA se for chamado: emergência
 * responde sem modelo.
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

const ORG = "e3e3aaaa-0000-4000-8000-000000000001";
const CONTACT = "e3e3aaaa-0000-4000-8000-000000000002";
const SESSION = "e3e3aaaa-0000-4000-8000-000000000003";
const CONV = "e3e3aaaa-0000-4000-8000-000000000004";
const MSG = "e3e3aaaa-0000-4000-8000-000000000005";
const EVENTO = "e3e3aaaa-0000-4000-8000-000000000006";
const AGENTE = "e3e3aaaa-0000-4000-8000-000000000007";
const VERSAO = "e3e3aaaa-0000-4000-8000-000000000008";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  runAgentTurn: typeof InboundTurn.runAgentTurn;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  emergency: typeof MedicalEmergency;
};
let m: Modules;

let enviados: string[] = [];
let modeloChamado = 0;

/** Dentro da janela horária (12h BRT): a emergência fura a janela, mas aqui isso não está em jogo. */
const AGORA = new Date("2026-07-30T15:00:00Z");

/**
 * O turno com agente publicado tenta garantir o card do funil pelo supabase-js. Aqui não
 * há CRM REST: o dublê devolve erro, como numa queda, e o turno segue (falha ali nunca
 * derruba o turno — ver `garanteNegocioDoContato`).
 */
function supabaseFora(): never {
  const consulta: Record<string, unknown> = {};
  consulta.select = () => consulta;
  consulta.eq = () => consulta;
  consulta.then = (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "sem CRM no teste" } });
  return { from: () => consulta } as never;
}

function deps(): Parameters<typeof InboundTurn.createInboundTurnHandler>[0] {
  return {
    crmCfg: { supabase: supabaseFora() },
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
    registry: m.createFakeRegistry((async () => {
      modeloChamado += 1;
      return {
        content: [{ type: "text" as const, text: '{"commitments":[],"objections":[],"next_action":null,"rolling_summary":"x"}' }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    }) as never),
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
    clock: () => AGORA,
    sleep: async () => {},
  };
}

function montaHandler() {
  return m.createInboundTurnHandler(deps());
}

async function rodaTurno(mensagem: string): Promise<Error | null> {
  await pool.query(`update messages set body = $3 where organization_id = $1 and id = $2`, [ORG, MSG, mensagem]);
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
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "emg", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await montaHandler()(claimed!, pool, { workerId: "emg" });
    await m.queue.completeJob(pool, claimed!.id, "emg");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "emg", err);
    return err as Error;
  }
}

async function forceHuman(): Promise<boolean> {
  const { rows } = await pool.query<{ force_human: boolean }>(
    `select force_human from contacts where organization_id = $1 and id = $2`,
    [ORG, CONTACT],
  );
  return rows[0]!.force_human;
}

async function avisosDeHandoff(): Promise<Array<{ title: string; severity: string }>> {
  const { rows } = await pool.query<{ title: string; severity: string }>(
    `select title, severity from agent_inbox_items
      where organization_id = $1 and kind = 'handoff' and ref_id = $2 order by created_at`,
    [ORG, CONTACT],
  );
  return rows;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    runAgentTurn: (await import("@/lib/agent-engine/agent/inbound-turn")).runAgentTurn,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    emergency: await import("@/lib/agent-engine/agent/medical-emergency"),
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'emergencia-no-turno','Emergência no Turno','Emergência no Turno') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Paciente Fictício','+5511900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'waha','emg-waha','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
  // O turno exige a camada `platform` do playbook. Mesma semente idempotente de
  // `turno-sem-resposta.test.ts`: sem ela, este arquivo só passava se o outro rodasse antes.
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
  // Agente publicado nesta sessão, com `config` VAZIO: é o default que se prova.
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1,$2,'Agente da clínica','system') on conflict (id) do nothing`,
    [AGENTE, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
     values ($1,$2,$3,1,'system','anthropic','claude-sonnet-4-6',$4,'published')
     on conflict (id) do nothing`,
    [VERSAO, ORG, AGENTE, SESSION],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [VERSAO, AGENTE]);
});

beforeEach(async () => {
  enviados = [];
  modeloChamado = 0;
  await pool.query(`update ai_agents set config = '{}'::jsonb where id = $1`, [AGENTE]);
  await pool.query(`update contacts set force_human = false, is_blocked = false where organization_id = $1 and id = $2`, [
    ORG,
    CONTACT,
  ]);
  await pool.query(
    `update conversations set status = 'ai_handling', bot_silenced_until = null where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  await pool.query(`delete from agent_inbox_items where organization_id = $1 and ref_id = $2`, [ORG, CONTACT]);
  await pool.query(`delete from send_ledger where organization_id = $1 and contact_id = $2`, [ORG, CONTACT]);
});

afterAll(async () => {
  await pool.end();
});

describe("emergência médica no turno real — ligada por padrão", () => {
  it("config do agente sem a chave → dor no peito recebe a orientação do SAMU, sem modelo, e vai para a equipe", async () => {
    const erro = await rodaTurno("Estou com uma dor no peito muito forte agora");
    expect(erro).toBeNull();
    expect(enviados).toEqual([m.emergency.EMERGENCY_MESSAGES.clinical]);
    expect(enviados[0]).toContain("Ligue 192 (SAMU)");
    expect(modeloChamado).toBe(0);
    expect(await forceHuman()).toBe(true);
    const avisos = await avisosDeHandoff();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.title).toContain("EMERGÊNCIA MÉDICA");
  });

  it("autolesão → a orientação leva o CVV 188", async () => {
    const erro = await rodaTurno("não aguento mais viver, penso em me matar");
    expect(erro).toBeNull();
    expect(enviados).toEqual([m.emergency.EMERGENCY_MESSAGES.self_harm]);
    expect(enviados[0]).toContain("CVV no 188");
  });

  it("relato de terceiro no passado não dispara: o turno segue para o modelo", async () => {
    const erro = await rodaTurno("Meu pai teve um AVC ano passado, quero marcar neurologista");
    expect(erro).toBeNull();
    expect(enviados).toEqual([]);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(await forceHuman()).toBe(false);
  });

  it("desligado de propósito (enabled = false) → nada da orientação; o turno segue para o modelo", async () => {
    await pool.query(
      `update ai_agents set config = '{"medical_emergency_gate":{"enabled":false}}'::jsonb where id = $1`,
      [AGENTE],
    );
    const erro = await rodaTurno("Estou com uma dor no peito muito forte agora");
    expect(erro).toBeNull();
    expect(enviados).toEqual([]);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(await forceHuman()).toBe(false);
  });

  it("follow-up depois da devolução NÃO repete a orientação: a última entrada antiga não é emergência nova", async () => {
    // Revisão do M7: a equipe devolve a conversa, o follow-up roda e a ÚLTIMA mensagem
    // recebida ainda é o relato antigo de dor no peito. Só um turno de ENTRADA responde
    // a emergência; o follow-up segue para o modelo.
    await pool.query(`update messages set body = $3 where organization_id = $1 and id = $2`, [
      ORG,
      MSG,
      "Estou com uma dor no peito muito forte agora",
    ]);
    await pool.query("update job_queue set status = 'done' where status = 'pending'");
    const { job } = await m.queue.enqueueJob(pool, ORG, {
      kind: "followup_turn",
      leadId: CONTACT,
      payload: { conversation_id: CONV, contact_id: CONTACT, reason: "retomada" },
      maxAttempts: 1,
    });
    const [claimed] = await m.queue.claimJobs(pool, { workerId: "emg", maxConcurrency: 1 });
    expect(claimed?.id).toBe(job.id);
    await m.runAgentTurn(deps(), claimed!, pool, { workerId: "emg" }, {
      channelSessionId: SESSION,
      conversationId: CONV,
      buildOpening: () => "retomada da conversa",
    });
    await m.queue.completeJob(pool, claimed!.id, "emg");
    expect(enviados).toEqual([]);
    expect(modeloChamado).toBeGreaterThan(0);
    expect(await forceHuman()).toBe(false);
  });
});
