import { describe, expect, it } from 'vitest';

import { resumoDosVetos, turnoFicouMudo, type TurnoMudoInput } from './turn-no-reply';

const mudo: TurnoMudoInput = {
  jobKind: 'inbound_turn',
  entregues: 0,
  optedOut: false,
  transferiu: false,
  vetosPorGate: {},
};

describe('turnoFicouMudo — quando o silêncio do turno é um problema', () => {
  it('inbound sem envio, sem opt-out e sem handoff → é', () => {
    expect(turnoFicouMudo(mudo)).toBe(true);
  });

  it('vetos de qualidade ou de ritmo não legitimam o silêncio', () => {
    expect(turnoFicouMudo({ ...mudo, vetosPorGate: { semantic_promise: 2, pacing: 1 } })).toBe(true);
  });

  it.each([
    ['houve envio aceito pelo canal', { entregues: 1 }],
    ['contato com opt-out', { optedOut: true }],
    ['handoff concluído no turno', { transferiu: true }],
    ['gate stop vetou (opt-out ou conversa já com a equipe)', { vetosPorGate: { stop: 1 } }],
    ['follow-up pode decidir não falar', { jobKind: 'followup_turn' }],
  ] as const)('%s → não é', (_nome, parte) => {
    expect(turnoFicouMudo({ ...mudo, ...parte })).toBe(false);
  });
});

describe('resumoDosVetos', () => {
  it('ordena por gate, ignora zeros e devolve vazio sem vetos', () => {
    expect(resumoDosVetos({ semantic_promise: 2, pacing: 1, promise: 0 })).toBe('pacing ×1, semantic_promise ×2');
    expect(resumoDosVetos({})).toBe('');
  });
});
