import fs from "node:fs";
import path from "node:path";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  CODIGOS_DE_VETO_DE_QUALIDADE,
  mensagemDeReescrita,
} from "@/lib/agent-engine/agent/human-handoff";
import {
  BEFORE_SEND_GATES,
  clinicalLimitsGate,
  runBeforeSend,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { vetoReason } from "@/lib/leads/veto-activity";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * O GATE de limites clínicos (M7 da auditoria): preço e orientação médica na fala do
 * agente. A calibração do detector está em `limites-clinicos-detector.test.ts`; aqui, a
 * decisão do gate, a propagação pela cadeia real e a fiação nos pontos de envio.
 */
function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-08-04T12:00:00Z"),
    body: "",
    optedOut: false,
    handoffActive: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

const PRECO = "A consulta custa R$ 250,00.";
const ORIENTACAO = "Provavelmente é uma virose, tome uma dipirona.";

describe("clinicalLimitsGate — decisão", () => {
  it("armado: preço vira veto price_disclosed, com a saída da spec (§4.3) na razão", () => {
    const v = clinicalLimitsGate.evaluate(baseCtx({ clinicalLimitsEnforced: true, body: PRECO }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("price_disclosed");
    expect(v.reason).toContain("Os valores variam conforme o procedimento");
    expect(v.detail).toEqual({ clinical_kinds: "preco", clinical_rules: "moeda,valor_numero" });
  });

  it("armado: orientação médica vira veto medical_advice, com a saída da spec (§8.3) na razão", () => {
    const v = clinicalLimitsGate.evaluate(baseCtx({ clinicalLimitsEnforced: true, body: ORIENTACAO }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("medical_advice");
    expect(v.reason).toContain("só o profissional pode fazer");
    expect(v.detail).toEqual({ clinical_kinds: "orientacao_medica", clinical_rules: "diagnostico,remedio" });
  });

  it("a razão devolvida ao modelo não repete o texto vetado", () => {
    const v = clinicalLimitsGate.evaluate(baseCtx({ clinicalLimitsEnforced: true, body: ORIENTACAO }));
    if (v.pass) throw new Error("inalcançável");
    expect(v.reason).not.toMatch(/virose|dipirona/i);
  });

  it("armado + fala legítima: passa", () => {
    const v = clinicalLimitsGate.evaluate(
      baseCtx({ clinicalLimitsEnforced: true, body: "Atendemos de segunda a sexta, das 8h às 17h." }),
    );
    expect(v.pass).toBe(true);
  });

  it("DESARMADO (campo ausente): no-op — follow-up e template não têm modelo para reescrever", () => {
    expect(clinicalLimitsGate.evaluate(baseCtx({ body: PRECO })).pass).toBe(true);
  });

  it("está na cadeia, entre semantic_promise e case_promise", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("clinical_limits")).toBe(nomes.indexOf("semantic_promise") + 1);
    expect(nomes.indexOf("case_promise")).toBe(nomes.indexOf("clinical_limits") + 1);
  });
});

describe("os vetos clínicos seguem o caminho da qualidade: reescrever uma vez, depois o aviso fixo", () => {
  it("price_disclosed e medical_advice contam como veto de qualidade", () => {
    expect(CODIGOS_DE_VETO_DE_QUALIDADE.has("price_disclosed")).toBe(true);
    expect(CODIGOS_DE_VETO_DE_QUALIDADE.has("medical_advice")).toBe(true);
  });

  it("a instrução de reescrita fala do limite certo, não de promessa", () => {
    expect(mensagemDeReescrita("m", "price_disclosed")).toContain("Reescreva UMA vez, sem nenhum valor");
    expect(mensagemDeReescrita("m", "medical_advice")).toContain(
      "Reescreva UMA vez, sem diagnóstico, remédio ou conduta",
    );
    expect(mensagemDeReescrita("m", "price_disclosed")).not.toContain("promessa");
    // sem código: o texto de promessa de antes, para quem já o chamava assim
    expect(mensagemDeReescrita("m")).toContain("Reescreva UMA vez, sem prometer nada");
  });
});

/** Cadeia REAL (sem `gates:` injetado), no molde de `gate-vazamento-interno.test.ts`. */
const COMERCIAL = new Date("2026-07-28T13:00:00Z"); // 10h BRT, terça — dentro da janela

function chamaCadeiaReal(args: { body: string; armado: boolean }) {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const inserts = vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] });
  const pool = { connect: vi.fn().mockResolvedValue(client), query: inserts } as unknown as pg.Pool;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const send = vi.fn().mockResolvedValue({ kind: "sent", idempotencyKey: "k", messageId: "m" });
  return {
    send,
    run: runBeforeSend({
      pool,
      log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: args.body,
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: COMERCIAL,
      rng: () => 0,
      sleep: async () => {},
      ...(args.armado ? { enforceClinicalLimits: true } : {}),
      send,
    }),
  };
}

