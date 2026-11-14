/**
 * A primeira resposta a um paciente que acabou de escrever não passa pelo anti-repetição.
 *
 * Caso real (14/11 15h03 BRT): a saudação padrão da clínica ("Olá! Que bom te ver por
 * aqui.") já tinha saído 2 vezes nas últimas 20 mensagens do número, e o gate `spinning`
 * vetou a 3ª. O paciente ficou sem saudação. Saudação é idêntica POR CONSTRUÇÃO e é
 * resposta 1:1 a quem escreveu — não é disparo em massa, que é o que o gate existe para
 * barrar.
 *
 * A exceção é estreita de propósito: só a 1ª saída ao contato, e só em resposta a
 * mensagem recebida. Follow-up, template e a 2ª mensagem em diante continuam sob o gate.
 */
import { describe, expect, it } from "vitest";

import { BEFORE_SEND_GATES, type Gate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { hashNormalized, normalizeCopy } from "@/lib/agent-engine/spinning/engine";

function gate(nome: string): Gate {
  const g = BEFORE_SEND_GATES.find((x) => x.name === nome);
  if (g === undefined) throw new Error(`gate '${nome}' saiu da cadeia — atualize este teste`);
  return g;
}

const SAUDACAO = "Olá! Que bom te ver por aqui.";
const normalizada = normalizeCopy(SAUDACAO);
const janelaCheia = Array.from({ length: SPINNING_DEFAULTS.repetitionThreshold }, () => ({
  normalizedText: normalizada,
  normalizedHash: hashNormalized(normalizada),
}));

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-11-14T18:00:00.000Z"),
    body: SAUDACAO,
    optedOut: false,
    handoffActive: false,
    provider: "waha",
    messagingWindow: { lastInboundAt: new Date("2026-11-14T17:59:00.000Z") },
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
      rng: () => 0,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: janelaCheia },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...over,
  };
}

describe("spinning × primeira resposta a quem escreveu", () => {
  it("guarda de vacuidade: sem a marca, a saudação repetida é vetada", () => {
    const v = gate("spinning").evaluate(ctx());
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe("mass_identical");
  });

  it("1ª resposta a inbound → passa, como 'skipped' (regra desarmada, não aprovada)", () => {
    const v = gate("spinning").evaluate(ctx({ firstReplyToInbound: true }));
    expect(v.pass).toBe(true);
    if (v.pass) expect(v.skipped).toBe("not_applicable");
  });

  it("ausente = false: nenhum chamador existente muda de comportamento", () => {
    expect(gate("spinning").evaluate(ctx({ firstReplyToInbound: undefined })).pass).toBe(false);
  });

  it("a marca NÃO fura stop: contato que pediu para parar continua sem mensagem", () => {
    expect(gate("stop").evaluate(ctx({ firstReplyToInbound: true, optedOut: true })).pass).toBe(false);
  });
});
