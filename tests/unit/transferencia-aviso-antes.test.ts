/**
 * A transferência para humano não pode deixar o paciente sem resposta.
 *
 * A transferência marca force_human e o gate de envio recusa toda mensagem depois dela.
 * A tool, porém, mandava o modelo avisar DEPOIS ("sem mensagens além do aviso"). No
 * benchmark de set/2026, com tool e gate iguais aos de produção, o Gemini 2.5 Flash
 * transferiu primeiro e tentou avisar depois nas 5 urgências — nenhuma mensagem chegou.
 * Contexto completo no cabeçalho de `transferenciaPrecisaDeAviso` (human-handoff.ts).
 */
import { describe, expect, it } from "vitest";

import {
  MENSAGEM_HANDOFF_ACIONADO,
  mensagemAviseAntes,
  transferenciaPendente,
  transferenciaPrecisaDeAviso,
} from "@/lib/agent-engine/agent/human-handoff";

describe("transferenciaPrecisaDeAviso", () => {
  it("sem tentativa de aviso, a 1ª chamada é recusada", () => {
    expect(transferenciaPrecisaDeAviso({ tentou: false, jaRecusou: false })).toBe(true);
  });

  it("com tentativa de aviso, transfere direto — mesmo que o envio tenha falhado", () => {
    // "tentou" é a tentativa, não o sucesso: canal fora não pode impedir a pessoa de
    // chegar a um humano.
    expect(transferenciaPrecisaDeAviso({ tentou: true, jaRecusou: false })).toBe(false);
  });

  it("a 2ª chamada NUNCA é recusada — chegar a um humano não depende da ordem", () => {
    expect(transferenciaPrecisaDeAviso({ tentou: false, jaRecusou: true })).toBe(false);
  });
});

describe("transferenciaPendente — o runtime conclui o que o modelo largou", () => {
  it("recusada e não refeita: pendente — senão o paciente ouve a promessa e ninguém é acionado", () => {
    // Medido: o modelo obedece à recusa, avisa "vou passar para a equipe" e para aí.
    expect(transferenciaPendente({ jaRecusou: true, transferiu: false })).toBe(true);
  });

  it("recusada e depois refeita pelo modelo: nada pendente — não transfere duas vezes", () => {
    expect(transferenciaPendente({ jaRecusou: true, transferiu: true })).toBe(false);
  });

  it("nunca recusada: nada pendente — o runtime não inventa transferência", () => {
    expect(transferenciaPendente({ jaRecusou: false, transferiu: false })).toBe(false);
    expect(transferenciaPendente({ jaRecusou: false, transferiu: true })).toBe(false);
  });
});

describe("textos devolvidos ao modelo", () => {
  it("a recusa leva a situação da equipe — o que o aviso precisa dizer", () => {
    const frase = "Há 2 pessoas da equipe podendo assumir agora.";
    const m = mensagemAviseAntes(frase);
    expect(m).toContain(frase);
    expect(m).toContain("send_message");
    expect(m).toContain("request_human_handoff");
  });

  it("a confirmação não convida mais a avisar DEPOIS — o gate barraria", () => {
    expect(MENSAGEM_HANDOFF_ACIONADO).not.toMatch(/além do aviso/i);
    expect(MENSAGEM_HANDOFF_ACIONADO).toMatch(/nenhuma mensagem/i);
  });
});
