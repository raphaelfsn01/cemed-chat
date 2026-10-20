import { defineConfig, devices } from "@playwright/test";

const RESPONSIVO = /responsivo\.spec\.ts/;

// Porta do dev server sob teste. Default 3001; sobrescreva com E2E_PORT quando
// a 3001 já estiver ocupada por outro checkout/worktree.
const PORT = process.env.E2E_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  /**
   * UM worker. `fullyParallel: false` serializa apenas DENTRO de cada arquivo —
   * entre arquivos o Playwright continua abrindo vários workers, e estes specs
   * compartilham a MESMA organização, os MESMOS usuários e o MESMO banco: um
   * spec revoga acesso enquanto outro checa escopo, um cria convite enquanto
   * outro conta membros.
   *
   * Medido em 2026-07-31: rodando a suíte inteira, 10 a 15 specs falhavam com
   * `waitForURL` estourando depois do login e elementos "not found"; os MESMOS
   * specs, rodados isolados, passavam em 18s. Não era lógica nem lentidão: era
   * interferência.
   *
   * O custo é wall-clock no CI. O benefício é que um vermelho volta a significar
   * "quebrou" em vez de "deu azar na ordem" — e suíte que falha por azar ninguém
   * lê, o que na prática desliga o gate inteiro.
   */
  workers: 1,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    // Produção (`next build` antes!): dev-server compila por rota (40-80s) e
    // Turbopack dev quebra cookies() fora do request scope — inviável p/ e2e.
    command: `pnpm exec next start --port ${PORT}`,
    url: BASE_URL,
    // false: reusar um server que já ocupa a porta pode ser OUTRO processo
    // (ex.: bundle do Remotion na 3000) — o teste precisa do NOSSO next start.
    reuseExistingServer: false,
    // NÃO declare `env:` aqui sem espalhar `process.env` junto. O default do
    // Playwright é herdar o ambiente, e o CI depende disso: o teto de login por
    // IP (`AUTH_RATE_LIMIT_LOGIN_IP`) é definido no passo do workflow e precisa
    // chegar ao `next start`, porque quem aplica o rate limit é o SERVIDOR.
    // Declarar `env` aqui substitui o ambiente inteiro e o teto volta a 60 —
    // o sintoma seria "Muitas tentativas" numa spec tardia, não um erro de config.
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
      testIgnore: RESPONSIVO,
    },
    // Projetos de viewport: rodam SÓ `responsivo.spec.ts`. Se a suíte inteira
    // rodasse em cada viewport, o tempo do CI quadruplicaria sem provar nada a
    // mais — as outras specs testam comportamento, não layout.
    {
      name: "mobile",
      testMatch: RESPONSIVO,
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    // Android pequeno, pior caso de largura — só as telas de primeira impressão.
    {
      name: "mobile-sm",
      testMatch: RESPONSIVO,
      grep: /@p0/,
      use: {
        browserName: "chromium",
        viewport: { width: 360, height: 740 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "tablet",
      testMatch: RESPONSIVO,
      use: {
        browserName: "chromium",
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      testMatch: RESPONSIVO,
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    // Safari de verdade (WebKit): zoom em input com fonte < 16px, `100dvh` e
    // safe-area só se comportam como no iPhone neste motor. Só as telas P0.
    {
      name: "webkit-p0",
      testMatch: RESPONSIVO,
      grep: /@p0/,
      use: { ...devices["iPhone 13"] },
    },
  ],
});
