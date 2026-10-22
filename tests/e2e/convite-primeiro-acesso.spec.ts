/**
 * Primeiro acesso pelo convite (auditoria de 2026-10-21, C3 + C4/M5).
 *
 * O cadastro público (`/signup`) saiu: ele deixava qualquer pessoa criar conta e
 * organização no banco da clínica. Sem ele, quem é convidado e ainda não tem conta
 * cria a senha na própria página do convite — é a única porta de conta nova.
 *
 *   1. `/signup` não mostra cadastro: sem sessão, redireciona para o login.
 *   2. Convidado sem conta abre o link, cria a senha e cai no app com o papel do
 *      convite (pela tela, como a pessoa faria).
 *   3. O MESMO link de novo não cria segunda conta nem troca a senha: manda fazer login.
 *   4. Ex-membro removido NÃO volta com o link antigo (emitido antes da remoção)…
 *   5. …e volta com um convite NOVO do admin (emitido depois).
 *
 * Pré-req: o seed de convite (scripts/seed-e2e-invite.ts) — rodado aqui se faltar.
 * E-mails sintéticos `@invariant.test` (sem PII real).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { signInviteToken, INVITE_TTL_SECONDS } from "../../lib/auth/invite-token";

const INVITE_PATH = path.join(process.cwd(), ".e2e-invite.json");
if (!fs.existsSync(INVITE_PATH)) {
  execFileSync("npx", ["tsx", "scripts/seed-e2e-invite.ts"], { stdio: "inherit" });
}
const inv = JSON.parse(fs.readFileSync(INVITE_PATH, "utf8")) as { org_id: string };

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const EMAIL = `primeiro-acesso-${Date.now()}@invariant.test`;
const SENHA = "SenhaDoConvite123";
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "fase1-app");

function convite(iat: number): string {
  return signInviteToken({
    invite_id: randomUUID(),
    email: EMAIL,
    organization_id: inv.org_id,
    role: "agent",
    exp: iat + INVITE_TTL_SECONDS,
    iat,
  });
}

async function criarSenha(page: Page, token: string): Promise<void> {
  await page.goto(`/team/accept-invite/${token}`);
  await expect(page.getByRole("heading", { name: /Você foi convidado/i })).toBeVisible();
  await page.locator("#password").fill(SENHA);
  await page.locator("#password_confirm").fill(SENHA);
  await page.getByRole("button", { name: /Criar senha e entrar/i }).click();
}

async function usuarioId(): Promise<string | null> {
  const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  return data.users.find((u) => u.email === EMAIL)?.id ?? null;
}

async function membership(userId: string) {
  const { data } = await svc
    .from("user_organizations")
    .select("role, revoked_at")
    .eq("user_id", userId)
    .eq("organization_id", inv.org_id)
    .maybeSingle();
  return data as { role: string; revoked_at: string | null } | null;
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.describe("primeiro acesso pelo convite", () => {
  const primeiroToken = convite(Math.floor(Date.now() / 1000) - 60);

  test.afterAll(async () => {
    const id = await usuarioId();
    if (id) {
      await svc.from("user_organizations").delete().eq("user_id", id);
      await svc.auth.admin.deleteUser(id);
    }
  });

  test("1. /signup não mostra mais cadastro: sem sessão, vai para o login", async ({ page }) => {
    // Sem sessão, rota que não é pública leva ao login (proxy.ts): 307 para
    // /login?next=/signup. Com sessão daria 404 — a página não existe mais. O que
    // importa nos dois casos é não haver formulário de cadastro.
    const direto = await page.request.get("/signup", { maxRedirects: 0 });
    expect(direto.status()).toBe(307);
    expect(direto.headers()["location"]).toMatch(/\/login\?next=%2Fsignup$/);

    await page.goto("/signup");
    expect(new URL(page.url()).pathname).toBe("/login");
    await expect(page.getByRole("heading", { name: /entrar/i })).toBeVisible();
    await expect(page.locator("#org_name")).toHaveCount(0);
    await expect(page.locator("#password_confirm")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /criar conta/i })).toHaveCount(0);
  });

  test("2. convidado sem conta cria a senha e entra com o papel do convite", async ({ page }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await criarSenha(page, primeiroToken);
    await page.waitForURL(/\/app\/inbox/, { timeout: 60_000 });
    await page.screenshot({ path: path.join(EVIDENCIA, "primeiro-acesso-entrou.png") });

    const id = await usuarioId();
    expect(id, "a conta não foi criada").not.toBeNull();
    expect(await membership(id!)).toMatchObject({ role: "agent", revoked_at: null });
  });

  test("3. o mesmo link de novo não cria outra conta: manda fazer login", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await criarSenha(page, primeiroToken);
    // Filtrado pelo texto: o Next mantém um `role="alert"` vazio na página (o
    // anunciador de rota, #__next-route-announcer__).
    await expect(page.getByRole("alert").filter({ hasText: /já tem conta/i })).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "primeiro-acesso-reuso.png") });
    await ctx.close();
  });

  test("4. ex-membro não volta com o link antigo", async ({ browser }) => {
    const id = (await usuarioId())!;
    await svc
      .from("user_organizations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", id)
      .eq("organization_id", inv.org_id);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.locator("#email").fill(EMAIL);
    await page.locator("#password").fill(SENHA);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }).catch(() => {});

    await page.goto(`/team/accept-invite/${primeiroToken}`);
    await page.getByRole("button", { name: /Aceitar convite/i }).click();
    await expect(page.getByRole("alert").filter({ hasText: /anterior à sua remoção/i })).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "ex-membro-link-antigo.png") });
    expect((await membership(id))?.revoked_at, "o link antigo reativou o ex-membro").not.toBeNull();

    // 5. convite NOVO (emitido depois da remoção) traz de volta
    const novo = convite(Math.floor(Date.now() / 1000) + 2);
    await page.goto(`/team/accept-invite/${novo}`);
    await page.getByRole("button", { name: /Aceitar convite/i }).click();
    await page.waitForURL(/\/app\/inbox/, { timeout: 60_000 });
    expect(await membership(id)).toMatchObject({ role: "agent", revoked_at: null });
    await ctx.close();
  });
});
