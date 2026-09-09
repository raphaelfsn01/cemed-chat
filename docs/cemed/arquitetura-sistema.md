---
type: arquitetura
status: ativo
last_updated: 2026-08-26
audited_against: checkout local ~/dev/cemed-chat, HEAD em 2026-08-26
---

# Como o sistema funciona — tour guiado

## Por que este documento existe

O [`ARCHITECTURE.md`](../../ARCHITECTURE.md) na raiz do repo é, por design, uma visão de 1
página — "profundidade vive em `docs/specs/`". Este documento é o meio-termo: mais longo que
1 página, mas escrito como prosa contínua pra quem está abrindo o repositório pela primeira vez
e precisa entender **como as peças se encaixam**, não só que elas existem. Não repete o que já
está no `ARCHITECTURE.md` — complementa, com o "porquê" e o caminho ponta a ponta.

Este documento é sobre **como o sistema é construído**. Para **o que a clínica precisa que o
sistema faça**, a fonte é [`spec-crm-cemed.md`](spec-crm-cemed.md) e
[`cemed-negocio.md`](cemed-negocio.md).

## O que é o CEMED Chat, em uma frase

Um CRM de conversas com agente de IA, operado como instância única e privada da CEMED Saúde
(clínica médica em Rio das Ostras/RJ): WhatsApp como canal primário, um agente que tria,
qualifica e transfere pra equipe humana — nunca agenda sozinho, nunca dá orientação médica, nunca
informa preço.

## De onde isto veio

Duas linhagens se fundiram neste repositório:

1. **`deskcomCRM`** — um CRM multi-tenant open-source (Next.js + Supabase + WAHA), a base
   técnica: schema, RLS, auth, pipelines de vendas, inbox, API REST.
2. **"Vendaval"** — um motor de agente de IA mais rico, desenvolvido separadamente, fundido
   dentro do deskcomCRM em 2026-07 (ver `docs/vendaval-fusion-plan.md` para o briefing original e
   [`lib/agent-engine/PORT-NOTES.md`](../../lib/agent-engine/PORT-NOTES.md) para o mapeamento de
   schema e as regras técnicas do porte). A diretriz que guiou essa fusão — "prova de realidade,
   não de teste" — nasceu de um fracasso anterior: um protótipo validado só contra mocks, que
   nunca chegou a rodar contra WhatsApp de verdade.

O `cemed-chat` é um fork privado, de instância única, desse repositório já fundido, feito sob
medida para a CEMED. Ver [`plano-fora-de-escopo.md`](plano-fora-de-escopo.md) para o que dessa
herança multi-tenant/multi-nicho não se aplica mais aqui.

## Os dois runtimes do agente de IA — leia isto antes de mexer em "IA"

O código tem **dois** caminhos que parecem fazer a mesma coisa. Só um está vivo:

- **`lib/ai/runtime/agent.ts`** (`runAgent`) é o runtime **antigo**, marcado `@deprecated` no
  próprio cabeçalho. Hoje só é chamado pelo playground de teste de versão de agente
  (`/api/v1/ai/agents/[id]/versions/[vid]/test`) — nunca no caminho de uma mensagem real de
  WhatsApp. `app/api/v1/cron/agent-dispatcher/route.ts`, que antes disparava esse runtime, hoje é
  NO-OP puro (`{skipped:true, deprecated:true}`).
- **`lib/agent-engine/`** (codinome "Vendaval") é o runtime **canônico** — o que responde de
  verdade. Roda como **processo Node separado** (`workers/agent-worker/main.ts`, iniciado por
  `pnpm worker`, container próprio `Dockerfile.worker`), com fila durável própria (`job_queue`,
  via `pg.Pool` direto — não compartilha o pool de request do Next.js).

**Regra prática:** se a pergunta é "como o agente decide o que responder", a resposta está em
`lib/agent-engine/`, nunca em `lib/ai/runtime/`.

