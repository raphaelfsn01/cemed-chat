---
type: plano
status: draft
last_updated: 2026-08-26
audited_against: checkout local ~/dev/cemed-chat, HEAD em 2026-08-26
---

# Fora do escopo da CEMED — catálogo e recomendação

## O que este documento é, e o que ele não é

Este é um **catálogo de planejamento**, não uma ordem de execução. Ele lista o que o
`cemed-chat` herdou do `deskcomCRM` (produto multi-tenant genérico) e que não faz sentido para
uma instância única, dedicada à CEMED Saúde — junto com a ação recomendada para cada item.

**Nada neste documento foi executado.** Nenhuma linha de código foi removida, nenhuma flag foi
mudada, nenhuma migration foi escrita como consequência dele. Decidir *quando* e *como* executar
cada item é uma etapa futura, deliberada separadamente.

Ver também [`arquitetura-sistema.md`](arquitetura-sistema.md) para como o sistema funciona hoje,
e [`spec-crm-cemed.md`](spec-crm-cemed.md) para o domínio de negócio real da clínica.

## Como ler o catálogo

Cada item tem:

- **O que é** — descrição curta.
- **Onde vive** — arquivos/paths reais (confirmados lendo o código, não inferidos).
- **Classificação**:
  - **A** — fora de escopo claro para uma clínica de instância única.
  - **B** — genérico, mas inofensivo (não hardcoda outro nicho, não atrapalha; não mexer).
  - **C** — precisa de mais decisão de produto antes de agir.
- **Risco de remover** / **Risco de manter como está**.
- **Ação recomendada**.
- **Prioridade/esforço relativo** — Alto/Médio/Baixo. Não é estimativa de tempo: uma estimativa
  de horas aqui seria precisão falsa sem ter passado pelo código linha a linha.

Ordem: itens **A** primeiro (do mais barato/visível de corrigir para o mais estrutural), depois
**C**. Os itens **B** aparecem intercalados onde fazem contraste útil com um item A vizinho.

---

## 1. Link fixo do Nuvemshop no menu (A — mais barato da lista)

**O que é:** entrada "Nuvemshop" na navegação principal, sempre visível para admin,
independente de qualquer configuração.

**Onde vive:** `lib/navigation/registry.ts`, ~linha 312-320 (grupo `canais`). O próprio
comentário no código diz que esse link *"não tinha nenhum no app inteiro: só se chegava
digitando a URL"* — ou seja, foi adicionado deliberadamente depois, sem condicionar a
`NUVEMSHOP_ENABLED`.

**Risco de remover:** nenhum — a integração já degrada de forma independente do menu
(`NUVEMSHOP_ENABLED=false` por padrão).

**Risco de manter:** confusão de produto. Um admin da CEMED (clínica, sem loja) vê "Nuvemshop"
no menu, clica, e cai numa tela pedindo `NUVEMSHOP_APP_ID` com link para `partners.tiendanube.com`
— ruído que não deveria existir num produto de instância única.

**Ação recomendada:** remover a entrada do registry (não só gatear por env — a CEMED nunca vai
ligar essa flag).

**Prioridade/esforço:** Alto valor, Baixo esforço — 1 entrada de array a apagar.

---

## 2. Rotas, lib e schema do Nuvemshop (A, parcialmente já flag-gated)

**O que é:** integração completa de e-commerce (OAuth, sincronização de pedidos/produtos,
webhooks LGPD específicos do Nuvemshop).

**Onde vive:**
- Rotas: `app/api/v1/integrations/nuvemshop/callback/route.ts`,
  `app/api/v1/webhooks/nuvemshop/{[event],customer-data-request,customer-redact,store-redact}/route.ts`
- Server actions: `app/actions/integrations/{connectNuvemshop,disconnectNuvemshop}.ts`
- UI: `app/app/integrations/nuvemshop/`, `app/onboarding/connect-nuvemshop/`
- Lib: `lib/nuvemshop/{api-client,config,oauth,state}.ts`
- Schema: migration `20260428200211_0006_nuvemshop_lgpd.sql` + apêndice em `baseline.sql`
  (tabela `tenant_integrations`, provider `nuvemshop`)
