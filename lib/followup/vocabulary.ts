/**
 * Vocabulário pt-br do construtor de fluxos — fonte única.
 *
 * O painel de configuração e o card do canvas importam daqui; nenhum dos dois
 * redeclara texto. Os identificadores vêm de `graph-schema.ts`, então um campo
 * novo no schema aparece aqui como erro de tipo, e não como string crua na tela.
 *
 * Duas decisões que este arquivo carrega, e o porquê:
 *
 * 1. **A lista de operadores é por campo, não global.** O avaliador
 *    (`node-handlers.ts`) trata `tag` como lista e `steps_taken` como número:
 *    `gte`/`lte` sobre uma lista retornam sempre falso, e `contains` sobre lista
 *    é sinônimo de `eq`. Oferecer as cinco opções em todo campo é oferecer
 *    combinações que nunca disparam.
 * 2. **`last_outcome` não é oferecido.** O motor fixa `null` nesse campo
 *    (`engine.ts`), então toda condição sobre ele é falsa. Continua nomeado
 *    aqui para que um nó salvo antes desta mudança apareça com aviso, em vez de
 *    sumir da tela levando a configuração junto.
 */
import {
  CONDITION_FIELDS,
  type ConditionField,
  type ConditionOp,
} from './graph-schema';

/** Rótulo do campo no seletor. */
export const CAMPO_LABEL: Record<ConditionField, string> = {
  lead_stage: 'Etapa do funil',
  tag: 'Etiquetas do contato',
  steps_taken: 'Passos que o fluxo já deu',
  last_outcome: 'Resultado da última classificação',
};

/** O mesmo campo dentro da frase que descreve a regra. */
export const CAMPO_NA_FRASE: Record<ConditionField, string> = {
  lead_stage: 'a etapa do funil',
  tag: 'as etiquetas do contato',
  steps_taken: 'os passos que o fluxo já deu',
  last_outcome: 'o resultado da última classificação',
};

/** De onde o valor vem de verdade, em uma linha. */
export const CAMPO_AJUDA: Record<ConditionField, string> = {
  lead_stage: 'A etapa em que o card do paciente está agora, no funil escolhido.',
  tag: 'As etiquetas da ficha do contato. Compara a etiqueta inteira, não pedaço dela.',
  steps_taken:
    'Quantas jogadas o motor já deu neste fluxo para este contato — conta espera e nova tentativa, não só mensagem enviada. O fluxo morre sozinho ao passar de 30.',
  last_outcome: 'A classe decidida por um nó Classificar (IA).',
};

/**
 * Campos que o motor sabe preencher. `last_outcome` fica fora até existir quem
 * o escreva.
 */
export const CAMPOS_OFERECIDOS: readonly ConditionField[] = CONDITION_FIELDS.filter(
  (f) => f !== 'last_outcome'
);

/** Campo que existe no schema mas nenhum produtor alimenta — com o motivo. */
export const CAMPO_SEM_PRODUTOR: Partial<Record<ConditionField, string>> = {
  last_outcome:
    'O motor ainda não guarda a classe decidida pelo Classificar (IA), então esta condição nunca será verdadeira. Para reagir a uma classe, ligue a saída do próprio nó Classificar.',
};

export interface OperadorOferecido {
  op: ConditionOp;
  /** Rótulo no seletor. */
  label: string;
  /** A mesma ideia dentro da frase ("...se os passos FOREM PELO MENOS 3"). */
  naFrase: string;
}

/**
 * Operadores que fazem sentido em cada campo, na ordem em que se pensa neles.
 * O que está fora, está fora porque o avaliador o torna inútil ali.
 */
