import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * Corrida entre `send_message` e `request_human_handoff` no MESMO passo do modelo.
 *
 * ─── Hipótese em teste (teste real em produção, 23/10: "Pode sim") ──────────
 * O modelo chama as duas tools no mesmo passo. O SDK as executa em paralelo.
 * `send_message` marca `avisoAoPaciente.tentou = true` no INÍCIO (inbound-turn.ts),
 * antes de passar pelos gates; o handoff lê `tentou === true`, passa na regra
 * "avise antes" e liga `contacts.force_human`; quando o envio chega ao gate `stop`
 * (before-send.ts, `readStopFlags`), o banco já diz `force_human = true` e o gate
 * veta com `contato_bloqueado`. O paciente fica sem a mensagem de transferência.
 *
 * ─── O que este arquivo afirma ──────────────────────────────────────────────
 * O comportamento CORRETO: a mensagem é entregue ao paciente e só depois o handoff
 * silencia o bot. Se a hipótese for verdadeira, o 1º caso REPROVA (é de propósito:
 * este arquivo documenta o defeito, não o corrige). O 2º caso é o controle — o mesmo
 * par de tools em passos SEPARADOS (envia, espera o resultado, transfere) — e prova
 * que o gate e o canal fakes não são a causa.
 *
 * ─── Por que há latência injetada ───────────────────────────────────────────
 * Contra o Postgres efêmero local (RTT ≈ 0) o envio ganha a corrida por poucos
 * milissegundos e o defeito NÃO aparece — medido: passa com 0 ms e com 3 ms por consulta.
 * Produção fala com o Supabase em nuvem (dezenas de ms por consulta). O pool entregue ao
 * turno é embrulhado para somar `RTT_MS` a cada consulta/conexão, nos DOIS lados da
 * corrida: o handoff faz 1 consulta até gravar `force_human`; o envio faz connect, begin,
 * lock, provider e só então `readStopFlags`.
 *
 * Seams: modelo falso (`createFakeRegistry`, nenhuma chamada real), canal que captura
 * em vez de enviar, Postgres efêmero do `pnpm test:db`. Nada de produção.
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

const ORG = "7a1e0c5d-0000-4000-8000-000000000001";
const CONTACT = "7a1e0c5d-0000-4000-8000-000000000002";
const SESSION = "7a1e0c5d-0000-4000-8000-000000000003";
const CONV = "7a1e0c5d-0000-4000-8000-000000000004";
const MSG = "7a1e0c5d-0000-4000-8000-000000000005";
const EVENTO = "7a1e0c5d-0000-4000-8000-000000000006";

/** RTT simulado por consulta/conexão — ver o cabeçalho. Uniforme: não favorece nenhum lado. */
let rttMs = 25;
const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ordem em que as consultas que decidem a corrida chegaram ao banco (diagnóstico). */
let ordemDasConsultas: string[] = [];
let t0 = 0;
function rotulo(sql: string): string | null {
  if (/update contacts set force_human/.test(sql)) return "handoff: update contacts.force_human";
  if (/is_blocked or force_human/.test(sql)) return "envio: readStopFlags (gate stop)";
  if (/pg_advisory_xact_lock/.test(sql)) return "envio: advisory lock";
  if (/^\s*begin/i.test(sql)) return "envio: begin";
  return null;
}

type Consulta = (...args: unknown[]) => Promise<unknown>;
function comLatencia(consulta: Consulta): Consulta {
  return async (...args) => {
    const sql = typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
    await dorme(rttMs);
    const r = rotulo(sql);
    if (r) ordemDasConsultas.push(`${String(Date.now() - t0).padStart(5)}ms ${r}`);
    return consulta(...args);
  };
}

function poolComLatencia(p: pg.Pool): pg.Pool {
  return new Proxy(p, {
    get(alvo, chave) {
      if (chave === "query") return comLatencia(alvo.query.bind(alvo) as Consulta);
      if (chave === "connect") {
        return async () => {
          await dorme(rttMs);
          const cliente = await alvo.connect();
          return new Proxy(cliente, {
            get(c, k) {
              if (k === "query") return comLatencia(c.query.bind(c) as Consulta);
              const v = (c as never)[k];
              return typeof v === "function" ? (v as Consulta).bind(c) : v;
            },
          });
        };
      }
      const v = (alvo as never)[chave];
      return typeof v === "function" ? (v as Consulta).bind(alvo) : v;
    },
  });
}

const AVISO = "vou te passar para eles";

