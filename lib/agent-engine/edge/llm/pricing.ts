/**
 * Tabela de preços versionada (stack.md §2: usage × pricing.ts → llm_calls.cost_cents).
 * ÚNICO lugar com preço de modelo no repo.
 *
 * Fonte: https://docs.claude.com/en/docs/about-claude/pricing (conferida 2026-07);
 * cache write cotado no TTL 1h (2× input) — o TTL adotado pela doutrina de caching
 * (CLAUDE.md regra 15); cache read = 0.1× input.
 *
 * Modelo fora da tabela → custo NULL (desconhecido): mais honesto que inventar 0 —
 * o budget soma coalesce(cost_cents, 0), então modelo sem preço não consome teto;
 * quem habilitar um modelo novo para uma org adiciona a linha de preço aqui.
 */

/** USD por MILHÃO de tokens; match por prefixo do id (cobre sufixo de data do vendor). */
const USD_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite1h: number }> = {
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite1h: 6 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1, cacheWrite1h: 2 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite1h: 30 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Custo em CENTS (fracionário; coluna numeric) ou null se o modelo não tem preço
 * conhecido. `inputTokens` aqui é o TOTAL do usage do SDK — a parcela cacheada é
 * descontada e cobrada pela tarifa de cache.
 */
export function costCents(model: string, usage: TokenUsage): number | null {
  const priceKey = Object.keys(USD_PER_MTOK).find((prefix) => model.startsWith(prefix));
  if (priceKey === undefined) {
    return null;
  }
  const p = USD_PER_MTOK[priceKey];
  if (p === undefined) {
    return null; // inalcançável (key veio de Object.keys); satisfaz noUncheckedIndexedAccess
  }
  const noCacheInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const usd =
    (noCacheInput * p.input +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite1h +
      usage.outputTokens * p.output) /
    1_000_000;
  return usd * 100;
}

/**
 * Custo que o PROVIDER informou, somado por passo, em cents — ou `null` quando
 * nenhum passo trouxe custo (aí vale a tabela acima).
 *
 * Existe por causa da OpenRouter: ela serve modelos de dezenas de vendors, e a
 * tabela acima casa por prefixo `claude-…` — `anthropic/claude-sonnet-5` nunca
 * casava, o custo saía NULL e o teto mensal (que soma `coalesce(cost_cents, 0)`)
 * ficava cego. O custo que ela informa é o que de fato cobra, com cache e
 * roteamento já aplicados — mais fiel que qualquer tabela mantida aqui.
 *
 * Soma POR PASSO de propósito: num turno com tools, o `providerMetadata` do topo
 * do resultado é só o do ÚLTIMO passo (e está deprecado no ai@7 em favor de
 * `finalStep.providerMetadata`). Custo `0` é devolvido como 0, não como ausente.
 */
export function custoInformadoCents(
  steps: ReadonlyArray<{ providerMetadata?: Record<string, unknown> | undefined }>,
): number | null {
  let usd = 0;
  let informou = false;
  for (const s of steps) {
    const usage = (s.providerMetadata?.['openrouter'] as { usage?: { cost?: unknown } } | undefined)?.usage;
    if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost)) {
      usd += usage.cost;
      informou = true;
    }
  }
  return informou ? usd * 100 : null;
}
