/**
 * Gate determinístico de EMERGÊNCIA MÉDICA (spec da clínica, §10.1).
 *
 * Por que existe, e por que NÃO é `handoff_keywords`: casar uma palavra-chave de
 * handoff faz o turno chamar `performHumanHandoff` e dar `return` — "bot silencia:
 * sem modelo, sem envio". Para um pedido de atendente isso é correto. Para quem
 * escreve "estou com dor no peito" é o pior desfecho possível: a pessoa recebe
 * SILÊNCIO em vez da orientação de procurar urgência, e fora do horário espera até
 * o próximo dia útil. Emergência precisa do caminho oposto — RESPONDER primeiro,
 * escalar depois.
 *
 * Duas classes, porque a conduta difere: `clinical` orienta 192/SAMU; `self_harm`
 * acrescenta o CVV 188. `self_harm` vence quando os dois casam.
 *
 * Detecção por regex sobre texto normalizado (NFD, sem acento), MESMO padrão de
 * `human-handoff.ts`. Sem fuzzy de propósito: aproximação em termo clínico produz
 * falso positivo, e falso positivo aqui custa caro — a escalação seta
 * `contacts.force_human`, que o agente não reverte (regra dura 2).
 */

/** Emergência clínica (192) vs. risco de autolesão (192 + CVV 188). */
export type EmergencyKind = 'clinical' | 'self_harm';

/** Normaliza para a detecção: minúsculas + sem acento (NFD). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
}

/**
 * Sinais de emergência clínica do §10.1. Escritos sem acento (rodam sobre o texto
 * normalizado) e ancorados em `\b` para não casar dentro de outra palavra.
 */
const CLINICAL_PATTERNS: readonly RegExp[] = [
  // dor/aperto/pressão no peito — o sintoma que mais chega e o mais time-sensitive
  /\b(?:dor|dores|aperto|pressao|peso|queimacao)\s+(?:muito\s+|forte\s+|horrivel\s+)?(?:no|em\s+meu|no\s+meu)\s+peito\b/,
  /\bdor\s+toracica\b/,
  // falta de ar
  /\bfalta\s+de\s+ar\b/,
  /\b(?:nao|n)\s+(?:estou|to|consigo|to\s+conseguindo)\s+(?:conseguindo\s+)?respirar\b/,
  /\bsufocad[oa]\b/,
  /\bfalta\s+de\s+folego\b/,
  // desmaio / perda de consciencia
  /\bdesmai(?:ei|ou|ando|o)\b/,
  /\bperdi\s+a\s+consciencia\b/,
  /\bapaguei\b/,
  // irresponsividade — pessoa que não acorda/não responde é inconsciência até prova
  // em contrário. Faltava, e o teste de 1ª pessoa no presente pegou.
  /\bnao\s+(?:consigo\s+)?acord(?:a|ar)\b/,
  /\bnao\s+(?:esta\s+)?respond(?:e|endo)\b/,
  /\bdesacordad[oa]\b/,
  /\bdesmaiad[oa]\b/,
  // sangramento intenso
  /\bsangrando\s+(?:muito|sem\s+parar|demais)\b/,
  /\bhemorragia\b/,
  /\bperdendo\s+muito\s+sangue\b/,
  // sinais de AVC
  /\bboca\s+(?:torta|entortou|torceu)\b/,
  /\bfala\s+(?:enrolada|embolada|arrastada)\b/,
  /\b(?:dormencia|fraqueza|formigamento)\s+(?:de|em|do|no)\s+um\s+lado\b/,
  /\bnao\s+(?:consigo|to\s+conseguindo)\s+mexer\s+(?:o|meu)\s+(?:braco|lado|rosto)\b/,
  /\bderrame\s+cerebral\b/,
  // convulsao
  /\bconvuls(?:ao|oes|ionando|ionou)\b/,
  /\bataque\s+epilep(?:tico|sia)\b/,
  // intoxicacao / envenenamento / overdose
  /\bintoxica(?:cao|do|da)\b/,
  /\benvenenad[oa]\b/,
  /\btomei\s+veneno\b/,
  /\boverdose\b/,
  // acidente grave
  /\bacidente\s+(?:grave|de\s+carro|de\s+moto|de\s+transito)\b/,
  /\bfui\s+atropelad[oa]\b/,
  // infarto/AVC declarados em 1a pessoa no presente (o filtro de contexto abaixo
  // cuida do caso "meu pai teve um AVC ano passado")
  /\b(?:estou|to)\s+(?:tendo|com)\s+(?:um\s+)?(?:infarto|avc|derrame)\b/,
];

