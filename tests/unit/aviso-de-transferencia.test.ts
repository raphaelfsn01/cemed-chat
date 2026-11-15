import { describe, expect, it } from "vitest";

import { mensagemDeTransferenciaFeita } from "@/lib/agent-engine/agent/aviso-de-transferencia";
import { BEFORE_SEND_GATES, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * PR-1b: o aviso de transferência que sai na abertura da janela. A prova de ponta a ponta
 * está em `tests/invariants/aviso-de-transferencia.test.ts`; aqui, o texto e a única
 * exceção que o aviso abre no gate `stop`.
 */
function ctx(overrides: Partial<GateContext>): GateContext {
  return {
    now: new Date("2026-08-04T12:00:00Z"),
    body: "x",
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

const stop = BEFORE_SEND_GATES.find((g) => g.name === "stop")!;

describe("gate stop e o aviso de transferência", () => {
  it("o aviso passa com a conversa já transferida — é ele que avisa da transferência", () => {
    expect(stop.evaluate(ctx({ handoffActive: true, handoffNotice: true })).pass).toBe(true);
  });

  it("sem a marca, a conversa transferida continua bloqueando tudo", () => {
    const v = stop.evaluate(ctx({ handoffActive: true }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("handoff_ativo");
  });

  it("opt-out continua irrevogável, com ou sem a marca", () => {
    const v = stop.evaluate(ctx({ optedOut: true, handoffActive: true, handoffNotice: true }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("contato_bloqueado");
  });
});

describe("gate spinning e os textos fixos do código", () => {
  const spinning = BEFORE_SEND_GATES.find((g) => g.name === "spinning")!;
  const repetido = [
    { normalizedHash: "h", normalizedText: "aviso" },
    { normalizedHash: "h", normalizedText: "aviso" },
  ] as never;

  it("texto fixo do código (aviso/fallback) não é vetado por repetição", () => {
    const v = spinning.evaluate(ctx({ body: "aviso", codeFixedText: true, spinning: { knobs: SPINNING_DEFAULTS, window: repetido } }));
    expect(v).toEqual({ pass: true, skipped: "fixed_text" });
  });
});

describe("texto do aviso na abertura", () => {
  it("com gente da equipe disponível: diz que a equipe continua, sem prazo nem hora", () => {
    const t = mensagemDeTransferenciaFeita({ disponiveis: 1, total: 2 });
    expect(t).toBe(
      "Recebemos sua mensagem e passamos sua conversa para a nossa equipe. Ela continua o atendimento em seguida.",
    );
    expect(t).not.toMatch(/\d/);
  });

  it("sem ninguém disponível, ou leitura que falhou: frase conservadora (spec §11.2)", () => {
    const esperado =
      "Recebemos sua mensagem e passamos sua conversa para a nossa equipe. A equipe retorna assim que possível.";
    expect(mensagemDeTransferenciaFeita({ disponiveis: 0, total: 2 })).toBe(esperado);
    expect(mensagemDeTransferenciaFeita(null)).toBe(esperado);
  });
});
