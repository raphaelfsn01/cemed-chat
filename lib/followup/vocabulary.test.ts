import { describe, expect, it } from 'vitest';

import { CONDITION_FIELDS, CONDITION_OPS } from './graph-schema';
import {
  CAMPOS_OFERECIDOS,
  CAMPO_AJUDA,
  CAMPO_LABEL,
  CAMPO_NA_FRASE,
  CAMPO_SEM_PRODUTOR,
  OPERADORES_POR_CAMPO,
  TIPO_DO_VALOR,
  descreverCheck,
  descreverCondicao,
  operadorPadraoDoCampo,
  valorPadraoDoCampo,
} from './vocabulary';

/**
 * O ponto desta suíte: identificador cru na tela é defeito. Campo novo no
 * schema sem nome em pt-br tem que reprovar aqui, não aparecer como
 * `steps_taken` na cara de quem configura.
 */
describe('vocabulário do construtor de fluxos', () => {
  it('nomeia todo campo do schema', () => {
    for (const field of CONDITION_FIELDS) {
      expect(CAMPO_LABEL[field], `CAMPO_LABEL.${field}`).toBeTruthy();
      expect(CAMPO_NA_FRASE[field], `CAMPO_NA_FRASE.${field}`).toBeTruthy();
      expect(CAMPO_AJUDA[field], `CAMPO_AJUDA.${field}`).toBeTruthy();
      expect(TIPO_DO_VALOR[field], `TIPO_DO_VALOR.${field}`).toBeTruthy();
    }
  });

  it('dá pelo menos um operador nomeado a cada campo', () => {
    for (const field of CONDITION_FIELDS) {
      const ops = OPERADORES_POR_CAMPO[field];
      expect(ops.length, `operadores de ${field}`).toBeGreaterThan(0);
      for (const o of ops) {
        expect(CONDITION_OPS).toContain(o.op);
        expect(o.label).toBeTruthy();
        expect(o.naFrase).toBeTruthy();
      }
    }
  });

  it('não oferece operador que o avaliador torna inútil', () => {
    // `tag` é lista: gte/lte retornam sempre falso e contains é sinônimo de eq.
    const ops = OPERADORES_POR_CAMPO.tag.map((o) => o.op);
    expect(ops).not.toContain('gte');
    expect(ops).not.toContain('lte');
    expect(ops).not.toContain('contains');
  });

  it('esconde o campo sem produtor, mas mantém o nome para nó já salvo', () => {
    expect(CAMPOS_OFERECIDOS).not.toContain('last_outcome');
    expect(CAMPO_SEM_PRODUTOR.last_outcome).toBeTruthy();
    expect(CAMPO_LABEL.last_outcome).toBeTruthy();
  });

  it('dá valor padrão numérico ao campo numérico', () => {
    // O bug que originou esta mudança: valor de texto em campo numérico faz
    // gte/lte retornarem sempre falso, sem erro nenhum.
    expect(valorPadraoDoCampo('steps_taken')).toBe(0);
    expect(typeof valorPadraoDoCampo('steps_taken')).toBe('number');
    expect(valorPadraoDoCampo('tag')).toBe('');
    expect(valorPadraoDoCampo('lead_stage')).toBe('');
  });

  it('escolhe um operador válido ao trocar de campo', () => {
    for (const field of CONDITION_FIELDS) {
      const padrao = operadorPadraoDoCampo(field);
      expect(OPERADORES_POR_CAMPO[field].map((o) => o.op)).toContain(padrao);
    }
  });

  it('descreve a condição como frase', () => {
    expect(descreverCheck({ field: 'steps_taken', op: 'gte', value: 3 })).toBe(
      'os passos que o fluxo já deu forem pelo menos 3'
    );
    expect(descreverCheck({ field: 'tag', op: 'neq', value: 'vip' })).toBe(
      'as etiquetas do contato não incluírem vip'
    );
  });

  it('usa o nome da etapa quando ele é conhecido, e não o id', () => {
    const check = { field: 'lead_stage' as const, op: 'eq' as const, value: 'stage-uuid' };
    expect(descreverCheck(check)).toContain('a etapa configurada');
    expect(descreverCheck(check, { nomeDaEtapa: () => 'Qualificado' })).toBe(
      'a etapa do funil for Qualificado'
    );
  });

  it('junta várias condições pelo combinador e corta pelo limite', () => {
    const config = {
      combinator: 'or' as const,
      checks: [
        { field: 'steps_taken' as const, op: 'gte' as const, value: 1 },
        { field: 'tag' as const, op: 'eq' as const, value: 'vip' },
        { field: 'tag' as const, op: 'eq' as const, value: 'novo' },
      ],
    };
    expect(descreverCondicao(config)).toBe(
      'Se os passos que o fluxo já deu forem pelo menos 1 ou as etiquetas do contato incluírem vip ou as etiquetas do contato incluírem novo'
    );
    expect(descreverCondicao(config, { limite: 1 })).toBe(
      'Se os passos que o fluxo já deu forem pelo menos 1 ou mais 2'
    );
  });
});
