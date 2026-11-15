/**
 * Detector determinístico de LIMITES CLÍNICOS na fala do agente (M7 da auditoria).
 *
 * A spec da clínica (`docs/cemed/spec-crm-cemed.md`) tem dois "nunca" que até aqui só
 * viviam no prompt:
 *   - §4.3: o agente NUNCA informa preço, valor, faixa de preço ou "a partir de";
 *   - §8.2: o agente não dá diagnóstico, não interpreta sintoma, não recomenda conduta,
 *     medicamento, dose ou tratamento, e não escolhe especialista pela queixa.
 * Prompt é pedido, não garantia: este detector é a rede na saída. O gate que o usa
 * (`clinicalLimitsGate`, em `before-send.ts`) devolve o veto ao modelo para ele reescrever.
 *
 * ═══ O que ele caça, e o que NÃO caça ═══
 *
 * Caça FORMA de preço (moeda, número junto de "valor/custa/a partir de", parcela,
 * desconto, gratuidade de serviço) e FORMA de orientação médica (dose, posologia,
 * verbo de tomar/usar junto de remédio, frase de diagnóstico junto de doença, prognóstico
 * tranquilizador, "o ideal é o <especialista>").
 *
 * NÃO caça o que só um classificador pegaria: preço por extenso ("cento e cinquenta"),
 * conselho sem palavra-chave ("melhor esperar uns dias"), doença fora da lista. Isso é
 * dito de propósito: o detector é rede, não cura.
 *
 * ═══ Falso positivo custa pouco, mas custa ═══
 *
 * Um veto aqui não cala o paciente: o modelo reescreve uma vez, e se insistir o código
 * manda o aviso fixo e a conversa vai para a equipe (o caminho de "veto de qualidade").
 * Ainda assim, cada fala-modelo da spec e cada dado canônico (endereço, telefone,
 * horário, "MAPA 24h") está congelado como "não pode barrar" em
 * `tests/unit/limites-clinicos-detector.test.ts`.
 *
 * O resultado leva só RÓTULOS nossos (`tipos`, `regras`) — nunca o trecho casado, que é
 * texto do modelo e pode carregar dado do paciente.
 */

export type LimiteClinico = 'orientacao_medica' | 'preco';

export interface AchadoLimiteClinico {
  achou: boolean;
  /** orientação médica primeiro: é o risco maior quando os dois aparecem. */
  tipos: LimiteClinico[];
  /** rótulos das regras que casaram, na ordem declarada abaixo. */
  regras: string[];
}

/** Minúsculas, sem acento (NFD), espaços colapsados — mesmo preparo de `medical-emergency.ts`. */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/\s+/g, ' ');
}

/** Frases, para as regras que olham negação ("não consigo dizer se é virose"). */
function frases(texto: string): string[] {
  return texto.split(/[.!?;\n]+/).filter((f) => f.trim() !== '');
}

/**
 * A ocorrência está negada se, no trecho da frase ANTES dela e depois da última vírgula,
 * houver "não/nunca/nem". "Não consigo dizer se você tem virose" é recusa; "Não se
 * preocupe, provavelmente é virose" é diagnóstico (a vírgula separa a negação).
 */
function negada(frase: string, inicio: number): boolean {
  const antes = frase.slice(0, inicio);
  const ultimoTrecho = antes.slice(antes.lastIndexOf(',') + 1);
  return /\b(?:nao|nunca|nem)\b/.test(ultimoTrecho);
}

/** Casa em alguma frase sem negação antes da ocorrência. */
function casaSemNegacao(texto: string, re: RegExp): boolean {
  const global = new RegExp(re.source, 'g');
  for (const frase of frases(texto)) {
    for (const m of frase.matchAll(global)) {
      if (!negada(frase, m.index ?? 0)) return true;
    }
  }
  return false;
}

// ─── PREÇO (§4.3) ────────────────────────────────────────────────────────────

/**
 * Número que NÃO é dinheiro: hora, duração, data, telefone, contagem de coisa.
 * Aplicado logo depois do número inteiro (o `(?![.,]?\d)` impede casar só um pedaço
 * de "24h" ou de "99946-6060").
 */