- RAG: `lib/ai/rag/format-product.ts` (formata produto Nuvemshop para embedding)
- Docs: `docs/prd/06-prd-nuvemshop-lgpd.md`, `docs/specs/06-spec-nuvemshop-lgpd.md`,
  `docs/stories/epics/EPIC-07-nuvemshop.md`

**O que já está resolvido:** `NUVEMSHOP_ENABLED=false` por padrão em `.env.example`, `lib/env.ts`
degrada limpo (`getConfig()` retorna `null`), e o passo de onboarding só aparece com a flag
ligada.

**Risco de remover:** trabalho de deletar ~10 arquivos + tabela; se algum dia a CEMED quiser
vender produtos físicos/suplementos pelo WhatsApp, teria que reconstruir do zero.

**Risco de manter:** superfície de código morto para manter mentalmente ao ler o repo; tabela
`tenant_integrations` ocupando espaço conceitual no schema sem uso real.

**Ação recomendada:** manter atrás da flag por enquanto (custo de manutenção é baixo, já
degrada bem) — não é urgente remover fisicamente. Prioridade é o item 1 (menu) e o item 3
(tools do agente), que vazam pra experiência do usuário/agente mesmo com a flag desligada.

**Prioridade/esforço:** Baixo valor imediato, Alto esforço (schema + múltiplos arquivos) —
deixar para uma limpeza futura dedicada, não está bloqueando nada hoje.

---

## 3. Tools de comércio do agente de IA (A/C — confirmar gate)

**O que é:** duas tools MCP que o agente pode chamar: `crm_list_contact_orders` (histórico de
pedidos) e `crm_search_products` (busca no catálogo Nuvemshop).

**Onde vive:** `lib/mcp/tools/comercio.ts`, registradas em `lib/mcp/tools/catalogo/index.ts`
(`TOOLS_COMERCIO`) e `lib/mcp/tools/index.ts`. Confirmado lendo o arquivo: `crmSearchProducts`
consulta diretamente a tabela `nuvemshop_products` — se essa tabela não tem linha para a CEMED
(porque a integração nunca foi conectada), a tool sempre volta vazia (`"nada com esse nome no
catálogo"`), o que é inofensivo mas ainda expõe ao modelo uma ferramenta que não faz sentido no
domínio de uma clínica.

**Risco de remover:** nenhum funcional — nenhuma linha na tabela para a CEMED.

**Risco de manter:** o modelo pode tentar chamar `crm_search_products` quando um paciente
pergunta por um serviço, confundindo "catálogo fechado de serviços da CEMED" (que é RAG/prompt,
não uma tabela de produtos) com "catálogo de loja". Vale conferir se isso já foi observado em
teste real.

**Ação recomendada:** confirmar se essas duas tools estão registradas no toolset do agente
default da CEMED (`ai_agent_versions.tool_ids`) — se não estiverem explicitamente incluídas, não
há ação necessária; se estiverem, remover do toolset da versão do agente (não precisa apagar o
código, só não oferecer a tool).

**Prioridade/esforço:** Médio valor, Baixo esforço (é checar/editar uma lista, não codar).

---

## 4. Onboarding self-service que cria organização nova a cada signup (A)

**O que é:** todo `signup` público cria uma organização nova automaticamente.

