/**
 * `?next=` depois do login só leva a caminho DESTA aplicação (auditoria de
 * 2026-10-21, M3 — redirect aberto).
 *
 * Antes, `/login?next=https://site-falso` mandava a pessoa, logo depois de um
 * login legítimo com a marca da clínica, para fora do sistema. O caso da action
 * prova a fiação: sem `destinoSeguro` em `signInWithPassword`, o redirect
 * recebe a URL externa e o teste fica vermelho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DESTINO_PADRAO, destinoSeguro } from "@/lib/auth/safe-next";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

describe("destinoSeguro", () => {
  it.each([
    ["https://site-falso.example/login", "URL absoluta"],
    ["//site-falso.example", "protocol-relative"],
    ["/\\site-falso.example", "barra invertida que o navegador lê como host"],
    ["/\t/site-falso.example", "caractere de controle"],
    ["javascript:alert(1)", "esquema javascript"],
    ["app/inbox", "caminho relativo"],
    ["", "vazio"],
  ])("%s (%s) vira o destino padrão", (next) => {
    expect(destinoSeguro(next)).toBe(DESTINO_PADRAO);
  });

  it("caminho local passa intacto, com query e âncora", () => {
    expect(destinoSeguro("/app/contacts?search=ana#x")).toBe("/app/contacts?search=ana#x");
    expect(destinoSeguro("/team/accept-invite/abc.def")).toBe("/team/accept-invite/abc.def");
  });

  it("sem next, o destino padrão", () => {
    expect(destinoSeguro(undefined)).toBe(DESTINO_PADRAO);
    expect(destinoSeguro(null)).toBe(DESTINO_PADRAO);
  });
});

describe("signInWithPassword — o next da URL não tira a pessoa do sistema", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(redirect).mockClear();
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) => (k === "x-forwarded-for" ? "203.0.113.80" : null),
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        signInWithPassword: vi.fn(async () => ({
          data: { user: { id: "u-destino" }, session: {} },
          error: null,
        })),
        // Sem autenticador: o login termina aqui, no redirect.
        mfa: { listFactors: vi.fn(async () => ({ data: { totp: [] } })) },
      },
    } as never);
  });

  it("next externo → redirect para o destino padrão", async () => {
    const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");
    await signInWithPassword(
      { email: "destino@example.com", password: "senha-certa-123" },
      "https://site-falso.example/login",
    );
    expect(redirect).toHaveBeenCalledWith(DESTINO_PADRAO);
  });

  it("next local → redirect para ele (probe positivo)", async () => {
    const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");
    await signInWithPassword(
      { email: "destino2@example.com", password: "senha-certa-123" },
      "/app/contacts",
    );
    expect(redirect).toHaveBeenCalledWith("/app/contacts");
  });
});
