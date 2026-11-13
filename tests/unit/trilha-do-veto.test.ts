import { describe, expect, it } from "vitest";

import { vetoTrail } from "@/lib/agent-engine/guardrails/before-send";
import { vetoReason } from "@/lib/leads/veto-activity";

/**
 * Trilha do veto sem PII (item C da análise do agente). No teste real de 30/10 um
 * `send_message` foi vetado por `promise_semantic` e não havia como saber qual tentativa
 * era nem o tamanho do texto — e a linha do tempo mostrava o nome cru do gate.
 */
describe("vetoTrail — o que vai ao detail do trace de um envio vetado", () => {
  const CORPO = "Seu exame fica pronto amanhã, Maria. Ligue 22 99999-0000.";

  it("só números: tamanho, tentativa e se era o fallback — nunca o texto", () => {
    const trilha = vetoTrail({ body: CORPO, attempt: 2, fallback: true });
    expect(trilha).toEqual({ body_len: CORPO.length, attempt: 2, fallback: 1 });
    for (const v of Object.values(trilha)) expect(typeof v).toBe("number");
    expect(JSON.stringify(trilha)).not.toContain("Maria");
    expect(JSON.stringify(trilha)).not.toContain("99999");
  });

  it("chamador que não informa tentativa/fallback (follow-up, emergência) → só body_len", () => {
    expect(vetoTrail({ body: "abc" })).toEqual({ body_len: 3 });
    expect(vetoTrail({ body: "abc", fallback: false })).toEqual({ body_len: 3, fallback: 0 });
  });
});

describe("vetoReason — veto do classificador semântico tem texto próprio", () => {
  it("gate semantic_promise não cai no genérico com nome de regra", () => {
    const motivo = vetoReason("semantic_promise", "promise_semantic");
    expect(motivo).toBe("Não enviei: a mensagem parecia prometer algo que não posso garantir");
    expect(motivo).not.toContain("semantic_promise");
  });

  it("gate desconhecido continua no genérico (defesa para gate novo)", () => {
    expect(vetoReason("gate_novo", "codigo_x")).toContain('"gate_novo"');
  });
});
