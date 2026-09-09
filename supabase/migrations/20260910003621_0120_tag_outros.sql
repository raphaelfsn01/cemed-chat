-- Migration 0120: tag `outros` entra no vocabulário do funil.
--
-- O agente da CEMED tria e passa para o humano; o resultado da triagem é gravado
-- como tag no card (tool nativa `set_lead_tags`, que valida contra as
-- `canonical_tags` do pipeline — vocabulário fechado evita a deriva
-- "exame"/"exames"/"Exames" que estraga relatório em silêncio).
--
-- Faltava o balde do que NÃO é assunto da clínica: currículo, fornecedor,
-- cobrança de terceiro, engano de número, serviço que a clínica não presta.
-- Sem ele o agente não teria valor válido para esses casos e a tool recusaria a
-- etiqueta — a conversa fora de escopo ficaria indistinguível de uma sem triagem.
--
-- `outros` NÃO substitui `generico`, e a diferença é o que dá para medir:
--   generico = é paciente da CEMED, mas ainda não dá para saber qual serviço;
--   outros   = não tem a ver com a clínica.
-- Fundi-los apagaria a fronteira entre lead legítimo por identificar e ruído —
-- e é justamente o ruído (~20% do volume, segundo a administração da clínica)
-- que se quer dimensionar.
--
-- Duas frentes, porque uma sozinha não basta:
--   (a) a organização que JÁ existe (a CEMED) — UPDATE no pipeline dela;
--   (b) organizações FUTURAS — `fn_seed_default_pipeline_for_org()`, senão uma
--       reinstalação nasceria sem o balde.
--
-- Idempotente: o UPDATE tem guarda de estado (só mexe se `outros` não estiver
-- lá) e a função é CREATE OR REPLACE.

update public.crm_pipelines
set settings = jsonb_set(
      settings,
      '{canonical_tags}',
      coalesce(settings->'canonical_tags', '[]'::jsonb) || '["outros"]'::jsonb
    ),
    updated_at = now()
where organization_id = 'ec189eb9-434d-4428-904b-3567d98bced3'
  and not (coalesce(settings->'canonical_tags', '[]'::jsonb) @> '["outros"]'::jsonb);

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
        'espaco_integrar', 'estetica', 'generico', 'outros'
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
