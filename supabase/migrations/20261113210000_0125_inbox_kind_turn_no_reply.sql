-- 0125: agent_inbox_items.kind ganha 'turn_no_reply'
--
-- Um turno do agente pode terminar `done` sem enviar NENHUMA mensagem ao
-- paciente e sem transferir para a equipe: o modelo encerra sem chamar
-- `send_message`, ou todas as tentativas são vetadas pela cadeia before-send.
-- Para a fila é sucesso; para o paciente é silêncio. Caso real de 23/10:
-- job `done`, `messages_sent: 0`, nada na Central de avisos.
--
-- `job_dead` só cobre o turno que FALHA. Este kind é o que faz o turno que
-- "dá certo" calado aparecer para a equipe. O aviso não leva dado de paciente:
-- só a referência ao contato e a contagem de vetos por gate.
--
-- Idempotente: a lista de kinds só cresce, nenhuma linha existente viola a
-- constraint nova.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'turn_no_reply',
    'other'
  ));

notify pgrst, 'reload schema';
