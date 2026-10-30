// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn, tracesSampleRateFor, DEFAULT_SENTRY_DSN } from "./lib/sentry/dsn";
import { sentryScrubHooks } from "./lib/sentry/scrub";

const sentryDsn = resolveSentryDsn(process.env.SENTRY_DSN);

Sentry.init({
  dsn: sentryDsn,

  // No Sentry da comunidade, só erro (issue #100). Ver isCommunityDsn().
  tracesSampleRate: tracesSampleRateFor(sentryDsn),

  // O @sentry/nextjs registra o `httpIntegration` com `disableIncomingRequestSpans`
  // (o Next já cria os spans de entrada) e deixa o corpo da requisição no padrão
  // `medium`: até 10 KB de body iam no evento MESMO com `sendDefaultPii: false`,
  // porque o corpo é governado só por esta opção. Declarar a integração aqui
  // substitui a padrão (mesmo nome); `none` é o que impede o corpo de ser lido.
  integrations: [
    Sentry.httpIntegration({
      disableIncomingRequestSpans: true,
      maxIncomingRequestBodySize: "none",
    }),
  ],
  enableLogs: true,
  sendDefaultPii: false,

  ...sentryScrubHooks,
});

// Transparência de telemetria: uma linha no boot dizendo o que está ativo e como
// desligar. Evita "telemetria silenciosa" num projeto open source self-host.
if (!sentryDsn) {
  console.info("[telemetria] Desligada (SENTRY_DSN=off) — nenhum erro é enviado.");
} else if (sentryDsn === DEFAULT_SENTRY_DSN) {
  console.info(
    "[telemetria] Relatórios de erro anonimizados ATIVOS (Sentry da comunidade). " +
      "Sem rastreamento de performance nem replay de sessão. " +
      "Desligue com SENTRY_DSN=off, ou envie pro seu com SENTRY_DSN=<seu-dsn>.",
  );
} else {
  console.info("[telemetria] Erros sendo enviados ao Sentry configurado em SENTRY_DSN.");
}
