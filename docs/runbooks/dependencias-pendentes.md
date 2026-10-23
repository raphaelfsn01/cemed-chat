# Runbook: dependências pendentes

> Fase 3 da auditoria de segurança de 2026-10-21 (item A5). Fechamos só o risco real
> (Sentry, Next, MCP SDK, alertas de ferramenta) para entregar o sistema. O resto está
> aqui, com o motivo de ter ficado de fora, para ser feito **depois da entrega**.
> Fonte dos números: `pnpm audit` no lockfile da `main`.

## Risco aceito

| Pacote | Por quê não dá para corrigir | Onde vive |
|---|---|---|
| `braces` 3.0.3 (alto, DoS por aninhamento) | O alerta não tem versão corrigida publicada (`patched: <0.0.0`). Chega por `micromatch`/`chokidar`, ou seja, globbing de ferramenta (eslint, tsx, vitest). | Só desenvolvimento. Não entra no `standalone` do app. O worker instala o lockfile inteiro, mas não passa entrada externa para o glob. |

Reavaliar quando houver versão corrigida (`pnpm audit` mostra).

## Críticos/altos que sobram depois dos PRs 1 e 2 (`pnpm audit`)

Nenhum crítico. Os altos restantes são, todos, de ferramenta de build/teste ou de trecho
que o app não chama:

| Pacote | Quem puxa | Em uso? |
|---|---|---|
| `browserslist`, `nanoid`, `source-map-js` | `postcss`, `autoprefixer`, `webpack` | Só no build. |
| `fast-uri` | `ajv` (eslint, webpack) | Só ferramenta. |
| `sharp` | `next` (opcional) | Não: `images.unoptimized: true`, o otimizador de imagem está desligado. |
| `vite` (`launch-editor`, Windows) | `vitest` | Só teste. |
| `undici` 8 | `jsdom` | Só teste. |
| `undici` 7 | `@ai-sdk/provider-utils` | Está no worker e no app, mas o trecho vulnerável (WebSocket, `BalancedPool`) é código que o nosso não chama. Sai junto com o bulk do `ai`/`@ai-sdk/*`. |
| `braces` | `micromatch`, `chokidar` | Risco aceito (acima). |

## Fora da entrega (cada um é um PR próprio)

| Item | Motivo de ter ficado de fora | Cuidado ao retomar |
|---|---|---|
| **Bulk de 56 minor/patch** (PR #14 do Dependabot: Radix, zod 4.6, `ai`/`@ai-sdk/*`, pg, supabase-js, React 19.3, jsdom, Playwright, vite…) | Superfície grande demais para a véspera. O #14 também **quebra o `verify`**: 2 testes de `tests/unit/composer-attach.test.tsx` caem com `Cannot read properties of undefined (reading '_buffer')` em `AttachmentPreviewDialog.tsx` (`URL.createObjectURL(file)`). Suspeita: jsdom 30.1.x. | Bisseccionar jsdom × user-event; corrigir no setup de teste, não no código de produção. `ai`/`@ai-sdk/*` mexem no agente: o worker é construído na VPS, o CI não o atualiza. Playwright: a imagem do contêiner de QA precisa casar com a versão do pacote. |
| **`0.x` com minor potencialmente quebrando**: `@vercel/config` 0.5 → 0.12, `@openrouter/ai-sdk-provider` 3.0.0 → 3.1.0 (pinado) | Em `0.x` o minor pode quebrar contrato. | Ler o changelog e o uso real (`vercel.ts`, agent-engine) antes. |
| **`lucide-react` 0.460 → 1.x** | Major. Renomeia/remove ícones. | `typecheck` aponta os imports quebrados. |
| **`tailwindcss` 3.4 → 4.x** | Major. Reescreve a configuração e pode mudar estilo em todas as telas. | Exige prova visual completa (`tests/e2e/responsivo.spec.ts`). |
| **`pdf-parse` 1.1 → 2.x** | Major. API nova. | Testar com PDFs reais de anexo. |
| **`@types/node` 20 → 26** (PR #5) | Fechado. O runtime é Node 22; tipos do Node 26 descrevem APIs que não existem aqui. O Dependabot agora ignora major desse pacote (`.github/dependabot.yml`). | Se quiser avançar, `@types/node@^22`. |

## Como medir

```bash
pnpm audit --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).metadata.vulnerabilities))'
```

Alertas do Dependabot no GitHub (Security → Dependabot) podem divergir do `pnpm audit`.
