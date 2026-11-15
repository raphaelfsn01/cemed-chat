/**
 * Aviso de transferência na abertura da janela (PR-1b).
 *
 * Fora da janela de envio (22h–7h e domingo) nada pode sair para o paciente. Até aqui, quando
 * o turno terminava em transferência nesse horário — o paciente pediu atendente, ou o modelo
 * transferiu depois de ter a resposta barrada —, a conversa ia para a equipe e o paciente não
 * recebia NADA. Caso real: 15/11/2026 13h13 BRT (domingo), "estou com dor no peito e falta de
 * ar".
 *
 * Decisão do Raphael (15/11): a transferência acontece na hora (a equipe é avisada em
 * Alertas) e o paciente recebe um aviso fixo na abertura da janela — só se ninguém da equipe
 * tiver respondido antes (`conversaJaRespondida`). O aviso é texto do código, nunca do modelo,
 * e passa pela cadeia inteira: só o veto `handoff_ativo` do gate `stop` é dispensado para ele
 * (o opt-out continua irrevogável).
 *
 * O agendamento é um `inbound_turn` one-shot com `aviso_de_transferencia` no payload: o
 * handler do turno o reconhece e manda só o aviso, sem chamar o modelo.
 */

import type pg from 'pg';

import { scheduleCronJob } from '../cron/scheduler';
import type { QuemPodeAssumir } from '@/lib/escalacao/disponibilidade';

/**
 * Texto do aviso na abertura. Sem prazo e sem hora (spec §11.2: "nunca prometer horário de
 * retorno específico"); a segunda frase só diz o que a disponibilidade medida sustenta.
 */
export function mensagemDeTransferenciaFeita(quem: QuemPodeAssumir | null): string {
  const base = 'Recebemos sua mensagem e passamos sua conversa para a nossa equipe.';
  return quem !== null && quem.disponiveis > 0
    ? `${base} Ela continua o atendimento em seguida.`
    : `${base} A equipe retorna assim que possível.`;
}

/**
 * Agenda UM aviso por conversa para `at` (a abertura informada pelo veto `outside_window`, já
 * com jitter). Se já há um pendente para a conversa, não cria outro: o paciente recebe um aviso
 * só, por mais transferências que a noite tenha. Devolve `true` se criou.
 *
 * O payload é o do turno de origem (é ele que diz por onde responder), sem `reschedule_of`:
 * o aviso não é um turno reagendado, e as duas marcas no mesmo job confundiriam o handler.
 */
export async function agendarAvisoDeTransferencia(
  pool: pg.Pool,
  input: {
    tenantId: string;
    leadId: string;
    conversationId: string;
    jobId: string;
    at: Date;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1 from cron_jobs
      where organization_id = $1 and contact_id = $2
        and enabled = true and job_kind = 'inbound_turn'
        and payload ? 'aviso_de_transferencia'
        and payload->>'conversation_id' = $3`,
    [input.tenantId, input.leadId, input.conversationId],
  );
  if (rowCount !== null && rowCount > 0) return false;
  const { reschedule_of: _reagendamento, aviso_de_transferencia: _avisoAnterior, ...origem } = input.payload;
  await scheduleCronJob(pool, input.tenantId, {
    leadId: input.leadId,
    spec: { kind: 'at', at: input.at },
    jobKind: 'inbound_turn',
    payload: { ...origem, aviso_de_transferencia: input.jobId },
    staggerWindowMs: 0,
  });
  return true;
}

/** O contato está com a equipe (`force_human`)? Só então o aviso de transferência faz sentido. */
export async function contatoComAEquipe(
  pool: pg.Pool,
  input: { tenantId: string; leadId: string },
): Promise<boolean> {
  const { rows } = await pool.query<{ force_human: boolean }>(
    `select force_human from contacts where organization_id = $1 and id = $2`,
    [input.tenantId, input.leadId],
  );
  return rows[0]?.force_human === true;
}