**Onde vive:** `app/actions/auth/signUp.ts` (comentário explícito: *"cada signup provisiona
tenant"*, rate limit citando issue #64 "evita fábrica de organizações") → `app/auth/confirm/route.ts`
chama `ensureTenantForUser()` em `lib/auth/provision.ts`, que faz `INSERT INTO organizations` +
membership `admin` para o usuário que confirmou o e-mail. `app/(public)/signup/page.tsx` +
`components/auth/SignupForm.tsx` são a porta de entrada pública desse fluxo.

**Risco de remover/desligar:** nenhum para a CEMED — a organização já existe
(`ec189eb9-434d-4428-904b-3567d98bced3`), fixa. Ninguém deveria estar criando uma segunda.

**Risco de manter:** qualquer pessoa que ache a URL `/signup` cria uma organização nova e vazia
dentro do mesmo banco — não é um risco de segurança entre tenants (RLS isola), mas é ruído de
produto e um caminho que não deveria existir numa instância de cliente único.

**Ação recomendada:** desligar ou ocultar `/signup` público; o caminho correto para adicionar
alguém à CEMED é convite para a organização já existente (`invite-team`, que já funciona e
continua fazendo sentido — ver item 6).

**Prioridade/esforço:** Alto valor (fecha uma porta que não deveria existir), Médio esforço
(a rota de signup e o provisionamento têm rate-limit e auditoria acopladas, exige cuidado pra
não quebrar o fluxo de confirmação de convite, que reaproveita parte do mesmo caminho).

---

## 5. Copy "sua loja" no onboarding (A, trivial)

**O que é:** texto residual de e-commerce no formulário de boas-vindas.

**Onde vive:** `app/onboarding/welcome/_form.tsx`, linha ~69: *"Como sua loja aparece para o
time e nos painéis."*

**Ação recomendada:** reescrever para linguagem de clínica ("Como o nome da CEMED aparece..."
ou equivalente).

**Prioridade/esforço:** Baixo valor, Baixo esforço — 1 linha de texto.

---

## 6. Partes do onboarding que continuam fazendo sentido (B — não mexer)

**O que é:** `connect-whatsapp` (canal primário real), `setup-ai` (configuração do agente),
`invite-team` (convidar mais atendentes humanos para a mesma organização).

**Por que não mexer:** múltiplos atendentes humanos dentro da mesma clínica é um caso real —
recepção, gestão. Esses três passos deixam de ser "primeira empresa configurando do zero" e
passam a significar "configurar/expandir a instância única existente", mas o mecanismo em si
continua útil.

---

## 7. Billing placeholder com marca errada (A, inofensivo)

**O que é:** tela de billing 100% placeholder.

**Onde vive:** `app/app/settings/billing/page.tsx` — texto *"Em breve — Fase 2. Billing entra na
Fase 2 do roadmap. Para questões de pagamento, contate suporte@deskcomm.app"*. Confirmado: zero
Stripe no repo, zero coluna de plano/tier/subscription em `organizations`.

**Risco de remover:** nenhum — não há billing real implementado.

**Risco de manter:** e-mail aponta para o domínio do produto pai (`deskcomm.app`), não da CEMED
— se alguém clicar, escreve para o suporte errado.

**Ação recomendada:** no mínimo trocar/remover o e-mail; avaliar se a tela deveria simplesmente
sumir do menu (`lib/navigation/registry.ts`, entrada de settings/billing), já que "planos" não é
um conceito que um cliente único, sem cobrança por assento dentro do produto, precisa ver.

**Prioridade/esforço:** Médio valor (evidência de branding errado, some rápido em qualquer
demonstração do produto pro cliente), Baixo esforço.

---

## 8. Posicionamento multi-nicho nos docs herdados (C)

**O que é:** `docs/prd/00-prd-master.md` e `docs/current-state.md` descrevem o produto como
"AI Sales OS" multi-nicho (e-commerce, clínica, imobiliária, infoproduto, serviços), incluindo um
item de roadmap "templates por nicho" que **não existe em código nenhum** (confirmado por busca —
não há `business-templates.ts` nem `apply-template.ts` no repo, é só menção em texto).

**Ação recomendada:** anotar esses dois documentos como não-aplicáveis à CEMED (não descrevem o
produto atual), e remover o item "templates por nicho" do roadmap documentado para não ser
reintroduzido por engano numa sessão futura que leia o roadmap ao pé da letra.

**Prioridade/esforço:** Baixo valor imediato (não afeta o produto rodando), Baixo esforço — é
edição de texto em 2 arquivos.

### O que NÃO entra nesta lista, de propósito

A sonda de calibração em `lib/agent-engine/guardrails/vazamento-interno.ts` usa deliberadamente
102 frases cobrindo 5 nichos diferentes (clínica, loja, imobiliária, infoproduto, serviços) para
evitar que o detector de vazamento de vocabulário interno aprenda a proibir palavras legítimas de
UM nicho só. **Isso não é resíduo multi-nicho a limpar — é técnica de calibração deliberada.**
Não tocar sem entender a doutrina do próprio arquivo; simplificar essa sonda pode fazer o
detector regredir e passar a calar mensagens legítimas da própria CEMED.

---

## 9. Pipeline default "Pedidos" semeado em toda organização nova (A)

**O que é:** toda vez que uma linha é inserida em `organizations`, um trigger cria
automaticamente um pipeline "Pedidos" com 8 estágios 100% e-commerce.

**Onde vive:** `fn_seed_default_pipeline_for_org()` em `supabase/baseline.sql` (~linha 682),
disparado por trigger em `organizations`. Estágios atuais: Carrinho abandonado, Aguardando
pagamento, Pago (won), Em separação, Enviado, Entregue, Pós-venda, Cancelado (lost).

**Evidência de que já incomoda na prática:** `scripts/seed-crm-vivo.ts` cria deliberadamente um
pipeline **próprio** ("CRM Vivo — Clínica", slug `crm-vivo-clinica`) em vez de usar o "Pedidos"
default, com o comentário explícito *"em vez de sujar o 'Pedidos' da org"* — ou seja, o time já
contorna esse seed manualmente em vez de corrigi-lo na raiz.

**Risco de remover/trocar:** o trigger só dispara de novo se a organização for recriada — para a
CEMED (organização já existe, `ec189eb9-...`), mudar a função não afeta o pipeline que já está
lá; só evita que uma futura reinstalação (ex.: ambiente de teste do zero) semeie estágios de
loja de novo.

**Ação recomendada:** trocar os estágios semeados pelos estágios reais descritos em
[`spec-crm-cemed.md` §12](spec-crm-cemed.md#12-modelo-de-dados-do-crm):
`novo → em_triagem → qualificado → transferido → agendado → compareceu`, com `perdido` (saindo
de `em_triagem`/`qualificado`) e `nao_compareceu` (saindo de `agendado`) — isso é uma mudança de
função (`CREATE OR REPLACE FUNCTION`, idempotente por natureza), sem migration de dado, seguindo
a doutrina de schema do `CLAUDE.md` (arquivo em `migrations/` + apêndice no `baseline.sql` +
linha no `MANIFEST.md`).

**Prioridade/esforço:** Alto valor (é a diferença entre "clínica" e "loja" no primeiro pipeline
que qualquer instalação nova vê), Médio esforço — função SQL + os 3 artefatos de schema.

---

## 10. Capabilities genéricas — confirmadas como B, não mexer

Registradas aqui só para não serem confundidas com os itens acima numa leitura rápida:

- **`vocabulary jsonb`** em `crm_pipelines` — capability de renomear lead/deal/estágio, lida sem
  hardcode em nenhum lugar do código (`lib/kanban/`, `app/actions/settings/updatePipelineConfig.ts`,
  `lib/ai/render-system-prompt.ts`, etc.). O *default de fábrica* dessa coluna é vocabulário de
  e-commerce (Cliente/Pedido/Pago/Cancelado) — isso é coberto pelo item 9 (mesmo trigger), não a
  capability em si.
- **Multi-org / `resolveActiveOrg`** (`lib/auth/server.ts`) e a tabela `user_organizations` —
  mecanismo de resolução de sessão, sem UI de troca de organização em lugar nenhum do produto. É
  a base técnica que sustenta RLS/isolamento multi-tenant (testado no CI) — a doutrina do próprio
  `CLAUDE.md` trata isso como não-negociável, não como generalidade a podar.

---

## O que este documento não resolve sozinho

Este catálogo não decide **quando** cada item entra em execução, nem gera as migrations, PRs ou
testes necessários. Cada item, ao ser executado, segue a doutrina normal do repo (schema sai em
tripla migration+baseline+MANIFEST; UI nova precisa de porta em `lib/navigation/registry.ts`;
mudança em auth/onboarding precisa de teste de RLS/isolamento antes de merge). A ordem de
execução — se e quando Raphael decidir seguir — é conversa separada desta.
