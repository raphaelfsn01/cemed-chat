/**
 * Marca CEMED pela tela — o que a equipe vê depois do rebrand do fork.
 *
 * O nome do projeto original saía em texto fixo: aba do navegador, contatos de
 * suporte (um e-mail de outro domínio, que ninguém da clínica lê), o nome do
 * fator no app autenticador e o arquivo de códigos de recuperação. Este spec
 * mede cada um como quem usa: pela tela, num `next start`.
 *
 * SUPPORT_EMAIL: o spec lê o MESMO env do servidor. Sem a variável (CI e o
 * primeiro deploy), as telas dizem "fale com o responsável pelo sistema"; com
 * ela, mostram o mailto. Provar as duas variantes = subir o servidor duas vezes.
 *
 * O caso do MFA cria um admin próprio e o apaga no fim: o admin compartilhado do
 * e2e tem fator semeado pelo script, não pela tela, e outras specs dependem dele.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { loadEnvLocal, uniqueEmail } from "./helpers/auth";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const env: Record<string, string | undefined> = { ...loadEnvLocal(), ...process.env };
const MARCA = (env.APP_NAME ?? "").trim() || "CEMED Saúde";
const SUPORTE = (env.SUPPORT_EMAIL ?? "").trim();
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/marca-cemed");

async function registrar(page: Page, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  const sufixo = SUPORTE ? "-com-support-email" : "";
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}${sufixo}.png`), fullPage: true });
}

async function conferirContato(page: Page) {
  const area = page.getByRole("main");
  if (SUPORTE) {
    await expect(area.locator(`a[href="mailto:${SUPORTE}"]`)).toHaveText(SUPORTE);
    await expect(area.getByText(/responsável pelo sistema/i)).toHaveCount(0);
  } else {
    await expect(area.getByText(/fale com o responsável pelo sistema/i)).toBeVisible();
    await expect(area.locator('a[href^="mailto:"]')).toHaveCount(0);
  }
  expect(await page.locator("body").innerText()).not.toMatch(/deskcomm/i);
}

test.describe("marca CEMED pela tela", () => {
  test("aba e metadados do login trazem a marca, sem o texto de produto multi-tenant", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(new RegExp(`· ${MARCA}$`));
    const descricao = await page.locator('meta[name="description"]').getAttribute("content");
    expect(descricao).toContain(MARCA);
    expect(descricao).not.toMatch(/multi-tenant/i);
    expect(await page.locator("body").innerText()).not.toMatch(/deskcomm/i);
    await registrar(page, "login");
  });

  test("conta suspensa: contato vem do SUPPORT_EMAIL, nunca de e-mail fixo", async ({ page }) => {
    await page.goto("/account-suspended");
    await expect(page.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
    await conferirContato(page);
    await registrar(page, "conta-suspensa");
  });

  test("cobrança (admin): contato vem do SUPPORT_EMAIL, nunca de e-mail fixo", async ({ page }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/settings/billing");
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await conferirContato(page);
    await registrar(page, "cobranca");
  });

  test("MFA pela tela: fator e arquivo de códigos de recuperação levam a marca", async ({ page }) => {
    test.setTimeout(120_000);
    const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const { data: org, error: erroOrg } = await svc
      .from("organizations")
      .select("id")
      .eq("slug", "e2e-test-org")
      .single();
    expect(erroOrg, "a org do seed do e2e precisa existir").toBeNull();

    const email = uniqueEmail("marca-mfa");
    const senha = "E2E!Marca1234";
    const { data: criado, error: erroUser } = await svc.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
      user_metadata: { full_name: "E2E Marca" },
    });
    expect(erroUser).toBeNull();
    const userId = criado.user!.id;

    try {
      const { error: erroMembro } = await svc.from("user_organizations").insert({
        user_id: userId,
        organization_id: (org as { id: string }).id,
        role: "admin",
        accepted_at: new Date().toISOString(),
      } as never);
      expect(erroMembro).toBeNull();

      await page.goto("/login");
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(senha);
      await page.getByRole("button", { name: /entrar/i }).click();
      await page.waitForURL(/\/app\//, { timeout: 30_000 });

      await expect(page.getByRole("heading", { name: /verificação em duas etapas/i })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole("button", { name: /iniciar configuração/i }).click();
      await expect(page.locator('img[alt="QR code para configurar autenticador"]')).toBeVisible({
        timeout: 20_000,
      });
      await page.getByText(/não consegue escanear/i).click();
      const segredo = (await page.locator("code").innerText()).trim();

      for (let tentativa = 0; tentativa < 3; tentativa++) {
        if (msUntilNextTotpWindow() < 4_000) await page.waitForTimeout(msUntilNextTotpWindow() + 300);
        await page.locator('input[aria-label="Dígito 1"]').click();
        await page.keyboard.type(generateTotp(segredo), { delay: 40 });
        try {
          await expect(page.getByRole("heading", { name: /códigos de recuperação/i })).toBeVisible({
            timeout: 8_000,
          });
          break;
        } catch {
          if (tentativa === 2) throw new Error("o enroll do MFA não chegou aos códigos de recuperação");
          await page.locator('input[aria-label="Dígito 1"]').click();
          for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
        }
      }

      const [arquivo] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: /baixar \.txt/i }).click(),
      ]);
      expect(arquivo.suggestedFilename()).toBe("cemed-saude-codigos-de-recuperacao.txt");
      await registrar(page, "mfa-codigos-de-recuperacao");

      // O nome do fator é o que o app autenticador e a lista de fatores mostram.
      const { data: fatores, error: erroFatores } = await svc.auth.admin.mfa.listFactors({ userId });
      expect(erroFatores).toBeNull();
      const nomes = (fatores?.factors ?? []).map((f) => f.friendly_name ?? "");
      expect(nomes).toContainEqual(expect.stringMatching(new RegExp(`^${MARCA} \\d{4}-\\d{2}-\\d{2}$`)));
      expect(nomes.join(" ")).not.toMatch(/deskcomm/i);
    } finally {
      await svc.auth.admin.deleteUser(userId);
    }
  });
});
