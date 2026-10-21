// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O proxy barra quem tem autenticador e só digitou a senha.
 *
 * Defeito medido em produção em 2026-10-14: depois de e-mail e senha, o admin
 * era levado a /login/mfa, mas digitar /app/inbox na barra entrava no sistema
 * inteiro, e a API respondia 200 — a sessão AAL1 já estava gravada e ninguém
 * conferia o nível.
 */

const estado: { aal: { currentLevel: string; nextLevel: string } } = {
  aal: { currentLevel: "aal1", nextLevel: "aal1" },
};

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "http://supabase.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    NEXT_PUBLIC_APP_URL: "https://cemed.test",
    IMPERSONATE_COOKIE_SECRET: "",
  },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: estado.aal, error: null }),
      },
    },
    rpc: async () => ({ data: true, error: null }),
  }),
}));

const { proxy } = await import("@/proxy");

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, "https://cemed.test"));
}

describe("proxy — segundo fator", () => {
  beforeEach(() => {
    estado.aal = { currentLevel: "aal1", nextLevel: "aal1" };
  });

  it("admin com autenticador que digita /app/inbox volta para a tela do código", async () => {
    estado.aal = { currentLevel: "aal1", nextLevel: "aal2" };
    const res = await proxy(req("/app/inbox?aba=fila"));
    expect(res.status).toBe(307);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.pathname).toBe("/login/mfa");
    expect(destino.searchParams.get("next")).toBe("/app/inbox?aba=fila");
  });

  it("a API responde 401 mfa_required em vez dos dados", async () => {
    estado.aal = { currentLevel: "aal1", nextLevel: "aal2" };
    const res = await proxy(req("/api/v1/contacts"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "mfa_required", message: "Two-factor verification required" },
    });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("depois do código (AAL2) passa", async () => {
    estado.aal = { currentLevel: "aal2", nextLevel: "aal2" };
    const res = await proxy(req("/app/inbox"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("atendente sem autenticador passa direto, sem código", async () => {
    const res = await proxy(req("/app/inbox"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("a própria tela do código continua acessível (senão vira loop)", async () => {
    estado.aal = { currentLevel: "aal1", nextLevel: "aal2" };
    const res = await proxy(req("/login/mfa"));
    expect(res.headers.get("location")).toBeNull();
  });
});