const NAO_E_DINHEIRO =
  '(?![.,]?\\d)(?!\\s*(?:h\\b|hs\\b|hrs?\\b|horas?\\b|min|dias?\\b|anos?\\b|mes(?:es)?\\b|semanas?\\b|' +
  '%|x\\b|vez(?:es)?\\b|[:/)\\-]|de\\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|' +
  'outubro|novembro|dezembro)\\b|km\\b|metros?\\b|sess(?:ao|oes)\\b|consultas?\\b|exames?\\b|' +
  'especialidades\\b|colaboradores\\b|funcionarios\\b|pessoas\\b))';

const REGRAS_PRECO: ReadonlyArray<readonly [string, RegExp]> = [
  ['moeda', /r\$\s*\d/],
  ['reais', /\b\d[\d.,]*\s*(?:reais|real|contos?|pilas?)\b/],
  [
    'valor_numero',
    new RegExp(
      '\\b(?:valor(?:es)?|precos?|custa(?:m)?|custo|sai\\s+(?:por|a)|fica(?:m)?\\s+(?:em|por)|' +
        'cobra(?:mos|m)?|a\\s+partir\\s+de|investimento|mensalidade|por\\s+(?:apenas|so))\\b' +
        '[^.!?;:\\n\\d(]{0,30}(?<![\\d(])\\d+(?:[.,]\\d+)*' +
        NAO_E_DINHEIRO,
    ),
  ],
  [
    'gratuidade',
    /\b(?:consultas?|exames?|avaliac(?:ao|oes)|procedimentos?|sess(?:ao|oes)|atendimentos?|retornos?)\b[^.!?;\n]{0,20}\b(?:gratuit[oa]s?|gratis|de graca|sem custo|sem cobranca)\b/,
  ],
  ['desconto', /\b\d+\s*%\s*(?:de\s+)?(?:desconto|off)\b|\bdesconto\s+de\s+\d/],
  ['parcelas', /\bparcel\w*\s+em\s+(?:ate\s+)?\d|\bem\s+ate\s+\d{1,2}\s*x\b|\b\d{1,2}\s*x\s+(?:sem\s+juros|no\s+cartao)/],
];

// ─── ORIENTAÇÃO MÉDICA (§8.2) ────────────────────────────────────────────────

const DOENCAS =
  '(?:virose|gripe|resfriado|covid|dengue|zika|chikungunya|infeccao|inflamacao|alergia|rinite|sinusite|' +
  'enxaqueca|cefaleia|ansiedade|depressao|sindrome|panico|estresse|gastrite|refluxo|ulcera|hernia|tendinite|' +
  'bursite|artrose|artrite|diabetes|hipertensao|pressao (?:alta|baixa)|labirintite|calculo renal|' +
  'pedra no rim|cistite|otite|amigdalite|faringite|laringite|bronquite|pneumonia|asma|anemia|' +
  'hipotireoidismo|hipertireoidismo|tireoide|dermatite|micose|candidiase|conjuntivite|colica|intoxicacao|' +
  'distensao|entorse|fratura|lombalgia|ciatico|hemorroida|varizes|insonia|apneia|arritmia|taquicardia|' +
  'infarto|avc|derrame|epilepsia|demencia|alzheimer|parkinson|cancer|tumor|nodulo|cisto|alopecia|calvicie)';

const ABERTURA_DE_DIAGNOSTICO =
  '(?:provavelmente|possivelmente|talvez seja|deve ser|parece (?:ser|uma?|com)|pode ser|e provavel|' +
  'isso (?:e|indica|parece|sugere)|voce (?:tem|esta com|pode estar com|deve estar com|esta tendo)|' +
  '(?:seus|esses|estes|os) sintomas|sintomas? (?:de|tipicos? de|compativeis com|indicam)|sinais? de|' +
  'quadro de|caracteristic\\w* de)';

const REMEDIOS =
  '(?:remedios?|medicamentos?|medicac(?:ao|oes)|comprimidos?|antibioticos?|anti-?inflamatorios?|' +
  'analgesicos?|antialergicos?|antitermicos?|relaxante muscular|dipirona|paracetamol|ibuprofeno|' +
  'nimesulida|amoxicilina|azitromicina|omeprazol|buscopan|dorflex|novalgina|tylenol|neosaldina|xarope|' +
  'pomada|colirio|soro fisiologico|cha de|compressas?|bolsa de (?:gelo|agua quente)|gelo)';

