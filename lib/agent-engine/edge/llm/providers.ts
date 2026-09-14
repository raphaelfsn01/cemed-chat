/**
 * Registro de providers da camada agnóstica. ÚNICO lugar (junto do resto de
 * edge/llm/) onde SDK de vendor é importado. Instância POR CHAMADA com a chave
 * BYOK da org: sem pool global de chave, sem fallback silencioso.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import { allowlistedFetch, buildAllowlist } from '../egress';

/** provider name → (chave BYOK da org, id do modelo) → modelo pronto para generateText. */
export type ProviderRegistry = Record<string, (apiKey: string, modelId: string) => LanguageModel>;

/**
 * Endpoint canônico do provider Anthropic (baseURL default do @ai-sdk/anthropic). NÃO é
 * um knob de política (a allowlist de política é a do egress.ts) — é o destino INTRÍNSECO
 * de ter escolhido o provider anthropic. Se uma org precisar de proxy/baseURL custom, é aqui
 * que ele entra (junto do `fetch` contido), nunca espalhado.
 */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
const OPENAI_ENDPOINT = 'https://api.openai.com';
const GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com';
/**
 * OpenRouter pelo provider OFICIAL dela (`@openrouter/ai-sdk-provider`), não pelo
 * `@ai-sdk/openai` apontado para cá — que foi como começou, e custou o cache.
 *
 * A API deles é compatível com a da OpenAI, então o cliente da OpenAI "funciona":
 * responde, chama tool, cobra. Só que ignora `providerOptions.anthropic.cacheControl`,
 * e o prefixo estável (stable-prefix.ts) nunca virava `cache_control` no request. Em
 * produção (14/09) toda chamada saía com `cacheReadTokens: 0` — 32 mil tokens
 * reenviados do zero a cada turno, mais lentos e mais caros, sem erro nenhum.
 *
 * O provider oficial lê a MESMA marcação (`anthropic.cacheControl`), então a
 * disciplina de cache não muda; e devolve o custo real por passo em
 * `providerMetadata.openrouter.usage.cost`. O id do modelo já vem qualificado por
 * vendor (`anthropic/claude-sonnet-5`), enquanto no provider `openai` é o id nu.
 */
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

/**
 * Providers reais do lançamento. Sonnet (Anthropic) é o default RECOMENDADO —
 * recomendação vive em .env.example/docs; o id do modelo é sempre config da org.
 *
 * O `fetch` INTERNO do provider (generateText) também roteia pela allowlist
 * (`allowlistedFetch`) — sem isso o egress do SDK escapava da contenção. A
 * allowlist do provider = seu endpoint canônico + hosts extra de config
 * (`allowedHosts`, ex.: proxy corporativo). Testes usam o registry fake
 * (createFakeRegistry, sem fetch real); este caminho só é exercitado pelo smoke
 * (rede real → endpoint canônico do provider allowlistado).
 */
export function createDefaultRegistry(opts?: { allowedHosts?: string[] }): ProviderRegistry {
  const extra = opts?.allowedHosts ?? [];
  const contain = (endpoint: string): typeof fetch => {
    const allow = buildAllowlist([endpoint, ...extra]);
    return (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      return allowlistedFetch(url, init, { allowlist: allow });
    };
  };
  return {
    anthropic: (apiKey, modelId) =>
      createAnthropic({ apiKey, fetch: contain(ANTHROPIC_ENDPOINT) })(modelId),
    openai: (apiKey, modelId) =>
      createOpenAI({ apiKey, fetch: contain(OPENAI_ENDPOINT) })(modelId),
    google: (apiKey, modelId) =>
      createGoogleGenerativeAI({ apiKey, fetch: contain(GOOGLE_ENDPOINT) })(modelId),
    openrouter: (apiKey, modelId) =>
      createOpenRouter({ apiKey, baseURL: OPENROUTER_ENDPOINT, fetch: contain(OPENROUTER_ENDPOINT) })(modelId, {
        // A OpenRouter já devolve o uso sempre; o provider só o expõe na
        // metadata com isto ligado — e é dali que sai o custo real.
        usage: { include: true },
      }),
  };
}

/**
 * Registry FAKE para testes: provider 'anthropic' (e alias 'fake') respondendo
 * com o MockLanguageModelV3 do SDK v6 instalado — zero rede, zero chave real.
 * O doGenerate default devolve `text` com usage fixo; injete o seu para cenários
 * de tool-call/erro.
 */
type MockDoGenerate = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doGenerate'];

export function createFakeRegistry(
  doGenerate?: MockDoGenerate,
  opts?: { text?: string },
): ProviderRegistry {
  const factory = (_apiKey: string, modelId: string): LanguageModel =>
    new MockLanguageModelV3({
      modelId,
      doGenerate:
        doGenerate ??
        {
          content: [{ type: 'text', text: opts?.text ?? 'ok' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        },
    });
  return { anthropic: factory, fake: factory };
}