/** Sinais de ideação suicida ou autolesão — conduta diferente (acrescenta CVV 188). */
const SELF_HARM_PATTERNS: readonly RegExp[] = [
  /\b(?:quero|vou|penso\s+em|pensando\s+em)\s+(?:me\s+)?(?:matar|suicidar)\b/,
  /\bsuicid(?:io|ar|ando)\b/,
  /\btirar\s+(?:a\s+)?minha\s+vida\b/,
  /\bacabar\s+com\s+(?:a\s+)?minha\s+vida\b/,
  /\bnao\s+(?:quero|aguento)\s+mais\s+viver\b/,
  /\bmelhor\s+(?:eu\s+)?(?:morrer|sumir)\b/,
  /\b(?:me\s+)?cortar\s+(?:os\s+pulsos|os\s+bracos)\b/,
  /\bme\s+(?:machucar|ferir|cortar)\b/,
  /\bpensamentos?\s+suicidas?\b/,
];

/**
 * Marcadores de PASSADO ou de TERCEIRO — a fonte nº 1 de falso positivo numa clínica,
 * onde histórico clínico é assunto legítimo de agendamento ("meu pai teve um AVC no
 * ano passado, quero marcar neurologista"). Anulam o match, salvo se houver marcador
 * de 1ª pessoa no presente (PRESENT_MARKERS).
 */
const PAST_OR_THIRD_PARTY: readonly RegExp[] = [
  // sem acento de propósito: rodam sobre o texto já normalizado ("avó" chega como "avo")
  /\b(?:meu|minha)\s+(?:pai|mae|filh[oa]|marido|espos[ao]|avo|irma[oa]?|ti[oa]|sogr[ao]|amig[oa]|vizinh[oa]|paciente)\b/,
  /\b(?:ano|mes|semana)\s+passad[oa]\b/,
  /\bja\s+(?:tive|teve|tinha)\b/,
  /\bhistorico\s+de\b/,
  /\bsequela\b/,
  /\bteve\s+(?:um|uma)?\s*(?:avc|infarto|derrame|convulsao)\b/,
  /\b(?:quero|preciso|gostaria\s+de)\s+(?:marcar|agendar|remarcar)\b/,
  /\b(?:exame|consulta)\s+(?:admissional|demissional|periodic[oa]|ocupacional)\b/,
  /\bacidente\s+de\s+trabalho\b/,
];

/**
 * Marcadores de 1ª pessoa no presente. Vencem o filtro acima: "socorro, meu pai está
 * aqui e eu não consigo respirar" precisa disparar mesmo mencionando um terceiro.
 */
const PRESENT_MARKERS: readonly RegExp[] = [
  /\b(?:estou|to)\s+(?:com|sentindo|tendo)\b/,
  /\bsocorro\b/,
  /\bagora\s+(?:mesmo|ha\s+pouco)\b/,
  /\burgente\b/,
  /\bemergencia\b/,
  /\bnao\s+(?:consigo|aguento)\b/,
  /\bme\s+ajuda\b/,
];

/**
 * Detecta emergência médica na mensagem do lead. Devolve a classe (para escolher a
 * conduta) ou `null`.
 *
 * `self_harm` é avaliado primeiro e vence: a conduta dele é superconjunto da clínica
 * (192 + CVV), então em caso de sobreposição errar para o lado mais protetivo é o certo.
 */
export function detectMedicalEmergency(message: string): EmergencyKind | null {
  if (message.trim() === '') return null;
  const normalized = normalize(message);

  const selfHarm = SELF_HARM_PATTERNS.some((re) => re.test(normalized));
  const clinical = CLINICAL_PATTERNS.some((re) => re.test(normalized));
  if (!selfHarm && !clinical) return null;

  // Filtro de contexto: passado/terceiro anula, a menos que haja sinal de 1ª pessoa
  // no presente. Aplicado às DUAS classes — "minha mãe se matou ano passado" é relato
  // de luto, assunto de psicologia, não emergência em curso.
  const isPastOrThirdParty = PAST_OR_THIRD_PARTY.some((re) => re.test(normalized));
  const isPresentFirstPerson = PRESENT_MARKERS.some((re) => re.test(normalized));
  if (isPastOrThirdParty && !isPresentFirstPerson) return null;

  return selfHarm ? 'self_harm' : 'clinical';
}

/**
 * Textos padrão, literais da spec §10.1. Ficam em código (e não em config de tenant)
 * porque são rede de segurança de produto: versionados, testáveis, e nenhum operador
 * os enfraquece por engano. O override por tenant existe para AJUSTAR a redação — o
 * gate em si não depende dele.
 */
export const EMERGENCY_MESSAGES: Record<EmergencyKind, string> = {
  clinical:
    'Pelo que você descreveu, é importante buscar atendimento de urgência agora, não esperar por consulta. ' +
    'Ligue 192 (SAMU) ou vá ao pronto-socorro mais próximo. ' +
    'Somos uma clínica de consultas e exames e não fazemos atendimento de emergência.',
  self_harm:
    'Pelo que você descreveu, é importante buscar ajuda agora, não esperar por consulta. ' +
    'Ligue 192 (SAMU) ou vá ao pronto-socorro mais próximo. ' +
    'Você também pode falar com o CVV no 188, gratuito e 24 horas. ' +
    'Somos uma clínica de consultas e exames e não fazemos atendimento de emergência.',
};