describe("a cadeia REAL barra preço — e só quando armada", () => {
  it("armada: veta no gate certo, nada vai ao canal, e o trace leva só rótulos e tamanho", async () => {
    const { run, send } = chamaCadeiaReal({ body: PRECO, armado: true });
    const r = await run;
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.gate).toBe("clinical_limits");
    expect(r.code).toBe("price_disclosed");
    expect(send).not.toHaveBeenCalled();
    expect(r.trace).toContainEqual({
      gate: "clinical_limits",
      verdict: "veto",
      code: "price_disclosed",
      detail: { clinical_kinds: "preco", clinical_rules: "moeda,valor_numero", body_len: PRECO.length },
    });
  });

  it("DESARMADA: o MESMO corpo sai — o flag é o que decide, e ele chega ao gate", async () => {
    const { run, send } = chamaCadeiaReal({ body: PRECO, armado: false });
    const r = await run;
    expect(r.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.trace).toContainEqual({ gate: "clinical_limits", verdict: "pass" });
  });
});

/**
 * FIAÇÃO, nos dois sentidos (asserção sobre a fonte, como em `gate-vazamento-interno`).
 * Armado onde há modelo para reescrever; desarmado onde o texto é fixo ou de humano.
 */
const FONTE_INBOUND = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
const FONTE_FOLLOWUP = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/followup-turn.ts"), "utf8");

function trecho(ancora: string, fim: string): string {
  const i = FONTE_INBOUND.indexOf(ancora);
  expect(i, `âncora \`${ancora}\` sumiu do turno`).toBeGreaterThan(-1);
  const j = FONTE_INBOUND.indexOf(fim, i);
  expect(j, `âncora de fim \`${fim}\` sumiu`).toBeGreaterThan(i);
  return FONTE_INBOUND.slice(i, j);
}

describe("fiação do gate de limites clínicos", () => {
  it("send_message ARMA o gate", () => {
    expect(trecho("send_message: tool({", "update_lead_state: tool({")).toMatch(/enforceClinicalLimits:\s*true/);
  });

  it("o aviso fixo do código DESARMA — o texto é nosso e não pode ser vetado pelo gate que o causou", () => {
    const corpo = trecho("const enviarFallbackDoVeto = async () => {", "return { fallback, entregue };");
    expect(corpo).toMatch(/enforceClinicalLimits:\s*false/);
  });

  it("send_template, a orientação de emergência e o follow-up NÃO armam", () => {
    expect(trecho("send_template: tool({", "search_knowledge: tool({")).not.toMatch(/enforceClinicalLimits/);
    expect(trecho("// EMERGÊNCIA MÉDICA (spec da clínica §10.1)", "return; // não retoma")).not.toMatch(
      /enforceClinicalLimits/,
    );
    expect(FONTE_FOLLOWUP).not.toMatch(/enforceClinicalLimits/);
  });
});

describe("linha do tempo do contato — a equipe lê o motivo, não o nome do gate", () => {
  it("preço e orientação médica têm texto próprio", () => {
    expect(vetoReason("clinical_limits", "price_disclosed")).toBe(
      "Não enviei: a mensagem informava preço, e quem informa valores é a equipe",
    );
    expect(vetoReason("clinical_limits", "medical_advice")).toBe(
      "Não enviei: a mensagem dava orientação médica, que só o profissional pode dar",
    );
  });
});
