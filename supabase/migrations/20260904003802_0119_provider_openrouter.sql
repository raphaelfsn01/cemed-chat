-- Migration 0119: `openrouter` entra como provider de LLM.
--
-- O agent-engine (único consumidor de turno desde a Fase 0 — ver
-- `workers/agent-worker/main.ts`, que loga `AGENT_DISPATCH_CONSUMER=native é
-- OBSOLETO`) resolve o modelo por `lib/agent-engine/edge/llm/`, cujo registro
-- de providers tinha exatamente três entradas: anthropic, openai e google.
-- O suporte a OpenRouter que existia em `lib/ai/gateway.ts` pertence ao worker
-- LEGADO (`workers/ai-response-worker.ts`), que não atende mais WhatsApp — ou
-- seja, não valia para o caminho real.
--
-- A CEMED usa OpenRouter como provider de chat do agente: uma chave só alcança
-- vários vendors, e trocar de modelo passa a ser troca de campo, não de código.
-- OpenRouter fala a API da OpenAI, então o código reaproveita `@ai-sdk/openai`
-- apontado ao endpoint dela — sem dependência nova.
--
-- Três CHECKs travavam o vocabulário em anthropic|openai|google. `openai` NÃO
-- sai: além de provider de chat, é quem faz embedding do RAG
-- (`lib/agent-engine/edge/llm/embed.ts`) — OpenRouter não faz embedding.
--
-- Os ids da OpenRouter são qualificados por vendor (`anthropic/claude-sonnet-5`),
-- diferente do id nu usado no provider `anthropic` (`claude-sonnet-5`). Por isso
-- as linhas novas em `ai_models` convivem com as antigas sem colidir na unique
-- (provider, model_id).
--
-- Preços: espelham as linhas `anthropic` correspondentes. Conferido por chamada
-- real à OpenRouter em 2026-09-03 — 15 tokens de entrada + 4 de saída custaram
-- US$ 0,00007, que é exatamente US$2/US$10 por milhão (as mesmas 200/1000
-- centavos da linha `anthropic/claude-sonnet-5`). Para oferecer outros modelos
-- da OpenRouter basta um INSERT novo aqui — o catálogo é curado de propósito,
-- não é espelho das centenas de ids que ela expõe.
--
-- Idempotente: `drop constraint if exists` antes de recriar; `on conflict do
-- nothing` nos inserts.

alter table public.ai_agent_versions
  drop constraint if exists ai_agent_versions_provider_check;
alter table public.ai_agent_versions
  add constraint ai_agent_versions_provider_check
  check (provider = any (array['anthropic'::text, 'openai'::text, 'google'::text, 'openrouter'::text]));

alter table public.ai_models
  drop constraint if exists ai_models_provider_check;
alter table public.ai_models
  add constraint ai_models_provider_check
  check (provider = any (array['anthropic'::text, 'openai'::text, 'google'::text, 'openrouter'::text]));

alter table public.ai_provider_credentials
  drop constraint if exists ai_provider_credentials_provider_check;
alter table public.ai_provider_credentials
  add constraint ai_provider_credentials_provider_check
  check (provider = any (array['anthropic'::text, 'openai'::text, 'google'::text, 'openrouter'::text]));

insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, is_default_for_provider)
values
  ('openrouter', 'anthropic/claude-sonnet-5', 'Claude Sonnet 5 (OpenRouter)',
   'Alto desempenho para atendimento e agentes. Roteado pela OpenRouter.',
   200, 1000, true, true),
  ('openrouter', 'anthropic/claude-opus-5', 'Claude Opus 5 (OpenRouter)',
   'Mais capaz da família, para casos que exigem raciocínio mais longo. Roteado pela OpenRouter.',
   500, 2500, true, false),
  ('openrouter', 'anthropic/claude-haiku-4.5', 'Claude Haiku 4.5 (OpenRouter)',
   'Rápido e barato, para classificação e tarefas auxiliares. Roteado pela OpenRouter.',
   100, 500, true, false)
on conflict (provider, model_id) do nothing;
