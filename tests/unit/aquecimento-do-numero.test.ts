/**
 * Data de ativação do número e o teto de aquecimento que ela produz.
 *
 * Caso real (14/11/2026): a conexão da CEMED não tinha data de ativação. O motor tratou o
 * número — em uso desde 09/09 — como novo, com teto de 20 mensagens por dia para o número
 * inteiro, e o agente emudeceu depois da 20ª. A tela mostrava os degraus mas não tinha
 * onde informar a data.
 */
import { describe, expect, it } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { aquecimentoAtual } from "@/lib/ai/aquecimento";
import { pacingKnobsUpdateSchema } from "@/lib/ai/pacing-knobs";

const HOJE = new Date("2026-11-15T15:00:00Z");
const DEGRAUS = PACING_DEFAULTS.warmupDailyCaps;
const SESSAO = "7308883b-ecf5-4323-b5cb-42733c8afd11";

describe("aquecimentoAtual", () => {
  it("sem data → idade desconhecida e o teto do degrau mais baixo (o motor trata como novo)", () => {
    expect(aquecimentoAtual(null, DEGRAUS, HOJE)).toEqual({ idadeDias: null, tetoDia: 20 });
  });

  it("em uso desde 09/09 → 67 dias, sem teto de aquecimento", () => {
    expect(aquecimentoAtual("2026-09-09", DEGRAUS, HOJE)).toEqual({ idadeDias: 67, tetoDia: null });
  });

  it("aceita o timestamp que o banco devolve", () => {
    expect(aquecimentoAtual("2026-09-09T00:00:00+00:00", DEGRAUS, HOJE).idadeDias).toBe(67);
  });

  it("5 dias → degrau de 4+ dias (50/dia)", () => {
    expect(aquecimentoAtual("2026-11-10", DEGRAUS, HOJE)).toEqual({ idadeDias: 5, tetoDia: 50 });
  });
});

describe("aquecimentoAtual com data ilegível", () => {
  it("texto livre (navegador sem seletor de data) → tratado como sem data, nunca NaN", () => {
    expect(aquecimentoAtual("09/09/2026", DEGRAUS, HOJE)).toEqual({ idadeDias: null, tetoDia: 20 });
  });
});

describe("number_activated_at na gravação", () => {
  const base = { channel_session_id: SESSAO };

  it("aceita data AAAA-MM-DD no passado", () => {
    expect(pacingKnobsUpdateSchema.safeParse({ ...base, number_activated_at: "2026-09-09" }).success).toBe(true);
  });

  it("recusa data no futuro (zeraria o aquecimento sem motivo)", () => {
    const amanha = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(pacingKnobsUpdateSchema.safeParse({ ...base, number_activated_at: amanha }).success).toBe(false);
  });

  it("recusa formato brasileiro e data impossível", () => {
    expect(pacingKnobsUpdateSchema.safeParse({ ...base, number_activated_at: "09/09/2026" }).success).toBe(false);
    expect(pacingKnobsUpdateSchema.safeParse({ ...base, number_activated_at: "2026-02-31" }).success).toBe(false);
  });

  it("recusa data anterior ao WhatsApp (desligaria o aquecimento sem critério)", () => {
    expect(pacingKnobsUpdateSchema.safeParse({ ...base, number_activated_at: "2000-01-01" }).success).toBe(false);
  });

  it("recusa null: a coluna é NOT NULL (default now()), apagar a data não é uma opção", () => {
    expect(pacingKnobsUpdateSchema.safeParse({ ...base, number_activated_at: null }).success).toBe(false);
  });
});
