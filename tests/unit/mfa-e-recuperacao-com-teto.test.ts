/**
 * Código do autenticador e código de recuperação têm teto NO SERVIDOR (auditoria
 * de 2026-10-21, M15).
 *
 * Antes: o contador de erros do TOTP vivia num cookie `mfa_attempts` — o cliente
 * o apagava e tentava de novo, sem fim — e o código de recuperação, que APAGA o
 * autenticador quando acerta, não tinha limite nenhum.
 *
 * O dublê de `cookies()` devolve um pote vazio a cada chamada: é exatamente o
 * atacante que apaga o cookie entre as tentativas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const listUsers = vi.fn(async () => ({ data: { users: [] }, error: null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { listUsers } } }),
}));

describe("verifyMfa — 5 códigos errados trancam, mesmo sem cookie", () => {
  const verify = vi.fn(async () => ({ error: { message: "Invalid TOTP code entered" } }));

  beforeEach(() => {
    vi.resetModules();
    verify.mockClear();
    vi.mocked(headers).mockResolvedValue({
      // IP diferente por chamada: o bloqueio que importa é o da CONTA.
      get: (k: string) => (k === "x-forwarded-for" ? `198.51.100.${Math.floor(Math.random() * 250)}` : null),
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "u-mfa-teto" } } })),
        mfa: {
          listFactors: vi.fn(async () => ({ data: { totp: [{ id: "f1", status: "verified" }] } })),
          challenge: vi.fn(async () => ({ data: { id: "ch1" }, error: null })),
          verify,
        },
      },
    } as never);
  });

  it("a 6ª tentativa é recusada sem chegar ao provedor", async () => {
    const { verifyMfa } = await import("@/app/actions/auth/verifyMfa");
    const r = [];
    for (let i = 0; i < 6; i++) r.push(await verifyMfa("123456"));

    expect(r.slice(0, 4).map((x) => x?.error)).toEqual(Array(4).fill("mfa_invalid"));
    expect(r[4]?.error).toBe("mfa_locked"); // a 5ª falha tranca
    expect(r[5]?.error).toBe("mfa_locked");
    expect(verify).toHaveBeenCalledTimes(5);
  });
});

describe("useRecoveryCode — teto por e-mail antes de qualquer consulta", () => {
  beforeEach(() => {
    vi.resetModules();
    listUsers.mockClear();
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) => (k === "x-forwarded-for" ? `203.0.113.${Math.floor(Math.random() * 250)}` : null),
    } as never);
  });

  it("a 6ª tentativa contra o mesmo e-mail volta rate_limited e nem procura o usuário", async () => {
    // alias: o nome `use*` faz o ESLint tratar a action como hook React.
    const { useRecoveryCode: usarCodigo } = await import("@/app/actions/auth/useRecoveryCode");
    const r = [];
    for (let i = 0; i < 6; i++) {
      r.push(await usarCodigo({ email: "alvo-recovery@invariant.test", code: "ABCD1234" }));
    }
    expect(r[5]).toEqual({ ok: false, error: "rate_limited" });
    expect(listUsers).toHaveBeenCalledTimes(5);
  });
});
