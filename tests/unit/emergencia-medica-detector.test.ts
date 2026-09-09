/**
 * Detector determinístico de emergência médica (spec da clínica §10.1).
 *
 * O que este arquivo protege, em ordem de importância:
 *
 * 1. **Falso NEGATIVO** — mensagem de emergência que não dispara. Custo: a pessoa
 *    recebe conversa comercial em vez da orientação de urgência.
 * 2. **Falso POSITIVO** — histórico clínico tratado como emergência em curso. Custo:
 *    a escalação seta `contacts.force_human`, que o agente não reverte, e o lead
 *    legítimo fica preso na fila humana depois de levar um susto desnecessário.
 *
 * Numa clínica o (2) é frequente de verdade: "meu pai teve um AVC" é assunto NORMAL
 * de quem quer marcar neurologista. Por isso as duas listas de negativos abaixo têm
 * o mesmo peso que a de positivos.
 */
import { describe, expect, it } from "vitest";

import {
  detectMedicalEmergency,
  EMERGENCY_MESSAGES,
} from "@/lib/agent-engine/agent/medical-emergency";

describe("detectMedicalEmergency", () => {
  describe("emergência clínica (192)", () => {
    const positivos = [
      "estou com dor no peito",
      "Estou com DOR NO PEITO forte",
      "to com dor no peito e falta de ar",
      "socorro, não consigo respirar",
      "minha esposa desmaiou agora mesmo",
      "estou sangrando muito",
      "acho que é derrame cerebral, a boca dele está torta",
      "fala enrolada e fraqueza de um lado",
      "tive uma convulsão agora",
      "acidente de moto, urgente",
      "estou tendo um infarto",
    ];
    for (const msg of positivos) {
      it(`dispara: "${msg}"`, () => {
        expect(detectMedicalEmergency(msg)).toBe("clinical");
      });
    }

    it("casa igual com e sem acento — a normalização é NFD", () => {
      expect(detectMedicalEmergency("convulsão")).toBe("clinical");
      expect(detectMedicalEmergency("convulsao")).toBe("clinical");
      expect(detectMedicalEmergency("intoxicação")).toBe("clinical");
    });
  });

  describe("autolesão (192 + CVV 188)", () => {
    const positivos = [
      "quero me matar",
      "estou pensando em suicídio",
      "não aguento mais viver",
      "vou acabar com a minha vida",
      "tenho pensamentos suicidas",
    ];
    for (const msg of positivos) {
      it(`dispara: "${msg}"`, () => {
        expect(detectMedicalEmergency(msg)).toBe("self_harm");
      });
    }

    it("self_harm VENCE clinical quando os dois casam", () => {
      // A conduta de self_harm é superconjunto (192 + CVV): na sobreposição, errar
      // para o lado mais protetivo é o certo.
      expect(detectMedicalEmergency("tomei veneno, quero me matar")).toBe("self_harm");
    });
  });

  describe("NÃO dispara — histórico clínico e terceiros", () => {
    const negativos = [
      // o caso que motivou o filtro de contexto
      "meu pai teve um AVC no ano passado, quero marcar neurologista",
      "minha mãe já teve convulsão, gostaria de agendar uma consulta",
      "tenho histórico de infarto na família, preciso marcar cardiologista",
      "ficou com sequela de derrame, quero agendar fisioterapia",
      // ocupacional: "acidente" é palavra comum fora de emergência
      "acidente de trabalho, preciso de exame admissional",
      // conversa comum da clínica
      "quero marcar uma consulta com cardiologista",
      "vocês fazem eletrocardiograma?",
      "bom dia, gostaria de saber o horário de vocês",
      "",
    ];
    for (const msg of negativos) {
      it(`ignora: "${msg}"`, () => {
        expect(detectMedicalEmergency(msg)).toBeNull();
      });
    }
  });

  describe("1ª pessoa no presente VENCE o filtro de contexto", () => {
    it("dispara mesmo mencionando terceiro, se há sinal de agora", () => {
      // Sem esta regra, "meu pai" anularia a emergência REAL em curso.
      expect(
        detectMedicalEmergency("socorro, meu pai está com dor no peito agora mesmo"),
      ).toBe("clinical");
      expect(detectMedicalEmergency("meu filho não consigo acordar, urgente")).not.toBeNull();
    });
  });

  describe("mensagens de conduta", () => {
    it("a clínica orienta 192 e nega ser emergência", () => {
      expect(EMERGENCY_MESSAGES.clinical).toContain("192");
      expect(EMERGENCY_MESSAGES.clinical.toLowerCase()).toContain("não fazemos atendimento de emergência");
    });

    it("a de autolesão acrescenta o CVV 188 — e mantém o 192", () => {
      expect(EMERGENCY_MESSAGES.self_harm).toContain("188");
      expect(EMERGENCY_MESSAGES.self_harm).toContain("192");
    });

    it("nenhuma promete atendimento nem agenda", () => {
      for (const msg of Object.values(EMERGENCY_MESSAGES)) {
        expect(msg.toLowerCase()).not.toContain("agendad");
        expect(msg.toLowerCase()).not.toContain("marcad");
      }
    });
  });
});
