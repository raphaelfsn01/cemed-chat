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
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

/** Frases, para as regras que olham negação ("não consigo dizer se é virose"). */
function frases(texto: string): string[] {
  return texto.split(/[.!?;\n]+/).filter((f) => f.trim() !== '');
}

/** O que separa a negação do achado: pontuação de pausa ou uma adversativa. */
const QUEBRA_DE_TRECHO = /[,:;\p{Pd}]| mas | porem | entretanto | so que | e | entao | agora | porque | pois /gu;

/**
 * Negação que vale é RECUSA do assistente: "não consigo dizer se é virose", "não posso
 * indicar remédio". Qualquer outro "não" antes do achado não o anula — "não se preocupe
 * que provavelmente é virose" e "não deixe de tomar dipirona" são orientação (revisão de
 * 15/11: a versão anterior aceitava qualquer "não" e deixava essas passarem).
 */
const RECUSA =
  /\b(?:nao|nem)\s+(?:\w+\s+){0,2}?(?:consigo|posso|podemos|conseguimos|sei|da pra|da para|tenho como|temos como|e possivel|recomendo|indico|indicamos|receitamos|prescrevemos)\b/;

/**
 * A recusa só cobre a própria oração: "e", "então", "agora" a encerram ("não posso receitar
 * então tome uma dipirona" é orientação). E o "não" colado ao achado o nega por inteiro —
 * "não tome remédio sem orientação" é aviso de segurança, não receita (revisão de 15/11).
 */
function negada(frase: string, inicio: number): boolean {
  const antes = frase.slice(0, inicio);
  // "não ... além de / senão / a não ser" AFIRMA: "não deve ser nada além de uma virose".
  if (/\b(?:alem d|senao\b|a nao ser|exceto\b|so\s+(?:o|a|um|uma)\b)/.test(frase.slice(inicio))) return false;
  if (/\b(?:nao|nunca|nem)\s+$/.test(antes)) return true;
  let corte = 0;
  for (const q of antes.matchAll(QUEBRA_DE_TRECHO)) corte = (q.index ?? 0) + q[0].length;
  return RECUSA.test(antes.slice(corte));
}

/** Casa em alguma frase sem recusa antes da ocorrência. */
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
 * Um número inteiro (até 5 dígitos, ou milhar com ponto), nunca pedaço de outro: o
 * lookbehind impede começar no meio, e o `(?![.,]?\d)` impede parar no meio — sem isso a
 * regex recuava para casar só o "2" de "24h". Telefone (5+ dígitos seguidos) não cabe.
 */
const NUMERO = '(?<![\\d(.,])(?:\\d{1,3}(?:\\.\\d{3})+(?:,\\d{2})?|\\d{1,5}(?:[.,]\\d+)?)(?![.,]?\\d)';

/** Número que NÃO é dinheiro: hora, duração, data, telefone, ordinal, contagem de coisa. */
const NAO_E_DINHEIRO =
  '(?![aoªº°](?![a-z]))(?!\\s+\\d)(?!\\s*(?:[:)]|[/-]\\s*\\d|h\\b|hs\\b|hrs?\\b|horas?\\b|min|dias?\\b|anos?\\b|' +
  'mes(?:es)?\\b|semanas?\\b|%|x\\b|vez(?:es)?\\b|de\\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|' +
  'agosto|setembro|outubro|novembro|dezembro)\\b|km\\b|metros?\\b|andar(?:es)?\\b|salas?\\b|unidades?\\b|' +
  'vagas?\\b|sess(?:ao|oes)\\b|consultas?\\b|exames?\\b|especialidades\\b|colaboradores\\b|funcionarios\\b|' +
  // contagem perto de "valor" ("os 2 retornos", "com 2 profissionais", "dos 3 pacotes").
  // Lista NEGRA de propósito: uma lista de palavras PERMITIDAS depois do preço não fecha
  // ("150 pra consulta", "150 particular" escapavam — revisão de 15/11).
  'pessoas\\b|profissionais\\b|medic[oa]s\\b|pacotes?\\b|retornos\\b|procedimentos\\b|opcoes\\b|' +
  'tipos\\b|planos\\b|convenios\\b|itens\\b))';

/** "das 8 às 17": dois números de até 2 dígitos ligados por "às/a/até" são horário. */
const HORARIO_NAO = '(?!\\d{1,2}\\s+(?:as|a|ate)\\s+\\d{1,2}(?!\\d))';

