/**
 * Resposta barrada pela janela de envio não é descartada: o turno volta na abertura.
 *
 * A janela horária (7h–22h, sem domingo) é cortesia e proteção do número — o gate de pacing
 * veta TODO envio fora dela, inclusive a resposta a quem acabou de escrever. Até aqui só o
 * `followup_turn` re-agendava (followup-turn.ts, `rescheduleReentry`); o `inbound_turn`
 * terminava `done` com zero mensagens e nada agendado, enquanto a tela dizia "a resposta
 * fica agendada para a próxima abertura da janela" (lib/inbox/retention-copy.ts).
 *
 * Caso real (14/11 06h39 BRT): paciente pediu consulta, quatro envios vetados com
 * `outside_window`, e o único agendamento era um follow-up que o modelo marcou para três
 * dias depois.
 *
 * O que volta é o TURNO, não o texto vetado: na abertura o agente relê a conversa (com o
 * que o paciente tiver escrito nesse meio-tempo) e responde. Nenhum texto fica guardado.
 */

import type pg from 'pg';

import { scheduleCronJob } from '../cron/scheduler';

export interface ReagendarPorJanelaInput {
  /** `job_queue.kind`. Só `inbound_turn`: o follow-up tem o re-agendamento dele. */
  jobKind: string;
  /** Envios aceitos pelo canal no turno (`sent`, `already_sent` ou `queued`). */
  entregues: number;
  /** Opt-out lido na abertura do turno: silêncio obrigatório, nada volta. */
  optedOut: boolean;
  /** Handoff concluído neste turno: a conversa é da equipe, o agente não volta sozinho. */
  transferiu: boolean;
  /** `nextAllowedAt` do último veto `outside_window` do turno; ausente = não houve. */
  janelaReabreEm?: Date | undefined;
}

export function deveReagendarPorJanela(input: ReagendarPorJanelaInput): boolean {
  if (input.jobKind !== 'inbound_turn') return false;
  if (input.janelaReabreEm === undefined) return false;
  if (input.entregues > 0) return false;
  if (input.optedOut || input.transferiu) return false;
  return true;
}

/**
 * Agenda UM `inbound_turn` one-shot para `at`, com o payload do turno de origem. Um por
 * CONVERSA: se já há um re-agendamento de janela pendente para ela, o turno que ele vai
 * disparar já lê a conversa inteira — um segundo só faria o agente responder duas vezes na
 * abertura. Outra conversa do mesmo contato (outro número) ganha o dela: o payload é o que
 * diz por onde responder.
 * `staggerWindowMs: 0` de propósito: o jitter já vem embutido em `at` (calculado pelo gate).
 * Devolve `true` se criou, `false` se já havia um pendente.
 *
 * Check-then-insert é seguro pela mesma razão do follow-up: os turnos de um contato rodam
 * numa lane serializada (`uniq_job_queue_one_running_per_contact`).
 */
export async function reagendarTurnoPorJanela(
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
        and payload ? 'reschedule_of'
        and payload->>'conversation_id' = $3`,
    [input.tenantId, input.leadId, input.conversationId],
  );
  if (rowCount !== null && rowCount > 0) return false;
  await scheduleCronJob(pool, input.tenantId, {
    leadId: input.leadId,
    spec: { kind: 'at', at: input.at },
    jobKind: 'inbound_turn',
    payload: { ...input.payload, reschedule_of: input.jobId },
    staggerWindowMs: 0,
  });
  return true;
}

/**
 * O turno re-agendado ainda tem o que responder? Entre o veto e a abertura da janela a
 * conversa pode ter sido respondida por outro caminho — um turno novo do próprio paciente
 * logo depois das 7h, um follow-up, ou alguém da equipe pela tela. Se a última palavra já é
 * nossa (saída não-falha depois da última entrada), rodar o turno seria responder em dobro.
 * Só vale para job que carrega `reschedule_of`: turno normal nunca passa por aqui.
 */
export async function conversaJaRespondida(
  pool: pg.Pool,
  input: { tenantId: string; conversationId: string },
): Promise<boolean> {
  const { rows } = await pool.query<{ respondida: boolean }>(
    `select exists (
       select 1 from messages o
        where o.organization_id = $1 and o.conversation_id = $2
          and o.direction = 'outbound' and o.status <> 'failed'
          and o.created_at > coalesce((
            select max(i.created_at) from messages i
             where i.organization_id = $1 and i.conversation_id = $2 and i.direction = 'inbound'
          ), '-infinity'::timestamptz)
     ) as respondida`,
    [input.tenantId, input.conversationId],
  );
  return rows[0]?.respondida === true;
}