interface EnvioCapturado {
  body: string;
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: EnvioCapturado[] = [];
/** Cada resultado de tool que o modelo VIU, em ordem — é onde o veto aparece. */
let resultadosDeTool: Array<{ id: string; toolName: string; output: unknown }> = [];

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

/**
 * Modelo fake que emite `passos[i]` (um conjunto de tool calls) na i-ésima chamada e, esgotados
 * os passos, devolve o checkpoint. Várias calls no MESMO passo = o SDK as executa em paralelo,
 * que é exatamente o cenário da produção.
 */
function modeloComPassos(passos: Chamada[][]) {
  let n = 0;
  return async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    const vistos: typeof resultadosDeTool = [...resultadosDeTool];
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result" && !vistos.some((v) => v.id === parte.toolCallId)) {
          vistos.push({ id: String(parte.toolCallId), toolName: String(parte.toolName), output: parte.output ?? parte });
        }
      }
    }
    resultadosDeTool = vistos;

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

interface OpcoesDoHandler {
  /** instante do turno; fora das 7h–22h o gate pacing veta o envio */
  clock?: Date;
  /** substitui o envio ao canal (ex.: um envio que trava) */
  enviar?: (i: EnvioCapturado) => Promise<unknown>;
  /** tempo máximo da espera do handoff pelo envio (ms) */
  esperaEnvioNoHandoffMs?: number;
}

function montaHandler(doGenerate: unknown, opcoes: OpcoesDoHandler = {}) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 4,
      queuedRetryDelayMs: 1000,
      ...(opcoes.esperaEnvioNoHandoffMs !== undefined
        ? { esperaEnvioNoHandoffMs: opcoes.esperaEnvioNoHandoffMs }
        : {}),
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
        send: async (i: EnvioCapturado) => {
          if (opcoes.enviar) return opcoes.enviar(i);
          enviados.push(i);
          return { kind: "sent" as const, idempotencyKey: "k", messageId: "m1" };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Dentro da janela horária do anti-ban.
    clock: () => opcoes.clock ?? new Date("2026-07-30T15:00:00Z"),
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
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "hoc", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, poolComLatencia(pool), { workerId: "hoc" });
    await m.queue.completeJob(pool, claimed!.id, "hoc");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "hoc", err);
    return err as Error;
  }
}

async function estadoDoContato() {
  const { rows } = await pool.query<{ force_human: boolean; silenciado: boolean }>(
    `select c.force_human,
            exists (select 1 from conversations v
                     where v.organization_id = c.organization_id and v.contact_id = c.id
                       and v.bot_silenced_until is not null and v.bot_silenced_until > now()) as silenciado
       from contacts c where c.organization_id = $1 and c.id = $2`,
    [ORG, CONTACT],
  );
  return rows[0]!;
}

async function vetosGravados() {
  const { rows } = await pool.query<{ vetoed_gate: string; vetoed_code: string }>(
    `select vetoed_gate, vetoed_code from before_send_traces
      where organization_id = $1 and contact_id = $2 and vetoed_code is not null`,
    [ORG, CONTACT],
  );
  return rows;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'handoff-envio-corrida','Handoff Envio Corrida','Handoff Envio Corrida')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Paciente Corrida','+5511900000888') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name,
                                   status, webhook_secret_encrypted)
     values ($1,$2,'waha','hoc-waha','WORKING','\\x00'::bytea)
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Pode sim','external_device', now())
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
});

