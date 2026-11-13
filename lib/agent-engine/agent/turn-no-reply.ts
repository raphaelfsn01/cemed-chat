/**
 * Turno que termina `done` sem NENHUMA mensagem ao paciente e sem ninguém avisado.
 *
 * Caso real (23/10 14:45 BRT): o job rodou, o modelo respondeu, `messages_sent: 0`, nenhuma
 * tentativa de envio — e nada na Central. Para a fila era sucesso; para o paciente, silêncio.
 * `job_dead` só cobre turno que FALHA; este é o turno que "dá certo" calado.
 *
 * O aviso vai para `agent_inbox_items` (kind `turn_no_reply`, migration 0125) e não leva
 * dado de paciente: só o id do contato (ref) e a contagem de vetos por gate.
 */

import type pg from 'pg';

export interface TurnoMudoInput {
  /** `job_queue.kind`. Só `inbound_turn` cobra resposta: follow-up pode decidir não falar. */
  jobKind: string;
  /** Envios aceitos pelo canal no turno (`sent`, `already_sent` ou `queued`). */
  entregues: number;
  /** `contacts.is_blocked` lido na abertura do turno: opt-out é silêncio obrigatório. */
  optedOut: boolean;
  /** Handoff concluído neste turno: a equipe já foi avisada pelo item `handoff`. */
  transferiu: boolean;
  /** Vetos da cadeia before-send no turno, por nome de gate. */
  vetosPorGate: Readonly<Record<string, number>>;
}

/**
 * O silêncio deste turno é um problema? Silêncio LEGÍTIMO (não alerta): opt-out, handoff
 * concluído no turno, ou veto do gate `stop` — que só veta por opt-out ou por conversa já
 * com a equipe (`handoff_ativo`), e nos dois casos calar é o comportamento certo.
 */
export function turnoFicouMudo(input: TurnoMudoInput): boolean {
  if (input.jobKind !== 'inbound_turn') return false;
  if (input.entregues > 0) return false;
  if (input.optedOut || input.transferiu) return false;
  if ((input.vetosPorGate.stop ?? 0) > 0) return false;
  return true;
}

/** "semantic_promise ×2, pacing ×1" — nomes de gate são vocabulário nosso, nunca texto do paciente. */
export function resumoDosVetos(vetosPorGate: Readonly<Record<string, number>>): string {
  return Object.entries(vetosPorGate)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([gate, n]) => `${gate} ×${n}`)
    .join(', ');
}

/**
 * Abre o aviso na Central. Dedup por episódio (mesmo padrão do handoff): contato que já
 * tem um `turn_no_reply` aberto não ganha outro — quem resolve o primeiro vê a conversa
 * inteira. Devolve quantos itens foram criados (0 = já havia um aberto).
 */
export async function alertarTurnoSemResposta(
  db: pg.Pool,
  input: { tenantId: string; leadId: string; vetosPorGate: Readonly<Record<string, number>> },
): Promise<number> {
  const vetos = resumoDosVetos(input.vetosPorGate);
  const body =
    'O paciente escreveu e o assistente encerrou o atendimento sem enviar nenhuma mensagem. ' +
    'Abra a conversa e responda.' +
    (vetos === ''
      ? ' Nenhuma tentativa de envio foi barrada: o assistente não chegou a tentar responder.'
      : ` Envios barrados neste atendimento: ${vetos}.`);
  const { rowCount } = await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'turn_no_reply', 'warn', $2, $3, 'contact', $4
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and kind = 'turn_no_reply'
         and ref_kind = 'contact' and ref_id = $4 and status = 'open'
     )`,
    [input.tenantId, 'Paciente ficou sem resposta do assistente', body, input.leadId],
  );
  return rowCount ?? 0;
}
