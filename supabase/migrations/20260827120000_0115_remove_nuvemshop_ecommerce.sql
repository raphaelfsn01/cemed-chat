-- Migration 0115: remove Nuvemshop/e-commerce schema.
--
-- O cemed-chat é uma instância única, privada, para uma clínica médica — não
-- vende produtos, não tem pedidos, não integra com nenhuma loja (Nuvemshop,
-- VTEX ou Shopify, os três únicos providers que `tenant_integrations`/`orders`
-- já suportaram). Todo o código que lia/escrevia estas tabelas (rotas,
-- server actions, telas, worker de RAG de produto, tools do agente de IA) foi
-- removido antes desta migration; nenhuma linha de aplicação depende mais
-- delas. Nenhuma tabela tem FK apontando PARA ela vinda de fora (conferido no
-- baseline: as três só têm FK para `organizations`/`contacts`, nunca o
-- inverso), então o drop não arrasta histórico de nenhuma outra tabela.
--
-- Idempotente: DROP TABLE IF EXISTS é no-op num clone que já rodou esta
-- migration (ou que nunca teve as tabelas).

drop table if exists public.nuvemshop_products;
drop table if exists public.orders;
drop table if exists public.tenant_integrations;

notify pgrst, 'reload schema';