const VERBO_DE_USO =
  '(?:tom(?:e|ar|a|ando)|us(?:e|ar|a)|apliqu?e|aplicar|pass(?:e|ar)|pingu?e|pingar|recomendo|recomendamos|' +
  'sugiro|indico|indicamos|experimente|faca uso|fazer uso)';

const ESPECIALISTAS =
  '(?:clinico geral|cardiologista|neurologista|psiquiatra|psicologo|psicologa|urologista|geriatra|' +
  'nutricionista|endocrinologista|ortopedista|dermatologista|gastro\\w*|cardiologia|neurologia|' +
  'psiquiatria|psicologia|urologia|geriatria|nutricao|especialista)';

/** [rótulo, regex, respeita negação?] */
const REGRAS_ORIENTACAO: ReadonlyArray<readonly [string, RegExp, boolean]> = [
  ['diagnostico', new RegExp(`\\b${ABERTURA_DE_DIAGNOSTICO}\\b[^,]{0,30}?\\b${DOENCAS}\\b`), true],
  ['remedio', new RegExp(`\\b${VERBO_DE_USO}\\b[^,]{0,40}?\\b${REMEDIOS}\\b`), true],
  ['dose', /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|ml|gotas|comprimidos?|capsulas?|ui)\b/, false],
  ['posologia', /\bde\s+\d+\s+em\s+\d+\s+h(?:oras|s)?\b|\b\d+\s+vez(?:es)?\s+(?:ao|por)\s+dia\b/, false],
  [
    'conduta',
    /\b(?:faca|fazer|mantenha|manter|fique de|ficar de)\s+repouso\b|\bbeba\s+(?:bastante\s+|muita\s+)?(?:agua|liquidos?)\b/,
    true,
  ],
  [
    'prognostico',
    /\bnao\s+(?:e|parece)\s+(?:nada\s+)?grave\b|\be\s+normal\s+(?:sentir|ter|doer|sangrar|inchar|ficar)\b|\b(?:isso|a dor|o sintoma|os sintomas)\s+(?:vai|vao|deve|devem|costuma|costumam)\s+passar\b|\bvai\s+passar\s+(?:sozinh|logo|em)/,
    false,
  ],
  [
    'especialista',
    new RegExp(
      `\\b(?:o (?:mais )?(?:ideal|indicado|recomendado|certo)|recomendo|sugiro|indico|o melhor)\\b[^.!?;\\n]{0,25}?\\b${ESPECIALISTAS}\\b`,
    ),
    true,
  ],
];

export function detectarLimiteClinico(body: string): AchadoLimiteClinico {
  const texto = normalizar(body);
  const regras: string[] = [];
  const tipos: LimiteClinico[] = [];

  const orientacao = REGRAS_ORIENTACAO.filter(([, re, respeitaNegacao]) =>
    respeitaNegacao ? casaSemNegacao(texto, re) : re.test(texto),
  ).map(([rotulo]) => rotulo);
  if (orientacao.length > 0) {
    tipos.push('orientacao_medica');
    regras.push(...orientacao);
  }

  const preco = REGRAS_PRECO.filter(([, re]) => re.test(texto)).map(([rotulo]) => rotulo);
  if (preco.length > 0) {
    tipos.push('preco');
    regras.push(...preco);
  }

  return { achou: tipos.length > 0, tipos, regras };
}

/** Razão devolvida ao modelo no veto de preço: a saída literal da spec §4.3. */
export const RAZAO_VETO_PRECO =
  'a clínica nunca informa preço, valor, faixa de preço nem "a partir de" — quem informa é a ' +
  'equipe. Tire todo valor da mensagem e diga, por exemplo: "Os valores variam conforme o ' +
  'procedimento e a forma de atendimento. Vou passar sua conversa para a nossa equipe, que te ' +
  'informa certinho."';

/** Razão devolvida ao modelo no veto de orientação médica: a saída literal da spec §8.3. */
export const RAZAO_VETO_ORIENTACAO =
  'o assistente não dá diagnóstico, não interpreta sintoma ou exame, não recomenda remédio, dose ' +
  'ou conduta e não escolhe especialista pela queixa. Tire a orientação e diga, por exemplo: ' +
  '"Essa é uma avaliação que só o profissional pode fazer, então não consigo te orientar por ' +
  'aqui. O que dá pra fazer é encaminhar você para a nossa equipe marcar uma consulta."';
