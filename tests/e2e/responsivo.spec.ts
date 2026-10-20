/**
 * Responsivo — prova pela TELA que cada rota cabe no celular, no tablet e no
 * desktop (DoD item 12).
 *
 * Roda nos projetos de viewport do `playwright.config.ts` (`mobile` 390x844,
 * `mobile-sm` 360x740, `tablet` 768x1024, `desktop` 1440x900, `webkit-p0`
 * iPhone 13) — nunca no `chromium`, que é o desktop das outras specs.
 *
 * A medida é por ferramenta, não a olho: depois de carregar a rota, a página
 * (`documentElement`) e a coluna de conteúdo (`main`) não podem rolar na
 * horizontal. O `main` conta porque ele é `overflow-auto`: um bloco largo
 * dentro dele não estoura o documento, faz o CONTEÚDO rolar para o lado — e
 * no celular isso é a mesma tela quebrada, só que sem barra visível. Rolagem
 * horizontal de propósito (tabela, quadro do kanban, fila de abas) mora num
 * contêiner próprio e não entra na conta.
 *
 * Pré-requisito: `.e2e-creds.json` (scripts/seed-e2e-credentials.ts). As rotas
 * de `/admin` pedem o admin da seed como super-admin de plataforma.
 *
 * Evidência: `.superpowers/evidence/2026-10-responsivo/<RESP_FASE>/` — um PNG
 * por rota e viewport, mais `medidas-<projeto>.jsonl` com os números.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { execFileSync } from "node:child_process";

import { test, expect, type Locator, type Page } from "@playwright/test";

import { lerCreds, loginAdmin } from "../journeys/_login";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const FASE = process.env.RESP_FASE ?? "atual";
const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence", "2026-10-responsivo", FASE);
fs.mkdirSync(EVIDENCE, { recursive: true });

/** Tolerância de 1px: arredondamento de subpixel com deviceScaleFactor 2. */
const TOLERANCIA_PX = 1;

interface Rota {
  path: string;
  /** Fase da sprint que conserta a tela — só organiza o relatório. */
  fase: "1" | "2" | "3" | "4a" | "4b";
  /** Primeira impressão: roda também em 360px e no WebKit. */
  p0?: boolean;
}

const ROTAS_PUBLICAS: Rota[] = [
  { path: "/login", fase: "2", p0: true },
  { path: "/login/forgot", fase: "2" },
  { path: "/signup", fase: "2", p0: true },
  { path: "/403", fase: "2" },
  { path: "/account-suspended", fase: "2" },
  { path: "/rota-que-nao-existe", fase: "2" },
  { path: "/500", fase: "2" },
  { path: "/503", fase: "2" },
  { path: "/login/reset", fase: "2" },
  { path: "/team/accept-invite/token-invalido", fase: "2" },
];

