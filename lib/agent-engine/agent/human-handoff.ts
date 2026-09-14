/**
 * Handoff humano como cidadão de 1ª classe (F4-06; blueprint 5.5 — escalação humana
 * clara e imediata é EXIGÊNCIA fiscalizada da Meta, não fallback). Dois gatilhos, uma
 * ação idempotente:
 *   1. DETERMINÍSTICO — regex PT-BR na última mensagem do lead ("falar com atendente",
 *      "quero falar com uma pessoa"…). Roda no runtime ANTES do modelo: o turno vira
 *      NO-OP (o bot silencia, não gasta LLM nem envia).
 *   2. TOOL request_human_handoff — o modelo aciona quando percebe o limite da automação.
 *
 * A ação (performHumanHandoff), idempotente e at-least-once — TUDO no mesmo banco agora
 * (a fusão matou o transporte MCP):
 *   (a) FONTE DA VERDADE: contacts.force_human=true — irrevogável (regra dura 2);
 *   (b) conversa: status transiciona SÓ 'ai_handling'→'pending' (CASE — nunca pisa em
 *       claimed/closed) + bot_silenced_until='infinity' + last_handoff_at/reason;
 *   (c) cancela os crons PENDENTES do lead (follow-ups agendados não disparam após handoff);
 *   (d) cria agent_inbox_items(kind='handoff') com o resumo (dedup por episódio aberto).
 *
 * tenant/lead/conversation vêm da ROW do job (closure do run), NUNCA do payload (regra dura 1).
 * O resumo vai ao inbox (é PARA o humano assumir) — mas NUNCA a log (PII fora de log, regra 8).
 */
import { z } from 'zod';
import type pg from 'pg';

import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';

import type { Logger } from '../obs/logger';
import { cancelPendingCronsForLead } from '../cron/scheduler';
import { findForbiddenKey, zodIssuesSummary } from './lead-state';

/** Postgres `infinity`: o bot nunca reassume após handoff. */
const SILENCE_INFINITY = 'infinity';

/**
 * Normaliza para a detecção determinística: minúsculas + sem acento (NFD) — os padrões
 * abaixo são escritos sem acento, então "atendente"/"consultor" casam com/sem diacrítico.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
}

/**
 * Padrões PT-BR CONSERVADORES de pedido explícito de atendimento humano (evita falso
 * positivo: exige o verbo de contato + o alvo humano, ou expressões inequívocas). Rodam
 * sobre o texto normalizado (sem acento).
 */
const HUMAN_HANDOFF_PATTERNS: readonly RegExp[] = [
  /\b(?:falar|conversar)\s+com\s+(?:um[a]?\s+)?(?:atendente|humano|pessoa|gente|consultor|vendedor|representante|responsavel)\b/,
  /\bme\s+(?:passa|passe|transfere|transfira|encaminha|encaminhe|manda|mande)\s+(?:pra|para|pro)\s+(?:um[a]?\s+)?(?:atendente|humano|pessoa|gente|setor|comercial)\b/,
  /\batendimento\s+humano\b/,
  /\b(?:atendente|humano|pessoa)\s+de\s+verdade\b/,
];

