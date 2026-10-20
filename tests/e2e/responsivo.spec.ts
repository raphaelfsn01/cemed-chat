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

import { test, expect, type Page } from "@playwright/test";

import { loginAdmin } from "../journeys/_login";

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

/** Mede, fotografa e registra — a foto vem ANTES da asserção, para existir mesmo no vermelho. */
async function provarRota(page: Page, rota: Rota, projeto: string): Promise<void> {
  await carregar(page, rota.path);
  const m = await medirTransbordo(page);
  await page.screenshot({
    path: path.join(EVIDENCE, `${projeto}-${slug(rota.path)}.png`),
    fullPage: true,
  });
  fs.appendFileSync(
    path.join(EVIDENCE, `medidas-${projeto}.jsonl`),
    JSON.stringify({ rota: rota.path, fase: rota.fase, url: page.url(), ...m }) + "\n",
  );
  const detalhe = `${rota.path} @${m.vw}px — culpados:\n  ${m.culpados.join("\n  ") || "(nenhum isolado)"}`;
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

test.describe("rotas públicas", () => {
  for (const rota of ROTAS_PUBLICAS) {
    test(`${rota.path} cabe na tela [fase ${rota.fase}]${rota.p0 ? " @p0" : ""}`, async ({
      page,
    }, info) => {
      await provarRota(page, rota, info.project.name);
    });
  }
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
    { scope: "worker" },
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
