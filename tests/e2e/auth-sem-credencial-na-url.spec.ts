/**
 * Credencial nunca na URL — nem antes da hidratação.
 *
 * Os formulários de auth enviam por server action no `onSubmit`, que só existe
 * depois que o React hidrata. Antes disso, um toque em "Entrar" fazia o
 * NAVEGADOR enviar o formulário, e o método padrão é GET: medido na main,
 * `/login?email=…&password=SenhaSecreta123`. A URL vai para o histórico e para
 * os logs de acesso do proxy. No celular a hidratação demora segundos, então o
 * toque rápido é o caso comum, não o raro.
 *
 * JavaScript desligado reproduz exatamente o "ainda não hidratou".
 */
import { test, expect } from "@playwright/test";

test.use({ javaScriptEnabled: false });

const FORMULARIOS = [
  { rota: "/login", campos: { "#email": "alguem@exemplo.test", "#password": "SenhaSecreta123" }, botao: /entrar/i },
  {
    rota: "/signup",
    campos: {
      "#org_name": "Clinica Exemplo",
      "#email": "alguem@exemplo.test",
      "#password": "SenhaSecreta123",
      "#password_confirm": "SenhaSecreta123",
    },
    botao: /criar conta/i,
  },
];

for (const f of FORMULARIOS) {
  test(`${f.rota}: enviar antes da hidratação não põe a senha na URL`, async ({ page }) => {
    await page.goto(f.rota);
    for (const [seletor, valor] of Object.entries(f.campos)) {
      await page.locator(seletor).fill(valor);
    }
    await page.getByRole("button", { name: f.botao }).click();
    await page.waitForLoadState("load");
    expect(page.url()).not.toContain("SenhaSecreta123");
    expect(page.url()).not.toContain("password=");
  });
}
