import { describe, expect, it } from "vitest";
import { retentionCopy, type RetentionContext } from "./retention-copy";

const ctx: RetentionContext = {
  window_start_hour: 8,
  window_end_hour: 21,
  allow_sunday: false,
  timezone: "America/Sao_Paulo",
};

describe("retentionCopy — tradução leiga dos vetos before_send", () => {
  it("classifica pacing/spinning como proteção e interpola a janela", () => {
    const r = retentionCopy("outside_window", ctx);
    expect(r.kind).toBe("protection");
    expect(r.description).toContain("8h–21h");
    expect(r.description).toContain("sem domingo");
    expect(retentionCopy("mass_identical", ctx).kind).toBe("protection");
  });

  it("classifica stop/LGPD como conformidade", () => {
    expect(retentionCopy("contato_bloqueado", ctx).kind).toBe("compliance");
    expect(retentionCopy("lgpd_anonymized", ctx).kind).toBe("compliance");
    expect(retentionCopy("lgpd_missing_legal_basis", ctx).kind).toBe("compliance");
  });

  it("contato_bloqueado segue falando de opt-out; handoff_ativo fala da equipe, sem opt-out", () => {
    expect(retentionCopy("contato_bloqueado", ctx).description).toBe(
      "O contato pediu para não receber mensagens (opt-out). Nada será enviado a ele.",
    );
    const handoff = retentionCopy("handoff_ativo", ctx);
    expect(handoff.description).toBe("A conversa está com a equipe. O automático está pausado.");
    expect(handoff.description).not.toMatch(/opt-out/i);
  });

  it("handoff_ativo tem título e tipo próprios, não o de conformidade", () => {
    const handoff = retentionCopy("handoff_ativo", ctx);
    expect(handoff.kind).toBe("handoff");
    expect(handoff.title).toBe("Conversa com a equipe");
    expect(handoff.title).not.toMatch(/bloqueada|conformidade/i);
  });

  it("título e tipo de cada código ficam como estão (só o handoff mudou)", () => {
    const esperado: Record<string, [string, string]> = {
      outside_window: ["protection", "Resposta segurada pela proteção do número"],
      warmup_cap: ["protection", "Resposta segurada pela proteção do número"],
      daily_cap: ["protection", "Resposta segurada pela proteção do número"],
      mass_identical: ["protection", "Resposta segurada pela proteção do número"],
      contato_bloqueado: ["compliance", "Resposta bloqueada por conformidade"],
      lgpd_anonymized: ["compliance", "Resposta bloqueada por conformidade"],
      lgpd_missing_legal_basis: ["compliance", "Resposta bloqueada por conformidade"],
      promise_out_of_table: ["quality", "Resposta retida para correção"],
      promise_semantic: ["quality", "Resposta retida para correção"],
      disclosure_required: ["quality", "Resposta retida para correção"],
      handoff_ativo: ["handoff", "Conversa com a equipe"],
    };
    for (const [code, [kind, title]] of Object.entries(esperado)) {
      const r = retentionCopy(code, ctx);
      expect([code, r.kind, r.title]).toEqual([code, kind, title]);
    }
    const fallback = retentionCopy(null, ctx);
    expect([fallback.kind, fallback.title]).toEqual([
      "protection",
      "Resposta segurada pela proteção do número",
    ]);
  });

  it("classifica promise/disclosure como qualidade", () => {
    expect(retentionCopy("promise_out_of_table", ctx).kind).toBe("quality");
    expect(retentionCopy("promise_semantic", ctx).kind).toBe("quality");
    expect(retentionCopy("disclosure_required", ctx).kind).toBe("quality");
  });

  it("código desconhecido ou null cai no fallback de proteção sem quebrar", () => {
    expect(retentionCopy(null, ctx).kind).toBe("protection");
    const unknown = retentionCopy("gate_novo_do_engine", ctx);
    expect(unknown.kind).toBe("protection");
    expect(unknown.description).toContain("gate_novo_do_engine");
  });

  it("respeita allow_sunday=true na copy da janela", () => {
    const r = retentionCopy("outside_window", { ...ctx, allow_sunday: true });
    expect(r.description).not.toContain("sem domingo");
  });
});