beforeEach(async () => {
  ordemDasConsultas = [];
  t0 = Date.now();
  enviados = [];
  resultadosDeTool = [];
  // Cada caso começa como um paciente ainda atendido pelo bot.
  await pool.query(`update contacts set force_human = false where organization_id = $1 and id = $2`, [
    ORG,
    CONTACT,
  ]);
  await pool.query(
    `update conversations set status = 'ai_handling', bot_silenced_until = null
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  // O mesmo texto em vários casos no mesmo número aciona o gate spinning (mass_identical) e o
  // cap de warm-up do pacing — vetos que não são os deste arquivo. Cada caso começa limpo.
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
  await pool.query(`delete from agent_inbox_items where organization_id = $1 and ref_id = $2`, [ORG, CONTACT]);
});

const HANDOFF = { toolName: "request_human_handoff", input: { reason: "pediu_humano" } };
const ENVIO = { toolName: "send_message", input: { body: AVISO } };

async function esperaForceHumanLigado(ate = 5000): Promise<number> {
  const ini = Date.now();
  while (Date.now() - ini < ate) {
    if ((await estadoDoContato()).force_human) return Date.now() - ini;
    await dorme(10);
  }
  throw new Error("force_human nunca ligou");
}

describe.each([0, 3, 25, 40, 100])("send_message + request_human_handoff no MESMO passo — %i ms por consulta", (rtt) => {
  beforeEach(() => {
    rttMs = rtt;
  });

  it("a mensagem de transferência CHEGA ao paciente e só depois o bot é silenciado", async () => {
    const erro = await rodaTurno(montaHandler(modeloComPassos([[ENVIO, HANDOFF]])));
    expect(erro).toBeNull();

    // Diagnóstico: o que o modelo viu de cada tool e o que o gate gravou.
    const vetos = await vetosGravados();
    const diag = JSON.stringify({ ordemDasConsultas, resultadosDeTool, vetos }, null, 2);

    // O handoff aconteceu (a transferência não pode se perder) …
    const estado = await estadoDoContato();
    expect(estado.force_human, `handoff não aplicado\n${diag}`).toBe(true);
    expect(estado.silenciado, `conversa não silenciada\n${diag}`).toBe(true);

    // … e a mensagem saiu ANTES dele.
    expect(
      enviados.map((e) => e.body),
      `o aviso ao paciente foi barrado\n${diag}`,
    ).toEqual([AVISO]);
  });
});

describe("a espera do handoff pelo envio — bordas", () => {
  beforeEach(() => {
    rttMs = 25;
  });

  it("controle — as mesmas tools em passos SEPARADOS: o aviso chega e o bot é silenciado", async () => {
    const erro = await rodaTurno(montaHandler(modeloComPassos([[ENVIO], [HANDOFF]])));
    expect(erro).toBeNull();

    const diag = JSON.stringify({ ordemDasConsultas, resultadosDeTool, vetos: await vetosGravados() }, null, 2);
    expect(enviados.map((e) => e.body), diag).toEqual([AVISO]);

    const estado = await estadoDoContato();
    expect(estado.force_human, diag).toBe(true);
    expect(estado.silenciado, diag).toBe(true);
  });

  it("envio vetado por OUTRO gate (pacing, 02h BRT): o handoff acontece mesmo assim", async () => {
    const erro = await rodaTurno(
      montaHandler(modeloComPassos([[ENVIO, HANDOFF]]), { clock: new Date("2026-07-30T05:00:00Z") }),
    );
    expect(erro).toBeNull();

    const diag = JSON.stringify({ ordemDasConsultas, resultadosDeTool, vetos: await vetosGravados() }, null, 2);
    // Nada saiu — e o veto foi o do pacing, não o do stop (a espera não mascara nem cria vetos).
    expect(enviados, diag).toHaveLength(0);
    const vetos = await vetosGravados();
    expect(vetos.map((v) => v.vetoed_gate), diag).toEqual(["pacing"]);

    // O handoff NÃO ficou preso pelo envio que falhou.
    const estado = await estadoDoContato();
    expect(estado.force_human, diag).toBe(true);
    expect(estado.silenciado, diag).toBe(true);
  });

  it("envio que TRAVA: o handoff acontece após o tempo máximo, sem esperar o envio", async () => {
    const ESPERA = 600;
    let liberaEnvio!: () => void;
    const travado = new Promise<void>((r) => {
      liberaEnvio = r;
    });
    // Estado de force_human no instante em que o envio chegou ao canal (e travou).
    let forceHumanAoChegarNoCanal: boolean | null = null;
    let chegouNoCanalEm = 0;
    const handler = montaHandler(modeloComPassos([[ENVIO, HANDOFF]]), {
      esperaEnvioNoHandoffMs: ESPERA,
      // O canal só responde quando o teste manda: o turno não fecha até lá, então o
      // handoff precisa gravar force_human ENQUANTO o envio ainda está pendente.
      enviar: async (i) => {
        forceHumanAoChegarNoCanal = (await estadoDoContato()).force_human;
        chegouNoCanalEm = Date.now();
        await travado;
        enviados.push(i);
        return { kind: "sent" as const, idempotencyKey: "k", messageId: "m1" };
      },
    });

    const turno = rodaTurno(handler);
    await esperaForceHumanLigado();
    const ligouDepoisDoEnvio = Date.now() - chegouNoCanalEm;

    // O handoff estava SEGURADO enquanto o envio ainda não tinha chegado ao canal …
    expect(forceHumanAoChegarNoCanal).toBe(false);
    // … e foi liberado pelo tempo máximo, não pelo envio (que segue travado).
    expect(enviados).toHaveLength(0);
    expect(ligouDepoisDoEnvio).toBeLessThan(ESPERA + 3000);

    liberaEnvio();
    expect(await turno).toBeNull();
  });
});

describe("handoff SEM envio em andamento continua imediato", () => {
  beforeEach(() => {
    rttMs = 0;
  });

  it("a 2ª chamada (depois da recusa 'avise antes') não espera nada", async () => {
    // Sem send_message no turno: a 1ª chamada é recusada, a 2ª passa. Se a espera valesse
    // o tempo máximo, o turno levaria ESPERA ms a mais.
    const ESPERA = 4000;
    const ini = Date.now();
    const erro = await rodaTurno(
      montaHandler(modeloComPassos([[HANDOFF], [HANDOFF]]), { esperaEnvioNoHandoffMs: ESPERA }),
    );
    expect(erro).toBeNull();
    expect(Date.now() - ini).toBeLessThan(ESPERA);

    const estado = await estadoDoContato();
    expect(estado.force_human).toBe(true);
    expect(estado.silenciado).toBe(true);
  });
});