const ROTAS_LOGADAS: Rota[] = [
  // Fase 1 — shell e hubs
  { path: "/app", fase: "1", p0: true },
  { path: "/app/ai", fase: "1" },
  { path: "/app/settings", fase: "1" },
  // Fase 3 — operação diária
  { path: "/app/inbox", fase: "3", p0: true },
  { path: "/app/kanban", fase: "3", p0: true },
  { path: "/app/contacts", fase: "3" },
  { path: "/app/radar", fase: "3" },
  { path: "/app/templates", fase: "3" },
  // Fase 4a — configurações
  { path: "/app/settings/profile", fase: "4a" },
  { path: "/app/settings/security", fase: "4a" },
  { path: "/app/settings/notifications", fase: "4a" },
  { path: "/app/settings/atendimento", fase: "4a" },
  { path: "/app/settings/tenant", fase: "4a" },
  { path: "/app/settings/tenant/pipelines", fase: "4a" },
  { path: "/app/settings/tenant/whatsapp", fase: "4a" },
  { path: "/app/settings/billing", fase: "4a" },
  { path: "/app/settings/api-tokens", fase: "4a" },
  { path: "/app/settings/templates", fase: "4a" },
  { path: "/app/settings/canal-oficial", fase: "4a" },
  { path: "/app/settings/atualizacao", fase: "4a" },
  { path: "/app/team", fase: "4a" },
  { path: "/app/team/invite", fase: "4a" },
  // Fase 4b — IA, canais, análise, admin
  { path: "/app/ai/agents", fase: "4b" },
  { path: "/app/ai/agents/new", fase: "4b" },
  { path: "/app/ai/followups", fase: "4b" },
  { path: "/app/ai/routers", fase: "4b" },
  { path: "/app/ai/credentials", fase: "4b" },
  { path: "/app/ai/knowledge/sources", fase: "4b" },
  { path: "/app/ai/memory", fase: "4b" },
  { path: "/app/ai/skills", fase: "4b" },
  { path: "/app/ai/cases", fase: "4b" },
  { path: "/app/ai/inbox", fase: "4b" },
  { path: "/app/ai/proposals", fase: "4b" },
  { path: "/app/ai/usage", fase: "4b" },
  { path: "/app/ai/evolution", fase: "4b" },
  { path: "/app/connections", fase: "4b" },
  { path: "/app/webhooks", fase: "4b" },
  { path: "/app/metrics", fase: "4b" },
  { path: "/app/audit", fase: "4b" },
  { path: "/app/lgpd/requests", fase: "4b" },
  { path: "/admin/dashboard", fase: "1" },
  { path: "/admin/inbox", fase: "3" },
  { path: "/admin/tenants", fase: "4b" },
  { path: "/admin/tenants/new", fase: "4b" },
  { path: "/admin/audit", fase: "4b" },
  { path: "/admin/lgpd", fase: "4b" },
  { path: "/admin/incidents", fase: "4b" },
  { path: "/admin/usage", fase: "4b" },
  { path: "/admin/users", fase: "4b" },
  { path: "/admin/platform-admins", fase: "4b" },
];

interface Medida {
  vw: number;
  documento: number;
  main: number;
  culpados: string[];
}

/**
 * Quanto a página e o `main` rolam na horizontal, e quem estoura.
 *
 * "Culpado" é o elemento MAIS EXTERNO cuja borda direita passa da viewport e
 * que não está dentro de um contêiner de rolagem próprio — é o que se conserta.
 */
async function medirTransbordo(page: Page): Promise<Medida> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const main = document.querySelector("main");
    const rolaSozinho = (el: Element) => {
      const ox = getComputedStyle(el).overflowX;
      return ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip";
    };
    const culpados: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
      const pai = el.parentElement;
      if (pai && pai !== document.body && pai.getBoundingClientRect().right > vw + 1) continue;
      let p = pai;
      let contido = false;
      while (p && p !== main && p !== document.body) {
        if (rolaSozinho(p)) {
          contido = true;
          break;
        }
        p = p.parentElement;
      }
      if (contido) continue;
      const classe = typeof el.className === "string" ? el.className.slice(0, 90) : "";
      culpados.push(`<${el.tagName.toLowerCase()} class="${classe}"> right=${Math.round(r.right)}`);
      if (culpados.length >= 6) break;
    }
    return {
      vw,
      documento: document.documentElement.scrollWidth - vw,
      main: main ? main.scrollWidth - main.clientWidth : 0,
      culpados,
    };
  });
}

