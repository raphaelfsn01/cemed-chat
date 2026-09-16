/**
 * O rótulo de versão do agente é o mesmo número do banco, lido em décimos.
 * A sequência inteira (1, 2, 3…) não muda; só a apresentação.
 */
import { describe, expect, it } from "vitest";

import { rotuloVersao } from "@/lib/ai/agents/rotulo-versao";

describe("rotuloVersao", () => {
  it("a primeira versão é 0.1, não 0", () => {
    expect(rotuloVersao(1)).toBe("0.1");
  });

  it("a versão do agente da CEMED (7) vira 0.7", () => {
    expect(rotuloVersao(7)).toBe("0.7");
  });

  it("vira 1.0 ao passar de 9 — sem 0.10", () => {
    // "0.10" leria como menor que "0.9". A divisão por 10 resolve por construção.
    expect(rotuloVersao(9)).toBe("0.9");
    expect(rotuloVersao(10)).toBe("1.0");
    expect(rotuloVersao(12)).toBe("1.2");
  });

  it("segue legível bem além de 100 publicações", () => {
    expect(rotuloVersao(105)).toBe("10.5");
  });
});
