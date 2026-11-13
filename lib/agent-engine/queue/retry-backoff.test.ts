import { describe, expect, it } from 'vitest';

import { RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_MAX_MS, retryBackoffMs } from './queue';

describe('retryBackoffMs — espera entre tentativas de um job que falhou', () => {
  it('15 s, dobrando a cada falha, com teto de 2 min', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryBackoffMs)).toEqual([
      15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000,
    ]);
  });

  it('entrada anômala (0, negativa, fracionada) nunca dá espera menor que a base', () => {
    for (const n of [0, -3, 0.4, 1.9]) expect(retryBackoffMs(n)).toBe(RETRY_BACKOFF_BASE_MS);
  });

  it('os valores são os decididos em 31/10: base 15 s e teto 2 min', () => {
    expect(RETRY_BACKOFF_BASE_MS).toBe(15_000);
    expect(RETRY_BACKOFF_MAX_MS).toBe(120_000);
  });
});
