-- Migration 0118: migra o pipeline "Pedidos" JÁ EXISTENTE da CEMED pros
-- estágios reais de "Atendimento".
--
-- A migration 0116 trocou fn_seed_default_pipeline_for_org() — mas essa
-- função só roda em INSERT em organizations, e a organização da CEMED já
-- existia antes da 0116. Resultado documentado no próprio catálogo
-- (docs/cemed/plano-fora-de-escopo.md item 9): a função nova não retroage;
-- quem já tinha "Pedidos" continua com "Pedidos" até alguém migrar os dados.
-- Esta migration é esse passo.
--
-- Escopada pelo organization_id da CEMED, não por um UPDATE genérico
-- `where slug = 'pedidos'`: o banco de dev deste projeto é COMPARTILHADO
-- com o deskcomCRM (mesmo projeto Supabase, organizações diferentes —
-- ver memória de projeto) — um UPDATE/DELETE sem organization_id afetaria
-- pipelines "Pedidos" de e-commerce legítimos de outras organizações que
-- não são a CEMED. cemed-chat é produto de instância única (CLAUDE.md); não
-- há "qualquer clone" genérico a cobrir aqui além da própria CEMED — o UUID
-- é conhecido e fixo (não há reinstalação prevista deste produto).
--
-- Confirmado antes de escrever: zero linhas em crm_leads apontam pra esse
-- pipeline, então DELETE + INSERT nos estágios é seguro (sem stage_id
-- pendurado). Idempotente: os WHERE guardam o estado (slug ainda 'pedidos'
-- pro pipeline; slugs antigos ainda presentes pros estágios; NOT EXISTS pro
-- insert) — reaplicar depois da primeira vez não duplica nem falha.
-- Numa reinstalação fresca (org nova, UUID diferente), esta migration é
-- no-op — quem semeia certo ali é a 0116.

update public.crm_pipelines
set
  name = 'Atendimento',
  slug = 'atendimento',
  vocabulary = jsonb_build_object(
    'lead', 'Lead', 'lead_plural', 'Leads',
    'deal', 'Atendimento', 'deal_plural', 'Atendimentos',
    'won', 'Compareceu', 'lost', 'Perdido',
    'stage', 'Etapa', 'stage_plural', 'Etapas'
  ),
  settings = jsonb_set(
    settings,
    '{canonical_tags}',
    '["medicina_trabalho", "especialidades", "exames", "espaco_integrar", "estetica", "generico"]'::jsonb
  ),
  updated_at = now()
where organization_id = 'ec189eb9-434d-4428-904b-3567d98bced3'
  and slug = 'pedidos';

delete from public.crm_stages
where organization_id = 'ec189eb9-434d-4428-904b-3567d98bced3'
  and pipeline_id in (
    select id from public.crm_pipelines
    where organization_id = 'ec189eb9-434d-4428-904b-3567d98bced3' and slug = 'atendimento'
  )
  and slug in (
    'carrinho_abandonado', 'aguardando_pagamento', 'pago', 'em_separacao',
    'enviado', 'entregue', 'pos_venda', 'cancelado'
  );

insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
select
  'ec189eb9-434d-4428-904b-3567d98bced3', p.id, v.name, v.slug, v.position, v.is_won, v.is_lost
from public.crm_pipelines p,
  (values
    ('Novo',            'novo',            1000::numeric, false, false),
    ('Em triagem',      'em_triagem',      2000::numeric, false, false),
    ('Qualificado',     'qualificado',     3000::numeric, false, false),
    ('Perdido',         'perdido',         4000::numeric, false, true),
    ('Transferido',     'transferido',     5000::numeric, false, false),
    ('Agendado',        'agendado',        6000::numeric, false, false),
    ('Não compareceu', 'nao_compareceu',  7000::numeric, false, false),
    ('Compareceu',      'compareceu',      8000::numeric, true,  false)
  ) as v(name, slug, position, is_won, is_lost)
where p.organization_id = 'ec189eb9-434d-4428-904b-3567d98bced3'
  and p.slug = 'atendimento'
  and not exists (
    select 1 from public.crm_stages s where s.pipeline_id = p.id and s.slug = v.slug
  );
