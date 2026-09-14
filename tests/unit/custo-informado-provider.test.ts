/**
 * `custoInformadoCents` — o custo real que a OpenRouter devolve, somado por passo.
 *
 * Por que existe: a tabela de `pricing.ts` casa por prefixo `claude-…`, e id da
 * OpenRouter (`anthropic/claude-sonnet-5`) nunca casava. Em produção (14/09) todo
 * `llm_calls.cost_cents` saía NULL, e o teto mensal — que soma
 * `coalesce(cost_cents, 0)` — ficou cego para qualquer gasto.
 */
import { describe, expect, it } from "vitest";

import { costCents, custoInformadoCents } from "@/lib/agent-engine/edge/llm/pricing";

const passo = (cost?: unknown) =>
  cost === undefined ? { providerMetadata: undefined } : { providerMetadata: { openrouter: { usage: { cost } } } };

describe("custoInformadoCents", () => {
  it("premissa: a tabela não conhece id da OpenRouter — por isso o custo saía NULL", () => {
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costCents("anthropic/claude-sonnet-5", usage)).toBeNull();
  });

  it("soma o custo de TODOS os passos, não só o do último", () => {
    // Turno com tool = vários passos. O providerMetadata do topo do resultado é
    // só o do último — somar por passo é o que evita subcontar o turno.
    expect(custoInformadoCents([passo(0.012), passo(0.003)])).toBeCloseTo(1.5, 10);
  });

  it("converte dólar para cents", () => {
    expect(custoInformadoCents([passo(0.25)])).toBe(25);
  });

  it("custo zero é custo informado, não ausência", () => {
    expect(custoInformadoCents([passo(0)])).toBe(0);
  });

  it("nenhum passo com custo → null, para cair na tabela", () => {
    expect(custoInformadoCents([passo(), passo()])).toBeNull();
    expect(custoInformadoCents([])).toBeNull();
  });

  it("ignora valor que não é número finito em vez de envenenar a soma", () => {
    expect(custoInformadoCents([passo("0.5"), passo(Number.NaN), passo(0.01)])).toBe(1);
  });

  it("metadata de outro provider não é lida como custo da OpenRouter", () => {
    expect(custoInformadoCents([{ providerMetadata: { anthropic: { usage: { cost: 9 } } } }])).toBeNull();
  });
});