function slug(p: string): string {
  return p.replace(/^\//, "").replace(/[/?=&]+/g, "_") || "raiz";
}

async function carregar(page: Page, rota: string): Promise<void> {
  await page.goto(rota);
  // Realtime mantém websocket aberto, mas `networkidle` só olha HTTP; o teto
  // cobre as telas que fazem polling.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function provarRota(page: Page, rota: Rota, projeto: string): Promise<void> {
  await carregar(page, rota.path);
  await provarTela(page, projeto, slug(rota.path), rota.path, rota.fase);
}

/**
 * Mede a tela que está aberta, fotografa e registra — a foto vem ANTES da
 * asserção, para existir mesmo no vermelho. Serve às rotas da varredura e aos
 * passos das jornadas, que não têm URL própria (um modal, um passo de wizard).
 */
async function provarTela(
  page: Page,
  projeto: string,
  arquivo: string,
  rotulo: string,
  fase: Rota["fase"],
): Promise<void> {
  const m = await medirTransbordo(page);
  await page.screenshot({
    path: path.join(EVIDENCE, `${projeto}-${arquivo}.png`),
    fullPage: true,
  });
  fs.appendFileSync(
    path.join(EVIDENCE, `medidas-${projeto}.jsonl`),
    JSON.stringify({ rota: rotulo, fase, url: page.url(), ...m }) + "\n",
  );
  const detalhe = `${rotulo} @${m.vw}px — culpados:\n  ${m.culpados.join("\n  ") || "(nenhum isolado)"}`;
  expect
    .soft(m.documento, `página rola na horizontal: ${detalhe}`)
    .toBeLessThanOrEqual(TOLERANCIA_PX);
  expect
    .soft(m.main, `conteúdo (main) rola na horizontal: ${detalhe}`)
    .toBeLessThanOrEqual(TOLERANCIA_PX);
}

/** Alvo de toque: altura E largura medidas na tela. */
async function medirAlvo(page: Page, seletor: ReturnType<Page["locator"]>) {
  const box = await seletor.boundingBox();
  expect(box, "alvo de toque não está na tela").not.toBeNull();
  return { w: box!.width, h: box!.height };
}

const ehCompacto = (projeto: string) => projeto !== "desktop";

/**
 * Alvo de toque mínimo, só onde há dedo: 44px para a ação primária da tela,
 * 36px para a secundária. Soft: um botão pequeno não esconde os outros achados.
 */
async function exigirAlvo(page: Page, alvo: Locator, minimo: 36 | 44, rotulo: string): Promise<void> {
  if (!ehCompacto(test.info().project.name)) return;
  const { w, h } = await medirAlvo(page, alvo);
  expect
    .soft(Math.min(w, h), `${rotulo} mede ${Math.round(w)}x${Math.round(h)} (mínimo ${minimo}px)`)
    .toBeGreaterThanOrEqual(minimo);
}

/** Toque de verdade onde o projeto tem toque: `tap()` dispara touch events, `click()` não. */
async function tocar(alvo: Locator): Promise<void> {
  if (test.info().project.use.hasTouch) await alvo.tap();
  else await alvo.click();
}

/** Nenhum pedaço do elemento fora da largura da viewport. */
async function exigirDentroDaTela(page: Page, alvo: Locator, rotulo: string): Promise<void> {
  const caixa = await alvo.boundingBox();
  expect(caixa, `${rotulo} não está na tela`).not.toBeNull();
  const largura = page.viewportSize()!.width;
  expect.soft(caixa!.x, `${rotulo} começa fora da tela`).toBeGreaterThanOrEqual(0);
  expect.soft(caixa!.x + caixa!.width, `${rotulo} passa da borda direita`).toBeLessThanOrEqual(largura + TOLERANCIA_PX);
}

test.describe("rotas públicas", () => {
  for (const rota of ROTAS_PUBLICAS) {
    test(`${rota.path} cabe na tela [fase ${rota.fase}]${rota.p0 ? " @p0" : ""}`, async ({
      page,
    }, info) => {
      await provarRota(page, rota, info.project.name);
    });
  }

  test("login por toque: senha e código de 6 dígitos até o app [fase 2] @p0", async ({ page }, info) => {
    // Até 30s esperando a próxima janela de TOTP, mais o login em si.
    test.setTimeout(90_000);
    const projeto = info.project.name;
    const creds = lerCreds();
    await carregar(page, "/login");

    const entrar = page.getByRole("button", { name: /^entrar$/i });
    await exigirAlvo(page, entrar, 44, "botão Entrar");
    await exigirAlvo(page, page.getByRole("link", { name: "Esqueci minha senha" }), 36, "link Esqueci minha senha");
    await exigirAlvo(page, page.getByRole("link", { name: "Criar conta" }), 36, "link Criar conta");

    await tocar(page.locator("#email"));
    await page.locator("#email").fill(creds.users.admin!.email);
    await tocar(page.locator("#password"));
    await page.locator("#password").fill(creds.password);
    await tocar(entrar);
    await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });
    await provarTela(page, projeto, "login_mfa", "/login/mfa", "2");

    const digitos = page.locator('input[aria-label^="Dígito"]');
    await expect(digitos).toHaveCount(6);
    for (let i = 0; i < 6; i++) {
      await exigirDentroDaTela(page, digitos.nth(i), `dígito ${i + 1}`);
    }
    const fonte = await digitos.first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fonte, "fonte < 16px faz o Safari dar zoom ao focar").toBeGreaterThanOrEqual(16);
    await exigirAlvo(page, page.getByRole("button", { name: /verificar/i }), 44, "botão Verificar");

    // Código da PRÓXIMA janela: o TOTP é de uso único, e a sessão salva deste
    // worker pode ter sido criada com o código da janela atual.
    await page.waitForTimeout(msUntilNextTotpWindow() + 500);
    await tocar(digitos.first());
    await page.keyboard.type(generateTotp(creds.admin_totp!.secret), { delay: 40 });
    await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
    await carregar(page, page.url());
    await provarTela(page, projeto, "login_chegada", "/app (após login)", "2");
  });
});