/** True se a mensagem do lead é um pedido explícito de atendimento humano (determinístico). */
export function detectHumanHandoffRequest(message: string): boolean {
  if (message.trim() === '') return false;
  const normalized = normalize(message);
  return HUMAN_HANDOFF_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Palavra-chave de opt-out enviada SOZINHA (mensagem inteira = a palavra) — a convenção
 * universal de descadastro em canais de mensagem. Comparação sobre o texto normalizado
 * e trimado (sem acento/pontuação de borda) para não vetar frases que só CONTÊM a palavra
 * ("vou parar por aqui, valeu" não casa; "PARAR" sozinho casa).
 */
const OPTOUT_KEYWORDS: ReadonlySet<string> = new Set([
  'stop',
  'parar',
  'pare',
  'sair',
  'cancelar',
  'descadastrar',
  'remover',
  'unsubscribe',
]);

/**
 * Frases PT-BR de opt-out AMBÍGUO ("para de me mandar isso", "não quero mais receber",
 * "me tira da lista"): não são bloqueio formal no CRM, mas na dúvida tratamos como STOP
 * (F4-07). CONSERVADORAS o bastante para não silenciar um lead vivo por engano, mas a
 * política é "na dúvida, PARA e escala" — o humano confirma o is_blocked real no CRM.
 * Rodam sobre o texto normalizado (sem acento).
 */
const AMBIGUOUS_OPTOUT_PATTERNS: readonly RegExp[] = [
  /\bpar(?:a|e|em)\s+de\s+me\s+(?:mandar|manda|mande|enviar|envia|envie|perturbar|encher)\b/,
  // "receber" seguido de um CANAL (ligação/chamada/telefonema) é troca-de-canal, não opt-out:
  // "não quero receber ligação, só whatsapp" QUER continuar no WhatsApp — não silenciar.
  /\bnao\s+(?:quero|desejo|gostaria)\s+(?:de\s+)?(?:mais\s+)?receber\b(?!\s+(?:ligacao|ligacoes|chamada|chamadas|telefonema|telefonemas|telefone)\b)/,
  /\bnao\s+quero\s+receber\s+mais\b/,
  /\bnao\s+me\s+(?:mande|manda|mandem|envie|envia|enviem)\s+mais\b/,
  /\bme\s+(?:tira|tire|tirem|remove|remova|removam|retira|retire|exclui|exclua)\s+(?:da|dessa|desta|de\s+sua|da\s+sua)\s+lista\b/,
  /\bsair\s+da\s+lista\b/,
  /\bcancelar?\s+(?:a\s+)?inscricao\b/,
  /\bme\s+descadastr\w*\b/,
];

/**
 * True se a última mensagem do lead SUGERE opt-out (palavra-chave sozinha OU frase
 * ambígua). Sinal CONSERVADOR: na dúvida vira STOP + escala à inbox (F4-07). NÃO é a
 * fonte da verdade (o CRM/is_blocked é); serve para PARAR de responder já e alertar o
 * humano, que confirma o bloqueio real.
 */
export function detectAmbiguousOptOut(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed === '') return false;
  const normalized = normalize(trimmed);
  // palavra-chave isolada: só letras (remove pontuação de borda como "STOP." / "SAIR!")
  const bareWord = normalized.replace(/[^a-z]/gu, '');
  if (OPTOUT_KEYWORDS.has(bareWord)) return true;
  return AMBIGUOUS_OPTOUT_PATTERNS.some((re) => re.test(normalized));
}

/**
 * NO-OP de runs futuros (acceptance 2): o lead está em handoff quando force_human está
 * setado no contato OU alguma conversa dele ainda está silenciada (bot_silenced_until no
 * futuro — 'infinity' sempre vale). Lido no INÍCIO do turno, antes de qualquer chamada
 * de modelo. Só o humano (via CRM) libera.
 */
export async function isLeadInHandoff(db: pg.Pool, tenantId: string, leadId: string): Promise<boolean> {
  const { rows } = await db.query<{ handoff: boolean }>(
    `select (
       c.force_human
       or exists (
         select 1 from conversations v
         where v.organization_id = $1 and v.contact_id = c.id
           and v.bot_silenced_until is not null and v.bot_silenced_until > now()
       )
     ) as handoff
     from contacts c
     where c.organization_id = $1 and c.id = $2`,
    [tenantId, leadId],
  );
  return rows[0]?.handoff === true;
}

export interface HandoffIds {
  tenantId: string;
  leadId: string;
  /** conversations.id — a conversa que transiciona para a fila humana. */
  conversationId: string;
}

/**
 * Executa o handoff (idempotente, at-least-once) — tudo no banco do CRM, sem transporte.
 * Re-executar no mesmo episódio é no-op semântico: force_human/silêncio já setados, o
 * CASE do status não pisa em estado humano (claimed/closed) e o inbox deduplica.
 */
