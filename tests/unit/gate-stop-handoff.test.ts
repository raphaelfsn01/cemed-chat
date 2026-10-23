/**
 * O gate `stop` tem DOIS vetos com a mesma força e códigos diferentes:
 *   - `contacts.is_blocked`  → `contato_bloqueado` (o contato pediu para sair — opt-out);
 *   - `contacts.force_human` → `handoff_ativo`     (a equipe assumiu a conversa).
 *
 * Antes, os dois saíam como `contato_bloqueado` e a tela dizia "o contato pediu para não
 * receber mensagens" numa conversa que a equipe tinha apenas assumido. O que este arquivo
 * trava: (1) o opt-out NÃO enfraqueceu — vence o handoff quando os dois estão ligados;
 * (2) o handoff continua vetando o envio; (3) o código sai do que o BANCO diz, não do que
 * o chamador passa.
 */
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import {
  BEFORE_SEND_GATES,
  runBeforeSend,
  type Gate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { vetoReason } from "@/lib/leads/veto-activity";

const stopGate: Gate = BEFORE_SEND_GATES.find((g) => g.name === "stop")!;

function ctxBase(over: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-09-08T15:00:00.000Z"),
    body: "oi",
    optedOut: false,
    handoffActive: false,
    provider: "waha",
    pacing: { knobs: PACING_DEFAULTS, state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null }, crmDailyLimit: null },
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

function veto(over: Partial<GateContext>) {
  const v = stopGate.evaluate(ctxBase(over));
  if (v.pass) throw new Error("esperava veto");
  return v;
}

describe("gate stop — código por flag", () => {
  it("is_blocked sozinho → contato_bloqueado", () => {
    expect(veto({ optedOut: true }).code).toBe("contato_bloqueado");
  });

  it("force_human sozinho → handoff_ativo", () => {
    expect(veto({ handoffActive: true }).code).toBe("handoff_ativo");
  });

  it("os dois ligados → contato_bloqueado (opt-out vence, nunca fica mais fraco)", () => {
    expect(veto({ optedOut: true, handoffActive: true }).code).toBe("contato_bloqueado");
  });

  it("nenhum ligado → passa", () => {
    expect(stopGate.evaluate(ctxBase()).pass).toBe(true);
  });

  it("emergência não fura nenhum dos dois", () => {
    expect(veto({ optedOut: true, emergencyOverride: true }).code).toBe("contato_bloqueado");
    expect(veto({ handoffActive: true, emergencyOverride: true }).code).toBe("handoff_ativo");
  });

  it("o texto de contato_bloqueado segue o de antes; o de handoff_ativo manda encerrar o turno", () => {
    expect(veto({ optedOut: true }).reason).toBe(
      "o lead optou por sair do atendimento (bloqueio/opt-out irrevogável) — não é " +
        "possível enviar nada a ele; encerre o turno sem tentar de novo.",
    );
    const handoff = veto({ handoffActive: true }).reason;
    expect(handoff).toContain("equipe humana");
    expect(handoff).toContain("encerre o turno sem tentar de novo");
    expect(handoff).not.toMatch(/opt-out|optou/i);
  });
});

describe("runBeforeSend — o código sai do que o banco diz sobre o contato", () => {
  async function roda(contato: { is_blocked: boolean; force_human: boolean } | null, optedOutThisTurn = false) {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("from contacts")) return { rows: contato ? [contato] : [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const persisted = vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] });
    const pool = { connect: vi.fn().mockResolvedValue(client), query: persisted } as unknown as pg.Pool;
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn(async () => ({ kind: "sent" as const, idempotencyKey: "k", messageId: "m" }));

    const result = await runBeforeSend({
      pool,
      log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: "oi",
      optedOutThisTurn,
      crmDailyLimit: null,
      now: new Date("2026-09-08T15:00:00.000Z"),
      rng: () => 0,
      sleep: async () => {},
      gates: [stopGate],
      send,
    });
    return { result, send, persisted };
  }

  it("force_human sozinho vetou com handoff_ativo, não enviou e gravou o código no trace", async () => {
    const { result, send, persisted } = await roda({ is_blocked: false, force_human: true });
    expect(result.status).toBe("vetoed");
    if (result.status !== "vetoed") throw new Error("inalcançável");
    expect(result.gate).toBe("stop");
    expect(result.code).toBe("handoff_ativo");
    expect(send).not.toHaveBeenCalled();
    const insert = persisted.mock.calls.find(([sql]) => String(sql).includes("before_send_traces"));
    expect(insert![1]).toContain("handoff_ativo");
  });

  it("is_blocked sozinho vetou com contato_bloqueado", async () => {
    const { result, send } = await roda({ is_blocked: true, force_human: false });
    expect(result.status === "vetoed" && result.code).toBe("contato_bloqueado");
    expect(send).not.toHaveBeenCalled();
  });

  it("os dois no banco → contato_bloqueado", async () => {
    const { result, send } = await roda({ is_blocked: true, force_human: true });
    expect(result.status === "vetoed" && result.code).toBe("contato_bloqueado");
    expect(send).not.toHaveBeenCalled();
  });

  it("is_blocked lido no get_lead_context do turno vence force_human do banco", async () => {
    const { result } = await roda({ is_blocked: false, force_human: true }, true);
    expect(result.status === "vetoed" && result.code).toBe("contato_bloqueado");
  });

  it("nenhum flag → envia; contato não encontrado → envia (comportamento de antes)", async () => {
    expect((await roda({ is_blocked: false, force_human: false })).result.status).toBe("sent");
    expect((await roda(null)).result.status).toBe("sent");
  });
});

describe("linha do tempo (vetoReason)", () => {
  it("handoff_ativo diz que a conversa está com a equipe, sem falar em opt-out", () => {
    const t = vetoReason("stop", "handoff_ativo");
    expect(t).toBe("Não enviei: a conversa está com a equipe humana.");
  });

  it("contato_bloqueado (e qualquer outro código do gate stop) segue como antes", () => {
    const antes = "Não enviei: o contato pediu para parar de receber mensagens";
    expect(vetoReason("stop", "contato_bloqueado")).toBe(antes);
    expect(vetoReason("stop", "opted_out")).toBe(antes);
  });

  it("handoff_ativo só tem texto próprio sob o gate stop", () => {
    expect(vetoReason("outro_gate", "handoff_ativo")).toBe(
      'Não enviei: bloqueado pela regra "outro_gate" (handoff_ativo)',
    );
  });
});
