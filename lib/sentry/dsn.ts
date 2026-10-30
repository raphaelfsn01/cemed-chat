/**
 * DSN do Sentry com opt-out em runtime — modelo "telemetria de comunidade".
 *
 * Por padrão, erros vão pro Sentry do projeto (DEFAULT_SENTRY_DSN): num open source
 * self-host, é o que dá visibilidade pra corrigir bugs que afetam todo mundo. Quem
 * hospeda controla isso pelo `.env`, SEM rebuild da imagem:
 *
 *   SENTRY_DSN=off           → desliga toda a telemetria (nada é enviado)
 *   SENTRY_DSN=<seu-dsn>     → manda os erros pro SEU Sentry
 *   SENTRY_DSN=  (vazio)     → usa o Sentry da comunidade (padrão)
 *
 * Vale para servidor (process.env) e navegador (window.__PUBLIC_ENV__.SENTRY_DSN,
 * injetado em runtime pelo <PublicEnvScript/>). O DSN não é segredo — DSNs do Sentry
 * são públicos por design.
 */
export const DEFAULT_SENTRY_DSN =
  "https://58fabf8ad54504863d404a3647ef3714@o4509908078559232.ingest.us.sentry.io/4509908083212288";

export function resolveSentryDsn(value: string | undefined | null): string | undefined {
  const v = (value ?? "").trim().toLowerCase() === "off" ? "off" : (value ?? "").trim();
  if (v === "off" || v === "false" || v === "0") return undefined;
  return v.length > 0 ? v : DEFAULT_SENTRY_DSN;
}

/**
 * Amostragem de traces, fixa em todos os runtimes (servidor, edge e navegador).
 *
 * 10%: o suficiente para enxergar lentidão sem mandar uma transação por requisição
 * de um CRM clínico para fora do país. Não há env para mudar de propósito — a
 * privacidade do dado de paciente não deve depender de uma variável esquecida.
 */
export const TRACES_SAMPLE_RATE = 0.1;

/**
 * Estamos mandando para o Sentry da COMUNIDADE (o nosso), e não para o do operador?
 *
 * Isso decide a amostragem de traces (issue #100). No DSN da comunidade só vai ERRO:
 * o que ajuda a corrigir "bug que afeta todo mundo" é o stack trace — não as
 * transações de um CRM que não é nosso. Quem aponta para o próprio Sentry recebe
 * `TRACES_SAMPLE_RATE`, porque aí o dado não sai da infraestrutura de quem é dono dele.
 * Replay de sessão não existe em nenhum dos dois casos.
 */
export function isCommunityDsn(dsn: string | undefined): boolean {
  return dsn === DEFAULT_SENTRY_DSN;
}

export function tracesSampleRateFor(dsn: string | undefined): number {
  return isCommunityDsn(dsn) ? 0 : TRACES_SAMPLE_RATE;
}
