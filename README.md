# CEMED Chat

CRM de conversas com agente de IA para a **CEMED Saúde** (Rio das Ostras/RJ) — atendimento via
WhatsApp, triagem automática, funil de pacientes/empresas e handoff para a equipe humana.

Projeto **privado, de instância única** — não é um produto multi-cliente. Toda a configuração
(catálogo de serviços, regras de negócio, tom de voz, guardrails do agente) é específica da
CEMED. A spec de negócio completa vive em [`docs/cemed/`](docs/cemed).

---

## Stack

| Camada | Escolha |
|---|---|
| **Frontend** | Next.js 16 App Router (Turbopack) + React 19 + TypeScript estrito |
| **Estilo** | Tailwind + shadcn/ui (`new-york`), paleta da marca CEMED (`app/globals.css`) |
| **DB** | Supabase (Postgres + RLS + `vector`) |
| **Auth** | Supabase Auth via `@supabase/ssr` |
| **WhatsApp** | WAHA (engine NOWEB) |
| **Filas** | `event_log` table + workers |
| **Rate limit** | Upstash Redis (sliding window) |
| **IA** | Anthropic Claude via AI Gateway/API direta |
| **Validação** | Zod |

## Rodando localmente

```bash
nvm use
pnpm install

cp .env.example .env.local   # preencher com as credenciais do projeto
docker compose up -d          # WAHA local (opcional em dev sem WhatsApp)

# Schema do banco — aplica o baseline, não as migrations soltas
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql

pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

## Testes

```bash
pnpm typecheck   # tsc --noEmit (estrito)
pnpm lint        # eslint next/core-web-vitals
pnpm test:unit   # Vitest
pnpm test:db     # Postgres efêmero + baseline install/update + invariantes
pnpm test:e2e    # Playwright (requer dev server)
```

## Documentação

- [`docs/cemed/`](docs/cemed) — specs de negócio e do agente de triagem (catálogo de serviços,
  regras duras, tom de voz, LGPD)
- [`CLAUDE.md`](CLAUDE.md) — convenções de código do projeto
- [`docs/prd/`](docs/prd) e [`docs/specs/`](docs/specs) — documentação técnica herdada da base
  do produto (multi-tenancy, RLS, arquitetura geral)
