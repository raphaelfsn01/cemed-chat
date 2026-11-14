import { describe, expect, it } from "vitest";

import { deveReagendarPorJanela } from "@/lib/agent-engine/agent/window-reschedule";

/**
 * Resposta barrada pela janela de envio (7h–22h) não pode ser descartada: o turno volta
 * na abertura da janela. Caso real de 14/11 06h39 BRT: paciente escreveu, quatro envios
 * vetados com `outside_window`, turno `done` com zero mensagens e nada agendado — a tela
 * dizia "a resposta fica agendada para a próxima abertura da janela".
 */
const ABERTURA = new Date("2026-11-14T10:00:20Z");
const base = {
  jobKind: "inbound_turn",
  entregues: 0,
  optedOut: false,
  transferiu: false,
  janelaReabreEm: ABERTURA,
};

describe("deveReagendarPorJanela", () => {
  it("turno recebido, nada entregue e veto de janela → reagenda", () => {
    expect(deveReagendarPorJanela(base)).toBe(true);
  });

  it("sem veto de janela no turno → não reagenda", () => {
    expect(deveReagendarPorJanela({ ...base, janelaReabreEm: undefined })).toBe(false);
  });

  it("alguma mensagem foi entregue → não reagenda (o paciente já tem resposta)", () => {
    expect(deveReagendarPorJanela({ ...base, entregues: 1 })).toBe(false);
  });

  it("opt-out → não reagenda (silêncio obrigatório)", () => {
    expect(deveReagendarPorJanela({ ...base, optedOut: true })).toBe(false);
  });

  it("handoff concluído no turno → não reagenda (a conversa é da equipe)", () => {
    expect(deveReagendarPorJanela({ ...base, transferiu: true })).toBe(false);
  });

  it("follow-up tem reagendamento próprio → este não se aplica", () => {
    expect(deveReagendarPorJanela({ ...base, jobKind: "followup_turn" })).toBe(false);
  });
});
