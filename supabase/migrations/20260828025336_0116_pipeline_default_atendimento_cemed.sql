-- Migration 0116: pipeline default "Atendimento" para a CEMED (item 9 do
-- catálogo de fora-de-escopo, docs/cemed/plano-fora-de-escopo.md).
--
-- `fn_seed_default_pipeline_for_org()` semeava, em toda organização nova, um
-- pipeline "Pedidos" com 8 estágios de e-commerce (Carrinho abandonado,
-- Aguardando pagamento, Pago, Em separação, Enviado, Entregue, Pós-venda,
-- Cancelado) — herdado do deskcomCRM genérico. O cemed-chat é instância
-- única de uma clínica médica; o funil real está em
-- docs/cemed/spec-crm-cemed.md §12: novo → em_triagem → qualificado →
-- transferido → agendado → compareceu, com `perdido` podendo sair de
-- em_triagem/qualificado e `nao_compareceu` saindo de agendado.
--
-- Também corrige o vocabulário (`crm_pipelines.vocabulary`) e as tags
-- canônicas (`crm_pipelines.settings.canonical_tags`) que a mesma função
-- grava — o vocabulário default da coluna é de e-commerce (Cliente/Pedido/
-- Pago/Cancelado), registrado como parte deste mesmo item no catálogo.
-- `canonical_tags` passa a listar as linhas de serviço da clínica (mesmos
-- valores de `Lead.linha_de_servico` na spec, + `generico` para origem
-- indeterminada) — é a tag que aparece como o ponto colorido no card do
-- Kanban (`lib/kanban/card-state.ts`), pedido pelo Raphael pra manter os
-- leads organizados por serviço dentro do funil.
--
-- Só afeta organizações criadas DEPOIS desta migration (o trigger só
-- dispara em INSERT em `organizations`). A organização da CEMED já existe
-- e já tem seu pipeline — nada muda pra ela. `lost_reasons` e `fields` do
-- `settings` continuam como o default da coluna (arrays vazios); fora de
-- escopo desta migration.
--
-- IMPORTANTE — achado rodando `pnpm test:db` (uma primeira versão desta
-- migration marcava tanto "Perdido" quanto "Não compareceu" como
-- `is_lost = true`): `uniq_crm_stages_pipeline_lost` é um índice único
-- PARCIAL que só permite UM estágio `is_lost = true` por pipeline (mesmo
-- para `is_won`, via `uniq_crm_stages_pipeline_won`). A spec desenha
-- "perdido" e "nao_compareceu" como dois ramos distintos, mas o schema não
-- comporta dois estágios de perda. Resolvido tratando "Não compareceu"
-- como estágio NÃO-terminal (nem ganho nem perda) — falta não é
-- necessariamente perda numa clínica que opera por fila (FCFS): a equipe
-- decide dali se remarca (volta pro estágio "Agendado") ou desiste (move
-- pra "Perdido", único estágio com `is_lost = true`).
--
-- Idempotente: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION "public"."fn_seed_default_pipeline_for_org"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_pipeline_id uuid;
  v_position numeric := 1000;
  r record;
begin
  insert into public.crm_pipelines (
    organization_id, name, slug, is_default, position, vocabulary, settings
  )
  values (
    new.id,
    'Atendimento',
    'atendimento',
    true,
    1000,
    jsonb_build_object(
      'lead', 'Lead', 'lead_plural', 'Leads',
      'deal', 'Atendimento', 'deal_plural', 'Atendimentos',
      'won', 'Compareceu', 'lost', 'Perdido',
      'stage', 'Etapa', 'stage_plural', 'Etapas'
    ),
    jsonb_build_object(
      'fields', '[]'::jsonb,
      'canonical_tags', jsonb_build_array(
        'medicina_trabalho', 'especialidades', 'exames',
        'espaco_integrar', 'estetica', 'generico'
      ),
      'lost_reasons', '[]'::jsonb,
      'identity_resolution', jsonb_build_object(
        'fields_in_priority_order', jsonb_build_array('cpf', 'phone_e164', 'email')
      )
    )
  )
  returning id into v_pipeline_id;

  for r in
    select * from (values
      ('Novo',            'novo',            false, false),
      ('Em triagem',      'em_triagem',      false, false),
      ('Qualificado',     'qualificado',     false, false),
      ('Perdido',         'perdido',         false, true),
      ('Transferido',     'transferido',     false, false),
      ('Agendado',        'agendado',        false, false),
      ('Não compareceu', 'nao_compareceu',  false, false),
      ('Compareceu',      'compareceu',      true,  false)
    ) as t(stage_name, stage_slug, won, lost)
  loop
    insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
    values (new.id, v_pipeline_id, r.stage_name, r.stage_slug, v_position, r.won, r.lost);
    v_position := v_position + 1000;
  end loop;

  return new;
end$$;
