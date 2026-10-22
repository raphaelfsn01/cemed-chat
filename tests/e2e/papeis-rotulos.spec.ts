/**
 * Papéis com nome leigo — provado pela tela, como o administrador da clínica
 * convida e confere a Equipe.
 *
 * Antes, o convite e a Equipe mostravam `viewer/agent/manager/admin` crus. Agora
 * o campo mostra o nome (Consulta, Atendente, Gerente, Administrador), cada
 * opção traz a frase do que o papel pode fazer, e no convite a frase do papel
 * escolhido fica abaixo do campo.
 *
 * Medido por ferramenta: a lista aberta cabe na largura da tela no celular de
 * 360px (é ali que a frase mais longa quebraria a tela).
 *
 * Pré-requisito: `.e2e-creds.json` (scripts/seed-e2e-credentials.ts).
 * Evidência: `.superpowers/evidence/2026-10-papeis/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { loginAdmin } from "../journeys/_login";

const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence", "2026-10-papeis");
fs.mkdirSync(EVIDENCE, { recursive: true });

const PAPEIS = [
  { nome: "Consulta", frase: "Só vê as conversas e os dados, não altera nada." },
  { nome: "Atendente", frase: "Responde pacientes e trabalha nos contatos e no funil." },
  { nome: "Gerente", frase: "configura o robô de atendimento, vê a auditoria." },
  { nome: "Administrador", frase: "Controle total (equipe, WhatsApp, LGPD, organização)." },
];
const VALORES_CRUS = /\b(viewer|agent|manager|admin)\b/;

async function conviteMostraNomesEFrases(page: Page, tag: string): Promise<void> {
  await page.goto("/app/team/invite");
  const campo = page.getByRole("combobox", { name: "Papel" });
  await expect(campo).toHaveText("Atendente");
  // A frase fica num <p> abaixo do campo e é a descrição acessível dele.
  await expect(page.locator("#role-descricao")).toBeVisible();
  await expect(campo).toHaveAccessibleDescription(PAPEIS[1]!.frase);

  await campo.click();
  const lista = page.getByRole("listbox");
  await expect(lista).toBeVisible();
  for (const p of PAPEIS) {
    const opcao = page.getByRole("option", { name: new RegExp(`^${p.nome}`) });
    await expect(opcao).toBeVisible();
    await expect(opcao).toContainText(p.frase);
  }
  await expect(lista).not.toContainText(VALORES_CRUS);

  // A opção do papel atual abre destacada (fundo na cor de destaque): a frase
  // tem que acompanhar a cor do nome, senão fica cinza sobre a cor e some.
  const destacada = page.getByRole("option", { name: /^Atendente/ });
  await expect(destacada).toBeFocused();
  const cores = await destacada.evaluate((el) => {
    const nome = el.querySelector("span.font-medium") as HTMLElement;
    const frase = nome.nextElementSibling as HTMLElement;
    return { nome: getComputedStyle(nome).color, frase: getComputedStyle(frase).color };
  });
  expect(cores.frase, "frase da opção destacada com cor diferente do nome").toBe(cores.nome);

  const largura = page.viewportSize()!.width;
  const caixa = await lista.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  expect(caixa.left, "lista começa fora da tela").toBeGreaterThanOrEqual(0);
  expect(caixa.right, "lista passa da borda direita").toBeLessThanOrEqual(largura + 1);
  await page.screenshot({ path: path.join(EVIDENCE, `convite-lista-aberta-${tag}.png`) });

  await page.getByRole("option", { name: /^Consulta/ }).click();
  await expect(campo).toHaveText("Consulta");
  await expect(campo).toHaveAccessibleDescription(PAPEIS[0]!.frase);
  await page.screenshot({ path: path.join(EVIDENCE, `convite-consulta-${tag}.png`) });
}

async function equipeMostraNomes(page: Page, tag: string): Promise<void> {
  await page.goto("/app/team");
  const tabela = page.getByRole("table");
  await expect(tabela.getByRole("columnheader", { name: "Papel" })).toBeVisible();
  // O próprio admin aparece como rótulo; os outros membros, no seletor.
  await expect(tabela.getByText("Administrador", { exact: true })).toBeVisible();
  for (const nome of ["Gerente", "Atendente", "Consulta"]) {
    await expect(tabela.getByRole("combobox").filter({ hasText: nome }).first()).toBeVisible();
  }
  const colunaPapel = await tabela
    .locator("tbody tr td:nth-child(2)")
    .allInnerTexts();
  for (const texto of colunaPapel) expect(texto).not.toMatch(VALORES_CRUS);
  await page.screenshot({ path: path.join(EVIDENCE, `equipe-${tag}.png`), fullPage: true });
}

test.describe("papéis com nome leigo — desktop", () => {
  test("convite e Equipe mostram nome e frase, nunca o valor do banco", async ({ page }) => {
    await loginAdmin(page);
    await conviteMostraNomesEFrases(page, "desktop");
    await equipeMostraNomes(page, "desktop");
  });
});

test.describe("papéis com nome leigo — celular 360px", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

  test("a lista de papéis cabe na tela e a frase aparece abaixo do campo", async ({ page }) => {
    await loginAdmin(page);
    await conviteMostraNomesEFrases(page, "360");
    await equipeMostraNomes(page, "360");
  });
});
