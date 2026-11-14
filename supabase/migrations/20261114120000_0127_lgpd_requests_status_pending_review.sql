-- 0127: lgpd_requests.status aceita 'pending_review'
--
-- Os dois workers de LGPD gravam `pending_review` quando o pedido não pode ser
-- concluído sozinho e precisa de uma pessoa:
--   - exportação gerada, mas sem e-mail de entrega ou sem provedor de e-mail
--     configurado (o estado de um primeiro deploy sem RESEND_API_KEY);
--   - anonimização de contato sem pegada local;
--   - anonimização de tenant com falha parcial.
-- O CHECK só aceitava received/processing/completed/failed/expired. O UPDATE era
-- recusado (23514), os workers não conferiam o erro e devolviam "ok": o evento
-- era dado por concluído e o pedido ficava `processing` para sempre, sem aviso.
-- O tipo do TypeScript e as telas já conheciam o valor; só o banco não.
--
-- (A 0126 está reservada para `fn_conversation_assign`; esta é a primeira do
-- bloco 0127–0130 de LGPD.)
--
-- Idempotente: a lista só cresce, nenhuma linha existente viola a constraint
-- nova. Sem backfill.

alter table public.lgpd_requests
  drop constraint if exists lgpd_requests_status_check;

alter table public.lgpd_requests
  add constraint lgpd_requests_status_check check (status in (
    'received',
    'processing',
    'completed',
    'failed',
    'expired',
    'pending_review'
  ));

notify pgrst, 'reload schema';