/**
 * A primeira impressão de verdade: o dono de uma instalação nova, criado pelo
 * mesmo `scripts/bootstrap-owner.ts` que o `install.sh` roda, entra pelo
 * celular e atravessa o wizard, o MFA obrigatório e os códigos de recuperação.
 * Um dono por rodada e projeto (e-mail e empresa únicos), então o wizard
 * sempre nasce zerado. Sem WAHA e sem Resend — o estado de um primeiro deploy.
 */
test.describe.serial("primeira impressão: dono de instalação nova", () => {
  let caminhoDoConvite: string | null = null;

  test("onboarding, MFA obrigatório e códigos de recuperação [fase 2] @p0", async ({ page }, info) => {
    test.setTimeout(240_000);
    const projeto = info.project.name;
    const marca = `${projeto}-${Date.now()}`;
    const email = `dono-${marca}@qa.local`;
    const senha = "QaVps!2026#Dono";
    execFileSync("pnpm", ["exec", "tsx", "scripts/bootstrap-owner.ts"], {
      env: { ...process.env, OWNER_EMAIL: email, OWNER_PASSWORD: senha, OWNER_ORG_NAME: `Clinica QA ${marca}` },
      stdio: "pipe",
    });

    await carregar(page, "/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(senha);
    await tocar(page.getByRole("button", { name: /^entrar$/i }));
    await page.waitForURL(/\/onboarding\/welcome/, { timeout: 30_000 });
    await provarTela(page, projeto, "onboarding_welcome", "/onboarding/welcome", "2");

    const continuar = page.getByRole("button", { name: /^continuar$/i });
    await exigirAlvo(page, continuar, 44, "Continuar (boas-vindas)");
    await page.locator("#display_name").fill("Clínica QA");
    await tocar(page.locator('input[type="checkbox"]'));
    await tocar(continuar);
    await page.waitForURL(/\/onboarding\/connect-whatsapp/, { timeout: 30_000 });
    await carregar(page, page.url());
    await provarTela(page, projeto, "onboarding_whatsapp", "/onboarding/connect-whatsapp", "2");

    const pular = page.getByRole("button", { name: /pular por enquanto/i });
    await exigirAlvo(page, pular, 44, "Pular (WhatsApp)");
    await tocar(pular);
    await page.waitForURL(/\/onboarding\/setup-ai/, { timeout: 30_000 });
    await provarTela(page, projeto, "onboarding_ia", "/onboarding/setup-ai", "2");

    await page.locator("#name").fill("Assistente QA");
    const criar = page.getByRole("button", { name: /criar e continuar/i });
    await exigirAlvo(page, criar, 44, "Criar e continuar (IA)");
    await tocar(criar);
    await page.waitForURL(/\/onboarding\/invite-team/, { timeout: 30_000 });
    await provarTela(page, projeto, "onboarding_time", "/onboarding/invite-team", "2");

    await page.locator("#emails").fill(`atendente-${marca}@qa.local`);
    const enviar = page.getByRole("button", { name: /enviar convites/i });
    await exigirAlvo(page, enviar, 44, "Enviar convites");
    await tocar(enviar);
    // Sem Resend nenhum e-mail sai: a tela tem de dizer isso e mostrar o link.
    await expect(page.getByText(/não está configurado neste servidor/i)).toBeVisible({ timeout: 15_000 });
    // O link vem truncado com reticências DE PROPÓSITO (a URL tem um token
    // longo); o que precisa caber é a linha — e o "Copiar link" ao lado dela.
    const link = page.locator("code", { hasText: /team\/accept-invite/ }).first();
    const linha = page.locator("li").filter({ has: link });
    await exigirDentroDaTela(page, linha, "linha do convite");
    const copiar = linha.getByRole("button", { name: /copiar link/i });
    await exigirDentroDaTela(page, copiar, "botão Copiar link");
    await exigirAlvo(page, copiar, 36, "Copiar link");
    caminhoDoConvite = new URL((await link.innerText()).trim(), "http://x").pathname;
    await provarTela(page, projeto, "onboarding_time_link", "/onboarding/invite-team (link)", "2");
    await tocar(page.getByRole("button", { name: /^continuar$/i }));
    await page.waitForURL(/\/onboarding\/done/, { timeout: 30_000 });
    await provarTela(page, projeto, "onboarding_fim", "/onboarding/done", "2");

    const irInbox = page.getByRole("button", { name: /ir para o inbox/i });
    await exigirAlvo(page, irInbox, 44, "Ir para o Inbox");
    await tocar(irInbox);
    await page.waitForURL(/\/app\//, { timeout: 30_000 });

    // MFA obrigatório para o dono (admin + super-admin): bloqueia até configurar.
    await expect(page.getByRole("heading", { name: /verificação em duas etapas/i })).toBeVisible({
      timeout: 20_000,
    });
    await provarTela(page, projeto, "mfa_inicio", "MFA obrigatório (início)", "2");
    const iniciar = page.getByRole("button", { name: /iniciar configuração/i });
    await exigirAlvo(page, iniciar, 44, "Iniciar configuração (MFA)");
    await tocar(iniciar);
    const qr = page.locator('img[alt="QR code para configurar autenticador"]');
    await expect(qr).toBeVisible({ timeout: 20_000 });
    await exigirDentroDaTela(page, qr, "QR code do MFA");
    await tocar(page.getByText(/não consegue escanear/i));
    const secret = (await page.locator("code").innerText()).trim();
    await provarTela(page, projeto, "mfa_qr", "MFA obrigatório (QR)", "2");

    await tocar(page.locator('input[aria-label="Dígito 1"]'));
    await page.keyboard.type(generateTotp(secret), { delay: 40 });
    await expect(page.getByRole("heading", { name: /códigos de recuperação/i })).toBeVisible({
      timeout: 20_000,
    });
    const codigos = page.locator("div.font-mono");
    await expect(codigos).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await exigirDentroDaTela(page, codigos.nth(i), `código de recuperação ${i + 1}`);
      const corta = await codigos.nth(i).evaluate((el) => el.scrollWidth > el.clientWidth);
      expect.soft(corta, `código de recuperação ${i + 1} cortado`).toBe(false);
    }
    await provarTela(page, projeto, "mfa_codigos", "MFA obrigatório (códigos)", "2");

    const concluir = page.getByRole("button", { name: /^concluir$/i });
    await exigirAlvo(page, concluir, 44, "Concluir (códigos)");
    await tocar(page.getByText(/salvei meus códigos/i));
    await tocar(concluir);
    await expect(page.getByRole("heading", { name: /verificação em duas etapas/i })).toHaveCount(0, {
      timeout: 30_000,
    });
    await carregar(page, page.url());
    await provarTela(page, projeto, "primeira_tela_do_app", "/app (primeira tela do dono)", "2");
  });

  test("convite: a primeira tela do atendente cabe no celular [fase 2] @p0", async ({ page }, info) => {
    test.skip(!caminhoDoConvite, "a jornada do dono não chegou a gerar o convite");
    await carregar(page, caminhoDoConvite!);
    await expect(page.getByRole("heading", { name: /você foi convidado/i })).toBeVisible();
    await exigirAlvo(page, page.getByRole("link", { name: /fazer login/i }), 44, "Fazer login (convite)");
    await provarTela(page, info.project.name, "convite_atendente", "/team/accept-invite/[token]", "2");
  });
});

/**
 * Sessão do admin, uma por worker e projeto — o padrão "autenticar num fixture
 * de worker" do Playwright.
 *
 * Não é `describe.serial` com uma página só: no serial o primeiro vermelho PULA
 * todas as rotas seguintes, e a varredura de antes mediu 7 de 50 rotas no
 * celular. Aqui cada rota é um teste independente, com contexto novo e a mesma
 * sessão salva. O login (com TOTP, que é de uso único por janela de 30s) só se
 * repete quando o arquivo envelhece — depois de um vermelho o Playwright
 * recria o worker, e relogar a cada falha custaria uma janela de TOTP por rota.
 *
 * 30 min fica abaixo do `jwt_expiry` (3600s em supabase/config.toml): nenhum
 * contexto chega a renovar o token, então a rotação de refresh token — que
 * revoga a sessão quando o MESMO refresh token é usado duas vezes — não entra
 * em jogo, mesmo com dezenas de contextos partindo do mesmo arquivo.
 */
const SESSAO_VALIDA_MS = 30 * 60_000;
const testLogado = test.extend<object, { sessaoAdmin: string }>({
  sessaoAdmin: [
    // `entregar` em vez do `use` da doc do Playwright: o nome é posicional, e
    // `use` faz o eslint confundir o fixture com um hook do React.
    async ({ browser }, entregar, workerInfo) => {
      const arquivo = path.join(process.cwd(), ".auth", `responsivo-${workerInfo.project.name}.json`);
      const fresco =
        fs.existsSync(arquivo) && Date.now() - fs.statSync(arquivo).mtimeMs < SESSAO_VALIDA_MS;
      if (!fresco) {
        const u = workerInfo.project.use;
        const context = await browser.newContext({
          baseURL: u.baseURL,
          viewport: u.viewport,
          deviceScaleFactor: u.deviceScaleFactor,
          isMobile: u.isMobile,
          hasTouch: u.hasTouch,
          userAgent: u.userAgent,
        });
        await loginAdmin(await context.newPage());
        fs.mkdirSync(path.dirname(arquivo), { recursive: true });
        await context.storageState({ path: arquivo });
        await context.close();
      }
      await entregar(arquivo);
    },
    // Limite próprio: login + MFA, com a espera pela janela de TOTP, passa dos
    // 30s padrão no WebKit (medido: 28,7s numa rodada limpa, estouro na cheia).
    { scope: "worker", timeout: 120_000 },
  ],
  storageState: ({ sessaoAdmin }, entregar) => entregar(sessaoAdmin),
});

testLogado.describe("área logada", () => {
  for (const rota of ROTAS_LOGADAS) {
    testLogado(`${rota.path} cabe na tela [fase ${rota.fase}]${rota.p0 ? " @p0" : ""}`, async ({ page }) => {
      const info = testLogado.info();
      await provarRota(page, rota, info.project.name);
    });
  }

  testLogado("navegação: menu do app abre, navega e fecha [fase 1] @p0", async ({ page }) => {
    const info = testLogado.info();
    const projeto = info.project.name;
    await carregar(page, "/app");
    const abrir = page.getByRole("button", { name: "Abrir menu" });
    if (!ehCompacto(projeto)) {
      await expect(abrir).toBeHidden();
      const rail = page.getByRole("navigation", { name: "Navegação principal" });
      await expect(rail).toBeVisible();
      return;
    }
    await expect(abrir).toBeVisible();
    const alvo = await medirAlvo(page, abrir);
    expect(alvo.h, "hambúrguer é alvo primário (≥44px)").toBeGreaterThanOrEqual(44);
    expect(alvo.w).toBeGreaterThanOrEqual(44);
    await abrir.click();
    const gaveta = page.getByRole("dialog", { name: "Menu" });
    await expect(gaveta).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, `${projeto}-menu-aberto.png`) });
    const caixa = await gaveta.boundingBox();
    expect(caixa!.x + caixa!.width, "gaveta cabe na viewport").toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    await gaveta.getByRole("link", { name: "Kanban" }).click();
    await page.waitForURL(/\/app\/kanban/);
    await expect(gaveta, "gaveta fecha ao navegar").toBeHidden();
  });

  testLogado("cabeçalho: todo botão da TopBar é alvo de toque ≥36px [fase 1] @p0", async ({ page }) => {
    const projeto = testLogado.info().project.name;
    test.skip(!ehCompacto(projeto), "alvo de toque só se mede onde há toque");
    await carregar(page, "/app/settings");
    const botoes = page.locator("header").first().getByRole("button");
    const n = await botoes.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const b = botoes.nth(i);
      if (!(await b.isVisible())) continue;
      const nome = (await b.getAttribute("aria-label")) ?? (await b.innerText());
      expect(nome.trim(), `botão #${i} da TopBar sem nome acessível`).not.toBe("");
      const { w, h } = await medirAlvo(page, b);
      expect(Math.min(w, h), `"${nome}" mede ${w}x${h}`).toBeGreaterThanOrEqual(36);
    }
  });

  testLogado("dialog: a busca abre inteira na viewport e o campo não dá zoom no iOS [fase 1] @p0", async ({ page }) => {
    const projeto = testLogado.info().project.name;
    await carregar(page, "/app/settings");
    await page.getByRole("button", { name: "Buscar telas" }).click();
    const dialog = page.getByRole("dialog", { name: "Buscar telas" });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, `${projeto}-busca-aberta.png`) });
    const caixa = (await dialog.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(caixa.x, "dialog encosta na borda esquerda").toBeGreaterThanOrEqual(8);
    expect(caixa.x + caixa.width, "dialog passa da borda direita").toBeLessThanOrEqual(vp.width - 8);
    expect(caixa.y + caixa.height, "dialog passa do rodapé").toBeLessThanOrEqual(vp.height);
    if (ehCompacto(projeto)) {
      const fonte = await dialog
        .getByRole("combobox")
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(fonte, "fonte < 16px faz o Safari dar zoom ao focar").toBeGreaterThanOrEqual(16);
    }
  });

  testLogado("navegação: menu do admin abre, navega e fecha [fase 1]", async ({ page }) => {
    const info = testLogado.info();
    const projeto = info.project.name;
    await carregar(page, "/admin/dashboard");
    const abrir = page.getByRole("button", { name: "Abrir menu" });
    if (!ehCompacto(projeto)) {
      await expect(abrir).toBeHidden();
      return;
    }
    await expect(abrir).toBeVisible();
    await abrir.click();
    const gaveta = page.getByRole("dialog", { name: "Menu" });
    await expect(gaveta).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, `${projeto}-admin-menu-aberto.png`) });
    await gaveta.getByRole("link", { name: "Tenants" }).click();
    await page.waitForURL(/\/admin\/tenants/);
    await expect(gaveta).toBeHidden();
  });
});
