/**
 * Primeiro acesso pelo convite — a única porta de conta nova depois que o
 * `/signup` saiu (auditoria de 2026-10-21, C3).
 *
 * O que não pode acontecer: conta criada com e-mail que não é o do convite, senha
 * de conta EXISTENTE trocada por quem tem o link, ou conta órfã (sem membership)
 * deixada para trás.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const createUser = vi.fn();
const deleteUser = vi.fn(async () => ({ error: null }));
const updateUserById = vi.fn();
const aplicarConvite = vi.fn();
const signIn = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { createUser, deleteUser, updateUserById } } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithPassword: signIn } }),
}));
vi.mock("@/lib/team/aplicar-convite", () => ({ aplicarConvite: (...a: unknown[]) => aplicarConvite(...a) }));

const ORG = "11111111-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INVITE_TOKEN_SECRET", "k".repeat(64));
  createUser.mockReset();
  deleteUser.mockClear();
  aplicarConvite.mockReset();
  signIn.mockClear();
  vi.mocked(redirect).mockClear();
  vi.mocked(headers).mockResolvedValue({
    get: (k: string) => (k === "x-forwarded-for" ? `192.0.2.${Math.floor(Math.random() * 250)}` : null),
  } as never);
});

async function token(email: string) {
  const { signInviteToken } = await import("@/lib/auth/invite-token");
  return signInviteToken({
    invite_id: "inv",
    email,
    organization_id: ORG,
    role: "agent",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

const senha = { password: "SenhaForte123", password_confirm: "SenhaForte123" };

describe("criarContaPeloConvite", () => {
  it("cria a conta com o e-mail DO TOKEN, já confirmado, aplica o convite e entra", async () => {
    createUser.mockResolvedValue({ data: { user: { id: "u-novo" } }, error: null });
    aplicarConvite.mockResolvedValue({ ok: true, efeito: "entrou" });
    const { criarContaPeloConvite } = await import("@/app/actions/team/criarContaPeloConvite");

    await criarContaPeloConvite(await token("Nova.Pessoa@Invariant.test"), senha);

    expect(createUser).toHaveBeenCalledWith({
      email: "nova.pessoa@invariant.test",
      password: "SenhaForte123",
      email_confirm: true,
    });
    expect(aplicarConvite).toHaveBeenCalledWith(expect.anything(), "u-novo", expect.objectContaining({ organization_id: ORG, role: "agent" }));
    expect(redirect).toHaveBeenCalledWith("/app/inbox");
  });

  it("e-mail que já tem conta → account_exists; nada de trocar senha nem de membership", async () => {
    createUser.mockResolvedValue({
      data: { user: null },
      error: { code: "email_exists", message: "A user with this email address has already been registered" },
    });
    const { criarContaPeloConvite } = await import("@/app/actions/team/criarContaPeloConvite");

    const r = await criarContaPeloConvite(await token("ja-existe@invariant.test"), senha);

    expect(r).toEqual({ ok: false, error: "account_exists" });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(aplicarConvite).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("convite recusado → a conta recém-criada é apagada (não fica órfã)", async () => {
    createUser.mockResolvedValue({ data: { user: { id: "u-orfa" } }, error: null });
    aplicarConvite.mockResolvedValue({ ok: false, erro: "internal_error" });
    const { criarContaPeloConvite } = await import("@/app/actions/team/criarContaPeloConvite");

    const r = await criarContaPeloConvite(await token("orfa@invariant.test"), senha);

    expect(r).toEqual({ ok: false, error: "internal_error" });
    expect(deleteUser).toHaveBeenCalledWith("u-orfa");
  });

  it("token adulterado → invalid_or_expired e nenhuma conta criada", async () => {
    const { criarContaPeloConvite } = await import("@/app/actions/team/criarContaPeloConvite");
    const t = await token("x@invariant.test");
    const r = await criarContaPeloConvite(`${t.split(".")[0]}.assinatura-falsa`, senha);
    expect(r).toEqual({ ok: false, error: "invalid_or_expired" });
    expect(createUser).not.toHaveBeenCalled();
  });
});