const REGRAS_PRECO: ReadonlyArray<readonly [string, RegExp]> = [
  ['moeda', /r\$\s*\d/],
  // `(?<![\d.,])`: só começa no início do número — sem isso o custo era quadrático
  // ("1,1,1,..." de 60 mil caracteres levava 7,5 s).
  ['reais', /(?<![\d.,])\d[\d.,]*\s*(?:reais|real|contos?|pilas?)\b/],
  // Valor com centavos ("150,00", "1.500,00"): formato de preço por si só.
  // Hora com vírgula ("das 7,30 às 17,30", "8,30 da manhã") não é preço.
  [
    'centavos',
    /(?<![\d.,])(?<!\b(?:as|das|ate)\s)(?:\d{1,3}(?:\.\d{3})+|\d{1,5}),\d{2}(?![\d,])(?!\s*(?:%|km|kg|m\b|graus|h\b|horas|da\s+(?:manha|tarde|noite)|as\s+\d))/,
  ],
  [
    // Palavra de preço e o número na MESMA oração: a janela para na vírgula ("o valor,
    // ligue 22 99946..." não é preço). Os dois pontos ficam dentro ("Valor: 150").
    'valor_numero',
    new RegExp(
      '\\b(?:valor(?:es)?|precos?|custa(?:m)?|custo|cobra(?:mos|m)?|investimento|mensalidade)\\b' +
        '[^.!?;,\\n\\d(]{0,30}' +
        HORARIO_NAO +
        NUMERO +
        NAO_E_DINHEIRO,
    ),
  ],
  [
    // Locuções fracas ("fica por", "a partir de") só contam com o número LOGO depois —
    // "a partir de 2025" não é preço. "Fica em" saiu: é endereço ("fica em 152 na Rua
    // Mayer", "fica em 2 quarteirões"); "fica em 200 reais" a regra `reais` já pega.
    'locucao_numero',
    new RegExp(
      '\\b(?:sai(?:m)?\\s+(?:por|a)|fica(?:m)?\\s+por|a\\s+partir\\s+de|por\\s+(?:apenas|so))\\s+(?:r\\$\\s*)?' +
        '(?!(?:19|20)\\d\\d(?!\\d))' +
        HORARIO_NAO +
        NUMERO +
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

/**
 * Abertura de diagnóstico. Fora de propósito (revisão de 15/11): "você tem", "você está
 * com", "os sintomas de" — casavam pergunta e catálogo legítimos ("você tem alergia a
 * contraste?", "os sintomas de ansiedade são avaliados pelo psiquiatra").
 */
const ABERTURA_DE_DIAGNOSTICO =
  '(?:provavelmente|possivelmente|talvez seja|deve ser|parece (?:ser|uma?|com)|pode ser|e provavel|' +
  'isso (?:e|indica|parece|sugere)|voce (?:pode|deve) estar com|voce esta tendo|' +
  '(?:seus|esses|estes) sintomas|pelos sintomas|sintomas? (?:tipicos? de|compativeis com|indicam)|' +
  'sinais? de|quadro de|caracteristic\\w* de)';

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

/** [rótulo, regex, respeita recusa?] */
const REGRAS_ORIENTACAO: ReadonlyArray<readonly [string, RegExp, boolean]> = [
  // "Provavelmente, é virose": a vírgula logo após a abertura não separa o diagnóstico.
  ['diagnostico', new RegExp(`\\b${ABERTURA_DE_DIAGNOSTICO}\\b(?:\\s*,)?[^,]{0,30}?\\b${DOENCAS}\\b`), true],
  ['remedio', new RegExp(`\\b${VERBO_DE_USO}\\b[^,]{0,40}?\\b${REMEDIOS}\\b`), true],
  ['dose', /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|ml|gotas|comprimidos?|capsulas?|ui)\b/, false],
  ['posologia', /\bde\s+\d+\s+em\s+\d+\s+h(?:oras|s)?\b|\b\d+\s+vez(?:es)?\s+(?:ao|por)\s+dia\b/, false],
  [
    'conduta',
    /\b(?:faca|fazer|mantenha|manter|fique de|ficar de)\s+repouso\b|\bbeba\s+(?:bastante\s+|muita\s+)?(?:agua|liquidos?)\b/,
    true,
  ],
  [
    // "É normal ficar ansioso antes do exame" é acolhimento; "é normal doer/ter febre" é
    // prognóstico de sintoma.
    'prognostico',
    /\bnao\s+(?:e|parece)\s+(?:nada\s+)?grave\b|\be\s+normal\s+(?:sentir|doer|sangrar|inchar)\b|\be\s+normal\s+ter\s+(?:dor|febre|sangramento|inchaco|tontura|enjoo|nausea|formigamento)\b|\b(?:isso|a dor|o sintoma|os sintomas)\s+(?:vai|vao|deve|devem|costuma|costumam)\s+passar\b|\bvai\s+passar\s+(?:sozinh|logo|em)/,
    false,
  ],
  [
    'especialista',
    new RegExp(
      `\\b(?:o (?:mais )?(?:ideal|indicado|recomendado|certo)|recomendo|sugiro|indico|o melhor|procur(?:e|ar))\\b[^.!?;\\n]{0,25}?\\b${ESPECIALISTAS}\\b`,
    ),
    true,
  ],
];

export function detectarLimiteClinico(body: string): AchadoLimiteClinico {
  const texto = normalizar(body);
  const regras: string[] = [];
  const tipos: LimiteClinico[] = [];

  const orientacao = REGRAS_ORIENTACAO.filter(([, re, respeitaRecusa]) =>
    respeitaRecusa ? casaSemNegacao(texto, re) : re.test(texto),
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

/** Razão devolvida ao modelo no veto de preço: a fala da spec §4.3, inteira. */
export const RAZAO_VETO_PRECO =
  'a clínica nunca informa preço, valor, faixa de preço nem "a partir de" — quem informa é a ' +
  'equipe. Tire todo valor da mensagem e diga, por exemplo: "Os valores variam conforme o ' +
  'procedimento e a forma de atendimento. Vou passar sua conversa para a nossa equipe, que te ' +
  'informa certinho. Pode me confirmar seu nome?"';

/** Razão devolvida ao modelo no veto de orientação médica: a fala da spec §8.3, inteira. */
export const RAZAO_VETO_ORIENTACAO =
  'o assistente não dá diagnóstico, não interpreta sintoma ou exame, não recomenda remédio, dose ' +
  'ou conduta e não escolhe especialista pela queixa. Tire a orientação e diga, por exemplo: ' +
  '"Essa é uma avaliação que só o profissional pode fazer, então não consigo te orientar por ' +
  'aqui. O que dá pra fazer é encaminhar você para a nossa equipe marcar uma consulta — quer que ' +
  'eu faça isso?"';