export async function performHumanHandoff(
  db: pg.Pool,
  ids: HandoffIds,
  opts: { reason: string; conversationSummary: string; inboxTitle?: string; log: Logger },
): Promise<void> {
  // (a) FONTE DA VERDADE: force_human no contato — irrevogável pelo agente (regra dura 2).
  await db.query(`update contacts set force_human = true where organization_id = $1 and id = $2`, [
    ids.tenantId,
    ids.leadId,
  ]);

  // (b) Conversa: silencia o bot para sempre e devolve à fila humana. O status SÓ
  // transiciona 'ai_handling'→'pending' — conversa já claimed/closed/pending fica como
  // está (nunca rouba do humano nem reabre encerrada). Fase 3: junto, zera a aderência
  // ao agente do router — se o bot for reativado, o router decide de novo (não reassume
  // o mesmo agente por inércia).
  await db.query(
    `update conversations
        set status = case when status = 'ai_handling' then 'pending' else status end,
            bot_silenced_until = $3,
            last_handoff_at = now(),
            last_handoff_reason = $4,
            active_ai_agent_id = null,
            active_intent = null,
            active_agent_set_at = null
      where organization_id = $1 and id = $2`,
    [ids.tenantId, ids.conversationId, SILENCE_INFINITY, opts.reason],
  );

  // (c) Cancela os crons PENDENTES do lead (follow-ups agendados — F3-01/02). Idempotente,
  // via o cancel compartilhado (mesma garantia que o opt-out irrevogável usa — F4-07).
  await cancelPendingCronsForLead(db, ids.tenantId, ids.leadId);

  // (d) inbox de escalação com o resumo da conversa. Dedup por episódio ABERTO (mesmo padrão
  // do escalateJailbreakPromise): 2× no mesmo handoff aberto → 1 item.
  await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'handoff', 'critical', $2, $3, 'contact', $4
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and kind = 'handoff' and ref_kind = 'contact' and ref_id = $4 and status = 'open'
     )`,
    [
      ids.tenantId,
      opts.inboxTitle ?? 'Handoff humano solicitado — assumir a conversa',
      `Motivo: ${opts.reason}. Resumo da conversa até aqui:\n${opts.conversationSummary}`,
      ids.leadId,
    ],
  );

  // (e) A IDA na linha do tempo do NEGÓCIO. `triggerHandoff` (o caminho do CRM)
  // já gravava `handoff_triggered`; este caminho — o do harness e o do "Assumir
  // eu" dos casos — não gravava nada. Metade das passagens era invisível no
  // dossiê do cliente, e quem lesse a timeline veria a volta sem a ida.
  //
  // O `reason` é FIXO de propósito: `opts.reason` pode ser o texto livre que o
  // atendente escreveu ao escalar, e esta linha aparece na tela e no export de
  // LGPD (regra do activity-emitter: o porquê é legível, sem PII).
  //
  // Try/catch porque a timeline não pode derrubar a operação que ela descreve —
  // mesma disciplina fire-and-forget do emissor da API.
  try {
    const roteou = await emitAgentActivityForContact({
      pool: db,
      organizationId: ids.tenantId,
      contactId: ids.leadId,
      type: 'handoff_triggered',
      sourceModule: 'human-handoff',
      sourceId: ids.conversationId,
      reason: 'Atendimento passado para uma pessoa',
      payload: { conversation_id: ids.conversationId },
    });
    if (!roteou.routed) {
      opts.log.warn('handoff: atividade não roteada para um negócio', { reason: roteou.reason });
    }
  } catch (err) {
    opts.log.warn('handoff: atividade da passagem não foi gravada', {
      error: err instanceof Error ? err.message.slice(0, 200) : 'erro desconhecido',
    });
  }

  // PII fora do log: só ids/motivo — nunca o resumo da conversa (regra dura 8).
  opts.log.info('handoff humano aplicado (force_human + silêncio + crons cancelados + inbox)', {
    reason: opts.reason,
  });
}

/**
 * Transferência pedida pelo modelo antes de avisar o paciente — o defeito que isto fecha.
 *
 * A transferência marca `contacts.force_human`, e o gate de envio (stop, before-send.ts)
 * lê isso a cada mensagem: depois de transferir, NADA mais sai. É a regra dura nº 2, e
 * está certa. Só que a resposta desta tool (ACH-03) mandava o modelo avisar o cliente
 * DEPOIS de transferir ("sem mensagens além do aviso") — e esse aviso era sempre barrado.
 * Medido no benchmark de modelos (set/2026), com tool e gate iguais aos de produção: na
 * urgência ("dor no peito"), o Gemini 2.5 Flash transferiu primeiro e tentou avisar depois
 * em 5 de 5 execuções — o paciente não recebeu mensagem nenhuma.
 *
 * A regra: sem tentativa de aviso no turno, a PRIMEIRA chamada é recusada com uma
 * instrução e com a disponibilidade real da equipe — que é o que o aviso precisa dizer (a
 * intenção da ACH-03, agora no momento em que ainda dá para usar). A SEGUNDA chamada nunca
 * é recusada: chegar a um humano não pode depender de o modelo acertar a ordem. Tentou
 * avisar e o envio falhou (canal fora, gate)? Transfere direto, pelo mesmo motivo.
 */
export interface EstadoDoAviso {
  /** houve send_message neste turno — enviado ou não, o que conta é a tentativa */
  tentou: boolean;
  /** esta tool já recusou uma vez neste turno */
  jaRecusou: boolean;
}

export function transferenciaPrecisaDeAviso(estado: EstadoDoAviso): boolean {
  return !estado.tentou && !estado.jaRecusou;
}

/**
 * A transferência foi recusada por falta de aviso e o modelo NÃO a refez — o runtime a
 * conclui no fim do turno. Medido no benchmark (set/2026): o modelo obedece à recusa,
 * avisa "vou passar para a equipe"... e às vezes para aí — o paciente ouve a promessa e
 * ninguém da equipe é acionado. Quando o runtime conclui, o aviso já saiu: a ordem
 * aviso → transferência continua garantida.
 */
export function transferenciaPendente(estado: { jaRecusou: boolean; transferiu: boolean }): boolean {
  return estado.jaRecusou && !estado.transferiu;
}

export function mensagemAviseAntes(fraseDaEquipe: string): string {
  return (
    'Transferência NÃO feita ainda: avise o paciente primeiro. Envie UMA mensagem curta com ' +
    'send_message dizendo que vai passar a conversa para a equipe e, depois, chame ' +
    'request_human_handoff de novo — depois da transferência nenhuma mensagem chega a ele. ' +
    `Situação da equipe agora, para o aviso ser verdadeiro: ${fraseDaEquipe}`
  );
}

/** Resposta da transferência feita. Sem convite a "avisar depois": o gate o barraria. */
export const MENSAGEM_HANDOFF_ACIONADO =
  'Handoff humano acionado; a conversa saiu do atendimento automático. ' +
  'Encerre o turno AGORA — a partir daqui nenhuma mensagem chega ao paciente.';

/** Whitelist EXATA do payload da tool (mesmo padrão .strict() da F2-10/F3-02). */
export const requestHumanHandoffInputSchema = z.strictObject({
  reason: z.string().min(1).max(500).optional(),
});

const PAYLOAD_TEACHING =
  'Campo aceito: reason (por que passar ao humano) — opcional, nada além. Lead, organização e ' +
  'conversa vêm do runtime, nunca do payload da tool.';

export type RequestHumanHandoffResult =
  | { ok: true; status: 'handoff_solicitado'; message: string }
  | { ok: false; error: { code: 'invalid_payload' | 'avise_antes'; message: string } };

/**
 * Wrapper da tool request_human_handoff exposta ao modelo. Valida o payload e delega a
 * performHumanHandoff. Erros de DB (ex.: lead sumiu) sobem — o tool wrapper do run os
 * captura e ensina o modelo a encerrar (padrão F2-09).
 */
export async function applyRequestHumanHandoff(
  db: pg.Pool,
  ids: HandoffIds,
  opts: { conversationSummary: string; log: Logger; aviso: EstadoDoAviso },
  rawInput: unknown,
): Promise<RequestHumanHandoffResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return { ok: false, error: { code: 'invalid_payload', message: `campos não reconhecidos: ${forbidden}. ${PAYLOAD_TEACHING}` } };
  }
  const parsed = requestHumanHandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_payload', message: `payload inválido em request_human_handoff (${zodIssuesSummary(parsed.error)}). ${PAYLOAD_TEACHING}` } };
  }

  // O aviso ao paciente tem de sair ANTES: a transferência marca force_human e o gate de
  // envio recusa qualquer mensagem depois dela. Ver transferenciaPrecisaDeAviso.
  if (transferenciaPrecisaDeAviso(opts.aviso)) {
    const { frase } = await expectativaDeAtendimento(db, ids.tenantId, new Date());
    return { ok: false, error: { code: 'avise_antes', message: mensagemAviseAntes(frase) } };
  }

  await performHumanHandoff(db, ids, {
    reason: parsed.data.reason ?? 'requested_human',
    conversationSummary: opts.conversationSummary,
    log: opts.log,
  });

  // ACH-03: a expectativa real da equipe continua chegando ao modelo — mas na RECUSA
  // acima, antes do aviso, que é quando ele ainda consegue repassá-la. Aqui, depois de
  // transferir, nenhuma mensagem sai; a resposta não convida a tentar.
  return { ok: true, status: 'handoff_solicitado', message: MENSAGEM_HANDOFF_ACIONADO };
}

/**
 * Resumo curto da conversa para o inbox de escalação — a partir do checkpoint durável
 * (compromissos/objeções/próxima ação/resumo). Vai ao inbox (PARA o humano), nunca a log.
 */
export function buildHandoffSummary(
  previous: {
    commitments: string[];
    objections: string[];
    next_action: string | null;
    rolling_summary: string;
  } | null,
): string {
  if (previous === null) {
    return 'Sem resumo acumulado ainda (conversa recente) — abra a conversa no CRM para o contexto completo.';
  }
  const parts: string[] = [];
  if (previous.rolling_summary.trim() !== '') parts.push(previous.rolling_summary.trim());
  if (previous.commitments.length > 0) parts.push(`Compromissos: ${previous.commitments.join('; ')}`);
  if (previous.objections.length > 0) parts.push(`Objeções: ${previous.objections.join('; ')}`);
  if (previous.next_action) parts.push(`Próxima ação: ${previous.next_action}`);
  return parts.length === 0
    ? 'Sem resumo acumulado ainda (conversa recente) — abra a conversa no CRM para o contexto completo.'
    : parts.join('\n');
}