export const OPERADORES_POR_CAMPO: Record<ConditionField, readonly OperadorOferecido[]> = {
  lead_stage: [
    { op: 'eq', label: 'é', naFrase: 'for' },
    { op: 'neq', label: 'não é', naFrase: 'não for' },
  ],
  tag: [
    { op: 'eq', label: 'incluem', naFrase: 'incluírem' },
    { op: 'neq', label: 'não incluem', naFrase: 'não incluírem' },
  ],
  steps_taken: [
    { op: 'gte', label: 'é pelo menos', naFrase: 'forem pelo menos' },
    { op: 'lte', label: 'é no máximo', naFrase: 'forem no máximo' },
    { op: 'eq', label: 'é exatamente', naFrase: 'forem exatamente' },
    { op: 'neq', label: 'é diferente de', naFrase: 'forem diferentes de' },
  ],
  last_outcome: [
    { op: 'eq', label: 'é', naFrase: 'for' },
    { op: 'neq', label: 'não é', naFrase: 'não for' },
    { op: 'contains', label: 'contém', naFrase: 'contiver' },
    { op: 'gte', label: 'é pelo menos', naFrase: 'for pelo menos' },
    { op: 'lte', label: 'é no máximo', naFrase: 'for no máximo' },
  ],
};

/** Que editor de valor o campo pede. */
export type TipoDoValor = 'numero' | 'etapa' | 'texto';

export const TIPO_DO_VALOR: Record<ConditionField, TipoDoValor> = {
  lead_stage: 'etapa',
  tag: 'texto',
  steps_taken: 'numero',
  last_outcome: 'texto',
};

/**
 * Valor inicial ao escolher um campo. Numérico nasce número — o avaliador
 * compara `gte`/`lte` só quando os dois lados são número, e valor de texto
 * num campo numérico é uma condição que nunca dispara.
 */
export function valorPadraoDoCampo(field: ConditionField): string | number {
  return TIPO_DO_VALOR[field] === 'numero' ? 0 : '';
}

/** Primeiro operador válido do campo — usado ao trocar de campo. */
export function operadorPadraoDoCampo(field: ConditionField): ConditionOp {
  const primeiro = OPERADORES_POR_CAMPO[field][0];
  if (!primeiro) throw new Error(`campo de condição sem operador nomeado: ${field}`);
  return primeiro.op;
}

export interface Check {
  field: ConditionField;
  op: ConditionOp;
  value: string | number;
}

export interface OpcoesDeDescricao {
  /** Traduz o id da etapa para o nome que aparece no funil. */
  nomeDaEtapa?: (stageId: string) => string | undefined;
}

function descreverValor(check: Check, opts?: OpcoesDeDescricao): string {
  if (check.field === 'lead_stage') {
    const id = String(check.value);
    if (!id) return 'a etapa ainda não escolhida';
    return opts?.nomeDaEtapa?.(id) ?? 'a etapa configurada';
  }
  if (check.value === '') return '(vazio)';
  return String(check.value);
}

/** Uma condição, em português. */
export function descreverCheck(check: Check, opts?: OpcoesDeDescricao): string {
  const operador = OPERADORES_POR_CAMPO[check.field].find((o) => o.op === check.op);
  const verbo = operador?.naFrase ?? check.op;
  return `${CAMPO_NA_FRASE[check.field]} ${verbo} ${descreverValor(check, opts)}`;
}

/**
 * O nó inteiro, em português. `limite` corta a frase no card do canvas, onde
 * não cabe uma regra de dez partes.
 */
export function descreverCondicao(
  config: { combinator: 'and' | 'or'; checks: readonly Check[] },
  opts?: OpcoesDeDescricao & { limite?: number }
): string {
  if (config.checks.length === 0) return 'Sem condição';
  const limite = opts?.limite ?? config.checks.length;
  const mostrados = config.checks.slice(0, limite);
  const juncao = config.combinator === 'and' ? ' e ' : ' ou ';
  const frase = mostrados.map((c) => descreverCheck(c, opts)).join(juncao);
  const resto = config.checks.length - mostrados.length;
  return `Se ${frase}${resto > 0 ? ` ${juncao.trim()} mais ${resto}` : ''}`;
}
