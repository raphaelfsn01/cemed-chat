/**
 * Remetente do Resend: sem padrão. Sem RESEND_FROM_EMAIL o e-mail é "não
 * configurado" — o mesmo caminho de quando falta a chave —, e os chamadores já
 * sabem lidar com isso (o convite oferece "copiar link"). O que este teste
 * impede é a volta de um remetente inventado no código, que o Resend recusaria
 * por não ser de domínio verificado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("resend", () => ({
  Resend: vi.fn(function Resend() {
    return { emails: { send } };
  }),
}));

const ENV_ORIGINAL = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
};

async function carregar() {
  // O cliente do Resend é memoizado no módulo: cada caso precisa de um módulo novo.
  vi.resetModules();
  return import("@/lib/email/resend");
}

const MENSAGEM = { to: "pessoa@exemplo.com.br", subject: "Assunto", html: "<p>oi</p>" };

describe("remetente do Resend", () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ data: { id: "email_1" }, error: null });
    process.env.RESEND_API_KEY = "re_teste_1234567890";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ENV_ORIGINAL)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sem RESEND_FROM_EMAIL não envia e responde not_configured", async () => {
    delete process.env.RESEND_FROM_EMAIL;
    const { sendEmail, isEmailConfigured } = await carregar();

    await expect(sendEmail(MENSAGEM)).resolves.toEqual({ ok: false, error: "not_configured" });
    expect(send).not.toHaveBeenCalled();
    expect(isEmailConfigured()).toBe(false);
  });

  it("RESEND_FROM_EMAIL vazio ou só com espaços conta como ausente", async () => {
    process.env.RESEND_FROM_EMAIL = "   ";
    const { sendEmail } = await carregar();

    await expect(sendEmail(MENSAGEM)).resolves.toMatchObject({ error: "not_configured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("com as duas variáveis, envia com o remetente configurado", async () => {
    process.env.RESEND_FROM_EMAIL = "  Clínica <noreply@exemplo.com.br>  ";
    const { sendEmail, isEmailConfigured } = await carregar();

    await expect(sendEmail(MENSAGEM)).resolves.toEqual({ ok: true, id: "email_1" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "Clínica <noreply@exemplo.com.br>" }));
    expect(isEmailConfigured()).toBe(true);
  });
});
