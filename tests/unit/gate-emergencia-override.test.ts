/**
 * `emergencyOverride` — o que ele fura e, sobretudo, o que ele NÃO fura.
 *
 * A orientação de emergência (192/SAMU, CVV 188) precisa sair às 3h da manhã e precisa
 * poder se repetir palavra por palavra — senão a janela anti-ban cala quem está passando
 * mal, e o anti-spinning cala a segunda pessoa do mesmo dia.
 *
 * Mas "urgente" não pode virar chave-mestra. `stop` (contato pediu para não ser contatado
 * ou está em force_human) e `lgpd` (dado anonimizado) são irrevogáveis pela regra dura
 * nº 2 e protegem a PESSOA — continuam vetando. É essa linha que este arquivo existe para
 * pinar: um dia alguém vai querer "só mais um gate" dentro da exceção, e o teste tem de
 * vermelhar.
 *
 * Os gates vêm de `BEFORE_SEND_GATES` por nome (e não de import direto) de propósito:
 * `stopGate`/`spinningGate` não são exportados, e alargar a superfície pública do módulo
 * só para o teste alcançá-los seria deixar o teste ditar o desenho.
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

const ORIENTACAO = "Ligue 192 (SAMU) ou vá ao pronto-socorro mais próximo.";

/** Contexto mínimo viável, deliberadamente hostil: 3h da manhã (fora da janela). */
function ctxBase(over: Partial<GateContext> = {}): GateContext {
  return {
    // 06:00Z = 03:00 em America/Sao_Paulo — fora da janela de cortesia (7h-22h).
    now: new Date("2026-09-08T06:00:00.000Z"),
    body: ORIENTACAO,
    optedOut: false,
    provider: "waha",
    messagingWindow: { lastInboundAt: new Date("2026-09-08T05:59:00.000Z") },
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
      rng: () => 0,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
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

describe("emergencyOverride", () => {
  describe("fura o que é auto-restrição nossa", () => {
    it("pacing: sem o override, 3h da manhã veta", () => {
      const v = gate("pacing").evaluate(ctxBase());
      expect(v.pass).toBe(false);
      if (!v.pass) expect(v.code).toBe("outside_window");
    });

    it("pacing: com o override passa — e passa como 'skipped', não como 'pass'", () => {
      // O trace precisa mostrar que a regra foi DESARMADA, não que ela aprovou. É essa
      // diferença que sustenta a auditoria sem bumpar BEFORE_SEND_CHAIN_VERSION (a versão
      // significa "a ORDEM mudou", e a ordem não mudou).
      const v = gate("pacing").evaluate(ctxBase({ emergencyOverride: true }));
      expect(v.pass).toBe(true);
      if (v.pass) expect(v.skipped).toBe("not_applicable");
    });

    it("spinning: com o override, cópia idêntica repetida não é vetada", () => {
      // Copies como o store as entrega: já normalizadas + hash. Montar com os helpers
      // reais (e não com um objeto inventado) é o que faz o cenário exercitar o motor
      // de verdade em vez de um formato que só existe no teste.
      const normalizada = normalizeCopy(ORIENTACAO);
      const repetida = Array.from({ length: SPINNING_DEFAULTS.repetitionThreshold + 1 }, () => ({
        normalizedText: normalizada,
        normalizedHash: hashNormalized(normalizada),
      }));
      const comJanelaCheia = (extra: Partial<GateContext>): GateContext =>
        ctxBase({ spinning: { knobs: SPINNING_DEFAULTS, window: repetida }, ...extra });

      const semOverride = gate("spinning").evaluate(comJanelaCheia({}));
      const comOverride = gate("spinning").evaluate(comJanelaCheia({ emergencyOverride: true }));

      // Guarda de vacuidade primeiro: se o cenário SEM override também passasse, a
      // asserção seguinte não provaria nada.
      expect(semOverride.pass).toBe(false);
      expect(comOverride.pass).toBe(true);
      if (comOverride.pass) expect(comOverride.skipped).toBe("not_applicable");
    });
  });

  describe("NÃO fura o que protege a pessoa — regra dura nº 2", () => {
    it("stop continua vetando mesmo em emergência", () => {
      const v = gate("stop").evaluate(ctxBase({ optedOut: true, emergencyOverride: true }));
      expect(v.pass).toBe(false);
    });

    it("lgpd continua vetando contato anonimizado mesmo em emergência", () => {
      const v = gate("lgpd").evaluate(
        ctxBase({
          emergencyOverride: true,
          lgpd: {
            isAnonymized: true,
            isFirstOutbound: false,
            isProspecting: false,
            legalBasis: {
              basis: 'consent',
              consentGranted: false,
              legalBasisRef: null,
              dataOrigin: 'whatsapp',
            },
          },
        }),
      );
      expect(v.pass).toBe(false);
    });
  });

  it("ausente = false: nenhum chamador existente muda de comportamento", () => {
    // Default conservador. Se isso um dia inverter, todo follow-up passaria a furar
    // janela horária sem ninguém ter pedido.
    expect(gate("pacing").evaluate(ctxBase()).pass).toBe(false);
  });
});
