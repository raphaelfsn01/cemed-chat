/**
 * Regressão: o código de verificação não pode ser pulado digitando a URL.
 *
 * Medido em produção em 2026-10-14: depois de e-mail e senha o admin ia para
 * /login/mfa, mas `goto("/app/inbox")` entrava no sistema inteiro e a API
 * respondia 200 — a sessão só-senha (AAL1) já estava gravada e ninguém conferia
 * o nível. A atendente, sem autenticador, não pode passar a ver código.
 *
 * Usa a conta admin seedada (TOTP verificado, segredo em .e2e-creds.json) e a
 * atendente seedada (sem fator).
 */
import { test, expect, type Page } from "@playwright/test";

import { lerCreds } from "./helpers/login-admin";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const creds = lerCreds();

async function entrarComSenha(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(creds.password);
  await page.locator('button[type="submit"]').click();
}

test("admin não pula o código digitando a URL; depois do código, entra", async ({ page }) => {
  expect(creds.admin_totp?.secret, "seed deve gravar admin_totp").toBeTruthy();

  await entrarComSenha(page, creds.users.admin!.email);
  await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });

  // O pulo: em vez do código, a URL do sistema.
  await page.goto("/app/inbox");
  await expect(page).toHaveURL(/\/login\/mfa\?next=%2Fapp%2Finbox/);
  await expect(page.getByRole("heading", { name: "Verificação em duas etapas" })).toBeVisible();

  const api = await page.request.get("/api/v1/contacts?limit=1");
  expect(api.status()).toBe(401);
  expect((await api.json()).error.code).toBe("mfa_required");

  if (msUntilNextTotpWindow() < 4_000) {
    await page.waitForTimeout(msUntilNextTotpWindow() + 300);
  }
  await page.getByLabel("Dígito 1").click();
  await page.keyboard.type(generateTotp(creds.admin_totp!.secret), { delay: 50 });

  // Volta para onde ia, e não pede de novo navegando.
  await page.waitForURL(/\/app\/inbox/, { timeout: 30_000 });
  await page.goto("/app/settings/security");
  await expect(page).toHaveURL(/\/app\/settings\/security/);
  await expect(page.getByLabel("Código de 6 dígitos")).toHaveCount(0);
});

test("atendente sem autenticador entra direto, sem código", async ({ page }) => {
  await entrarComSenha(page, creds.users.agent!.email);
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/login\/mfa/);
  await page.goto("/app/contacts");
  await expect(page).toHaveURL(/\/app\/contacts/);
});
