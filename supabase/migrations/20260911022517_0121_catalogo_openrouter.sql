-- Migration 0121: catálogo curado de modelos da OpenRouter.
--
-- A tela do agente (card "A inteligência que ele usa") passa a tratar a caixa
-- "Empresa" como o FABRICANTE do modelo dentro do catálogo da OpenRouter, em vez
-- de "qual provedor o sistema chama" — o provider gravado na versão é sempre
-- `openrouter`, e o fabricante é o prefixo do `model_id`
-- (`anthropic/claude-sonnet-5` → Anthropic). Uma chave só atende todos.
--
-- Por isso a lista de fabricantes da tela é DERIVADA destas linhas (prefixos
-- distintos), não fixa no código: acrescentar fabricante depois vira uma
-- migration, sem tocar em componente. Foi justamente uma lista fixa em
-- `AgentForm.tsx` que deixou `openrouter` de fora na 0119 e quebrou a tela.
--
-- CURADORIA, e por que ela existe: a OpenRouter expõe 437 modelos, dos quais 371
-- aceitam o parâmetro `tools`. Só que "a API aceita o parâmetro" não é "o modelo
-- usa ferramenta de forma confiável" — e o agente deste produto roda POR
-- ferramentas (cria lead, etiqueta, transfere). Modelo fraco nisso não dá erro:
-- devolve texto plausível e nunca cria o lead, e o defeito só aparece auditando
-- o funil dias depois. A lista curta é a trava contra isso.
--
-- Ids, janelas de contexto e preços foram MEDIDOS na API da OpenRouter em
-- 2026-09-11, não estimados. Preço em centavos de dólar por milhão de tokens
-- (US$2,00 → 200), mesma convenção das linhas que já existiam.
--
-- ⚠️ Só a família Claude está provada NESTE sistema (é o que rodou no WhatsApp).
-- Para os demais, o que se afirma é: a OpenRouter declara suporte a `tools` e
-- são modelos correntes. Trocar o modelo do agente pede teste do turno COM
-- ferramentas antes de considerar trocado.
--
-- `is_default_for_provider` segue só em `anthropic/claude-sonnet-5`:
-- `ai_models_one_default_per_provider` é índice único parcial, e um segundo
-- default quebra o insert.
--
-- Idempotente: `on conflict (provider, model_id) do nothing` nos inserts; o
-- update de display_name tem guarda de estado.

-- As 3 linhas semeadas na 0119 traziam o sufixo "(OpenRouter)" no nome porque
-- não havia campo separado de fabricante. Agora há — o sufixo virou ruído.
-- Aproveita e preenche a janela de contexto, que ficou nula lá.
update public.ai_models set
  display_name = case model_id
    when 'anthropic/claude-sonnet-5'  then 'Claude Sonnet 5'
    when 'anthropic/claude-opus-5'    then 'Claude Opus 5'
    when 'anthropic/claude-haiku-4.5' then 'Claude Haiku 4.5'
    else display_name end,
  context_window = case model_id
    when 'anthropic/claude-sonnet-5'  then 1000000
    when 'anthropic/claude-opus-5'    then 1000000
    when 'anthropic/claude-haiku-4.5' then 200000
    else context_window end
where provider = 'openrouter'
  and model_id in ('anthropic/claude-sonnet-5', 'anthropic/claude-opus-5', 'anthropic/claude-haiku-4.5')
  and display_name like '%(OpenRouter)%';

insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, is_default_for_provider)
values
  -- OpenAI
  ('openrouter', 'openai/gpt-5.6-terra', 'GPT-5.6 Terra',
   'Equilíbrio entre capacidade e custo na linha da OpenAI.', 1050000, 200, 1200, true, false),
  ('openrouter', 'openai/gpt-5.5', 'GPT-5.5',
   'Topo de linha da OpenAI; caro, para casos que exigem mais raciocínio.', 1050000, 500, 3000, true, false),
  ('openrouter', 'openai/gpt-5.4-mini', 'GPT-5.4 Mini',
   'Rápido e barato, para triagem e tarefas auxiliares.', 400000, 75, 450, true, false),
  -- Google
  ('openrouter', 'google/gemini-3.5-flash', 'Gemini 3.5 Flash',
   'Janela de contexto muito grande com custo moderado.', 1048576, 150, 900, true, false),
  ('openrouter', 'google/gemini-2.5-flash', 'Gemini 2.5 Flash',
   'Dos mais baratos com janela grande.', 1048576, 30, 250, true, false),
  -- DeepSeek
  ('openrouter', 'deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro',
   'Custo-benefício agressivo: saída ~5x mais barata que a dos topos de linha.', 1048576, 96, 191, true, false),
  ('openrouter', 'deepseek/deepseek-chat-v3-0324', 'DeepSeek V3 Chat',
   'Bem barato, para volume alto de conversa simples.', 163840, 29, 114, true, false),
  -- Moonshot (Kimi)
  ('openrouter', 'moonshotai/kimi-k3', 'Kimi K3',
   'Carro-chefe da Moonshot, janela de 1M.', 1048576, 260, 1300, true, false),
  ('openrouter', 'moonshotai/kimi-k2-thinking', 'Kimi K2 Thinking',
   'Variante com raciocínio explícito, custo baixo.', 262144, 60, 250, true, false),
  -- Qwen
  ('openrouter', 'qwen/qwen3.8-max-0902', 'Qwen3.8 Max',
   'Topo da linha Qwen, janela de 1M e saída barata.', 1000000, 200, 600, true, false),
  ('openrouter', 'qwen/qwen3-max-thinking', 'Qwen3 Max Thinking',
   'Variante com raciocínio explícito.', 262144, 78, 390, true, false),
  -- Z.ai (GLM)
  ('openrouter', 'z-ai/glm-5.3', 'GLM 5.3',
   'Maior janela de contexto do catálogo (1.3M), custo moderado.', 1310720, 140, 440, true, false),
  -- MiniMax
  ('openrouter', 'minimax/minimax-m3', 'MiniMax M3',
   'O mais barato do catálogo com janela de 1M.', 1048576, 30, 120, true, false)
on conflict (provider, model_id) do nothing;
