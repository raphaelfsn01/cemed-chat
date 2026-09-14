/**
 * `fecharCheckpoint` — o checkpoint não derruba mais um turno que já respondeu.
 *
 * Em produção (14/09) um JSON de checkpoint malformado fez a fila refazer o turno
 * inteiro com a resposta já enviada: ~2 min, e a mensagem seguinte do mesmo
 * contato ficou presa atrás. Contexto completo no cabeçalho de fechar-checkpoint.ts.
 *
 * Usa o parser REAL (`parseCheckpointText`) de propósito: o defeito foi o parser
 * real lançando num texto do modelo — um parser fake provaria só o laço.
 */
import { describe, expect, it, vi } from "vitest";

import { fecharCheckpoint } from "@/lib/agent-engine/agent/fechar-checkpoint";
import { parseCheckpointText } from "@/lib/agent-engine/agent/inbound-turn";

const VALIDO = JSON.stringify({
  commitments: ["equipe retorna no próximo dia útil"],
  objections: [],
  next_action: "encaminhar para medicina do trabalho",
  rolling_summary: "Empresa pediu ASO admissional.",
});

// Aspas internas sem escape — o tipo de erro que o modelo comete de verdade.
const MALFORMADO =
  '{"commitments": [], "objections": [], "next_action": null, "rolling_summary": "pediu "ASO" admissional"}';

function chamadasQueDevolvem(...textos: string[]) {
  let i = 0;
  return vi.fn(() => {
    const text = textos[i] ?? "";
    i += 1;
    return Promise.resolve({ text, callId: `call-${i}` });
  });
}

describe("fecharCheckpoint", () => {
  it("premissa: o texto malformado quebra mesmo o parser real", () => {
    expect(() => parseCheckpointText(MALFORMADO)).toThrow();
  });

  it("válido na 1ª: uma chamada só, com o conteúdo e o lastro dela", async () => {
    const chamar = chamadasQueDevolvem(VALIDO);
    const r = await fecharCheckpoint({ chamar, interpretar: parseCheckpointText });
    expect(chamar).toHaveBeenCalledTimes(1);
    expect(r?.content.next_action).toBe("encaminhar para medicina do trabalho");
    expect(r?.callId).toBe("call-1");
  });

  it("inválido e depois válido: repete no próprio turno e o lastro é a 2ª chamada", async () => {
    // O lastro importa: a atividade da timeline aponta para o llm_calls.id que
    // PRODUZIU o checkpoint gravado, não para a tentativa descartada.
    const chamar = chamadasQueDevolvem(MALFORMADO, VALIDO);
    const aoFalhar = vi.fn();
    const r = await fecharCheckpoint({ chamar, interpretar: parseCheckpointText, aoFalhar });
    expect(chamar).toHaveBeenCalledTimes(2);
    expect(aoFalhar).toHaveBeenCalledTimes(1);
    expect(aoFalhar.mock.calls[0]?.[0]).toBe(1);
    expect(r?.callId).toBe("call-2");
  });

  it("inválido nas duas: devolve null em vez de lançar — o turno conclui", async () => {
    const chamar = chamadasQueDevolvem(MALFORMADO, MALFORMADO);
    const aoFalhar = vi.fn();
    await expect(
      fecharCheckpoint({ chamar, interpretar: parseCheckpointText, aoFalhar }),
    ).resolves.toBeNull();
    expect(chamar).toHaveBeenCalledTimes(2);
    expect(aoFalhar).toHaveBeenCalledTimes(2);
  });

  it("erro do provider conta como tentativa falha, igual a JSON inválido", async () => {
    const chamar = vi
      .fn<() => Promise<{ text: string; callId: string | null }>>()
      .mockRejectedValueOnce(new Error("provider_status_502"))
      .mockResolvedValueOnce({ text: VALIDO, callId: "call-2" });
    const r = await fecharCheckpoint({ chamar, interpretar: parseCheckpointText });
    expect(chamar).toHaveBeenCalledTimes(2);
    expect(r?.callId).toBe("call-2");
  });

  it("respeita o limite de tentativas — não insiste para sempre", async () => {
    const chamar = chamadasQueDevolvem(MALFORMADO, MALFORMADO, MALFORMADO, VALIDO);
    const r = await fecharCheckpoint({ chamar, interpretar: parseCheckpointText, tentativas: 3 });
    expect(chamar).toHaveBeenCalledTimes(3);
    expect(r).toBeNull();
  });
});