## O fluxo de uma mensagem, do WhatsApp até a resposta

1. **Entrada.** O WAHA (servidor que fala com o WhatsApp) manda um webhook para
   `app/api/v1/webhooks/waha/[token]/route.ts`. A rota resolve o `channel_session` dono desse
   token, autentica o corpo por HMAC-SHA512 (falha fechada — payload sem assinatura válida nunca
   chega a processar), grava a entrada bruta em `webhook_events_log` e delega tudo pra
   `dispatchWahaEvent()` em `lib/waha/ingest.ts`.

2. **Ingestão.** `handleInbound()` (mesmo arquivo) resolve a identidade do remetente (telefone
   E.164, `@lid` protegido pelo WhatsApp, ou grupo — grupo é descartado por decisão de produto),
   faz upsert atômico de contato e conversa via RPC (`fn_upsert_wa_contact`/
   `fn_upsert_wa_conversation` — atômico porque o WAHA manda o mesmo evento duas vezes por design,
   e um check-then-act ingênuo criaria contato duplicado na corrida), grava a mensagem com
   deduplicação (`unique(organization_id, external_id)`, captura o erro de duplicata em vez de
   checar antes), e checa a regex de opt-out (`STOP`/`PARAR`/`SAIR`/`UNSUBSCRIBE`) — se bater,
   marca o contato como bloqueado ali mesmo, antes de qualquer IA entrar em cena. Termina emitindo
   eventos em `event_log` (RPC `emit_event`): `ai_agent.dispatch_requested` é o que importa para
   o agente responder.

3. **Da fila de eventos para a fila de jobs.** O runtime antigo tinha um dispatcher genérico do
   Next.js pra isso; o canônico é `lib/agent-engine/edge/crm/drain.ts` (`drainTick`), rodando num
   loop dentro do processo `agent-worker` — não no cron do Next.js. Ele reivindica linhas
   `pending` de `ai_agent.dispatch_requested` com `for update skip locked` (dois workers nunca
   pegam o mesmo evento), agrupa mensagens em rajada do mesmo contato numa janela de debounce (o
   turno do agente lê o histórico inteiro e responde a todas de uma vez), e enfileira um job
   `inbound_turn` em `job_queue` — com dedup própria por `(organization_id, source_event_id)`.
   Eventos que ficam "processing" por tempo demais (worker que caiu no meio) voltam sozinhos pra
   `pending`.

4. **O turno do agente.** `lib/agent-engine/agent/inbound-turn.ts` processa o job. Cada job é uma
   sessão **fresca** — nenhum estado de lead fica em memória entre turnos, tudo vem do banco: o
   playbook (prompt do agente), o checkpoint do turno anterior (`lead_checkpoints` — compromissos,
   objeções, resumo corrente), o estágio atual do funil (`lead_state`) e as últimas mensagens da
   conversa. O modelo decide livremente quais ferramentas chamar — `get_lead_context`,
   `update_lead_state`, `save_lead_note`, `search_knowledge` (RAG sobre a base de conhecimento,
   `lib/ai/knowledge/busca.ts`), ferramentas do CRM via MCP (`lib/agent-engine/edge/crm/mcp-tools.ts`)
   — mas **texto solto do modelo nunca vira mensagem**: a única forma de falar com o lead é a tool
   `send_message`. A chamada de modelo em si passa sempre por
   `lib/agent-engine/edge/llm/run-model-call.ts` (não pelo runtime antigo).

