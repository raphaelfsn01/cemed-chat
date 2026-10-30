// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn, tracesSampleRateFor } from "./lib/sentry/dsn";
import { sentryScrubHooks } from "./lib/sentry/scrub";

const sentryDsn = resolveSentryDsn(
  typeof window !== "undefined" ? window.__PUBLIC_ENV__?.SENTRY_DSN : undefined,
);

Sentry.init({
  dsn: sentryDsn,

  // Sem Session Replay (A3 da auditoria): o replay grava a tela de um CRM clínico
  // e levaria nome, telefone e texto de paciente para fora do país. Sem a
  // integração, as taxas abaixo são inertes — ficam em 0 para deixar a decisão
  // explícita e para quem a religar por engano não herdar uma amostragem.
  tracesSampleRate: tracesSampleRateFor(sentryDsn),
  enableLogs: true,

  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,

  sendDefaultPii: false,

  ...sentryScrubHooks,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