5. **O portão antes de qualquer envio.** Toda chamada de `send_message` passa pela cadeia
   `lib/agent-engine/guardrails/before-send.ts` — uma lista **declarativa e versionada** de
   gates (`BEFORE_SEND_GATES`/`BEFORE_SEND_CHAIN_VERSION`, travada por teste que reprova se a
   ordem mudar sem bump de versão). Ordem fixa: (1) stop/opt-out irrevogável → (2) base legal
   LGPD → (3) anti-banimento/pacing (janela de horário, throttle, warm-up) → (3.5) janela de
   atendimento → (4) spinning de texto (varia a redação pra não repetir cópia idêntica) → (5)/(6)
   veto de promessa determinística e semântica (ex.: nunca prometer preço) → (6.5) anti-alucinação
   de caso humano → (6.7) vazamento de vocabulário interno ao cliente → (7) disclosure ("sou um
   assistente virtual"). Cada gate que veta devolve o motivo **ao modelo**, como uma mensagem de
   ensino para o turno seguinte — não é uma exceção silenciosa. Tudo roda sob um lock por
   `channel_session_id`, então dois workers nunca disputam o mesmo número ao mesmo tempo.

6. **Saída.** Só depois de passar por todos os gates, a mensagem vai pro
   `lib/agent-engine/edge/channel/waha-adapter.ts`, que efetivamente envia via `lib/waha/send.ts`.

7. **Fechamento.** Uma segunda chamada de modelo (propósito "checkpoint") grava o resumo do turno
   em `lead_checkpoints`. Avanços de estágio pedidos pelo modelo (`update_lead_state`) são
   espelhados no CRM visível (`mirrorLeadStageToCrm`) — se esse espelho falhar, não desfaz o
   avanço no harness (que é a fonte da verdade), só registra um aviso.

Diagrama existente desse fluxo (produto genérico, mas a mecânica bate com o real):
[`docs/architecture/agent-turn.html`](../architecture/agent-turn.html).

## Camadas e módulos-âncora

| Módulo | Responsabilidade | Onde vive |
|---|---|---|
| Pacing / anti-banimento | Decide SE pode enviar agora (janela de horário por timezone, throttle, warm-up de número novo) — função pura, sem I/O | `lib/agent-engine/pacing/engine.ts` |
| Roteador de agentes | Escolhe QUAL agente/versão atende este turno, quando há mais de um configurado | `lib/agent-engine/agent/router-config.ts` |
| CRM / lead ativo | Resolve o lead/negócio ativo de um contato; pipelines, estágios, atividades | `lib/leads/active-lead.ts`, `lib/leads/` |
| Follow-up | Grafo de reengajamento programado (silêncio, retorno) | `lib/followup/engine.ts` |
| Contrato de API | Wrapper único de sucesso/erro de toda rota `/api/v1/` | `lib/api/wrappers.ts` |
| RBAC | Gate único de autorização por papel (`viewer<agent<manager<admin`) | `lib/auth/require-role.ts` |
| Borda HTTP | Middleware de sessão/request-id em toda rota autenticada | `proxy.ts` |
| LGPD | Anonimização em cascata (contato → conversas → mensagens → mídia) | `lib/lgpd/redact-cascade.ts` |

**Dois mecanismos de eventos distintos coexistem, de propósito:**

- **Dreno genérico do Next.js** (`lib/event-log/dispatcher.ts` + `lib/event-log/register-handlers.ts`,
  puxado por `app/api/v1/cron/event-log-drain/route.ts`) — cuida de handlers "leves" que cabem num
  cron: resposta de sentimento, indexação de RAG, exportação/redação LGPD, automações, follow-up
  reativo, persistência de mídia.
- **Dreno dedicado do agent-engine** (`lib/agent-engine/edge/crm/drain.ts`, seção anterior) — só
  para `ai_agent.dispatch_requested`, porque o turno do agente precisa de uma fila durável própria
  (`job_queue`) com garantias mais fortes que um cron de 1 em 1 minuto oferece.

## Banco e multi-tenancy herdada

Toda tabela relevante ao negócio carrega `organization_id uuid not null`, com RLS aplicando
isolamento via `fn_user_org_ids()`. Isso é herança direta do `deskcomCRM` multi-tenant — e é
**deliberadamente mantida**, mesmo a CEMED sendo uma organização só: é a mesma base que sustenta
o modelo self-host (RLS testado no CI, service role sempre filtrando `organization_id`
manualmente). Remover essa camada seria regressão de segurança, não limpeza — ver
[`plano-fora-de-escopo.md`](plano-fora-de-escopo.md) item 10.

Schema real aplicado: `supabase/baseline.sql` (o que o kit self-host de fato instala) +
`supabase/migrations/MANIFEST.md` (histórico narrativo de cada mudança). Tabelas centrais:
`organizations` (raiz do tenant — só 1 linha relevante aqui, a CEMED), `channel_sessions` (números
de WhatsApp), `ai_agents`/`ai_agent_versions` (agente + versão publicada), `conversations`/
`messages`, `crm_leads`/`crm_pipelines`/`crm_stages`.

## Integrações externas

| Serviço | Uso | Onde | Aplica-se à CEMED? |
|---|---|---|---|
| Supabase | Postgres + Auth + Realtime + Storage | `lib/supabase/` | Sim — obrigatório |
| WAHA Plus | Envio/recebimento de WhatsApp | `lib/waha/` | Sim — canal primário |
| Vercel AI Gateway | Modelo de IA (Anthropic primário) | `lib/agent-engine/edge/llm/` | Sim |
| Upstash Redis | Rate limit + debounce de RAG | `lib/ai/dispatcher/`, `lib/ai/rag/debounce.ts` | Sim (degrada sem) |
| Nuvemshop | E-commerce (pedidos, produtos) | `lib/nuvemshop/` | **Não** — ver `plano-fora-de-escopo.md` item 2 |
| Sentry | Erros e performance | `sentry.*.config.ts` | Opcional |
| Resend | E-mail transacional (convites) | `lib/email/` | Opcional |

## Onde está a verdade sobre o negócio — e um alerta

Regras de negócio da clínica (catálogo de serviços, horário, política de convênios, regras de
LGPD específicas) vivem em `docs/cemed/`, não neste documento:
[`spec-crm-cemed.md`](spec-crm-cemed.md) e [`cemed-negocio.md`](cemed-negocio.md).

**Alerta sobre [`agente-triagem-funcional.md`](agente-triagem-funcional.md):** esse documento
descreve regras de negócio válidas de triagem, mas seu texto original afirmava (incorretamente)
descrever "o comportamento implementado" em um sistema Python rodando com Chatwoot — um sistema
que este repositório nunca teve. Foi corrigido com um aviso no topo do próprio arquivo apontando
para este documento. As regras de negócio continuam valendo como conhecimento acumulado; a
arquitetura real é a descrita aqui.

## Mapa da documentação herdada

- **Reaproveitável/ainda válido tecnicamente:** `docs/research/reference-synthesis.md` (base
  arquitetural original), `docs/specs/01` a `15` (contrato de schema real, ainda implementado),
  `docs/threat-model.md` (superfície de ataque do código, que é o mesmo).
- **Existe, mas é do produto genérico multi-nicho — zero menção à CEMED:** `docs/prd/00` a `06`,
  `docs/business-rules/00-business-rules-catalog.md`, os 6 mapas atuais de
  `docs/architecture/*.json` (nenhum descreve especificamente o fluxo da CEMED).
- **Desatualizado — linka arquivos que não existem mais neste repo:** `docs/index.md`,
  `docs/current-state.md`, `docs/harness-audit.md` (referenciam `VISION.md`, `AGENTS.md`,
  `README.en/es.md` etc., removidos no rebrand de 2026-08-25; frontmatter ainda diz
  `project: DeskcommCRM`). Use com ressalva.

Ver [`plano-fora-de-escopo.md`](plano-fora-de-escopo.md) para a lista completa do que fazer com
cada categoria.

## Nota de manutenção

Este é um documento **narrativo**, sobre como o sistema é montado — não muda toda semana. Para
"o que está pronto vs. incompleto agora", a fonte é `docs/current-state.md` (com a ressalva acima
de que está desatualizado pós-rebrand).
