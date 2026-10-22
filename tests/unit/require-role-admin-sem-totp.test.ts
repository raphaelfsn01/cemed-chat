/**
 * Admin sem autenticador não usa a API de admin só com a senha (auditoria de
 * 2026-10-21).
 *
 * Antes, o cadastro obrigatório do TOTP era um modal no `/app`: as rotas de API
 * não conferiam nada, e um admin (ou platform admin) que nunca cadastrou o
 * autenticador fazia tudo com a senha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "@/lib/auth/types";

const loadAuthUser = vi.fn<() => Promise<AuthUser | null>>();
let papelNoBanco = "admin";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: () => loadAuthUser(),
  resolveActiveOrg: async (u: AuthUser) =>
    u.organizations[0]
      ? { orgId: u.organizations[0].organization_id, name: "Org", role: u.organizations[0].role }
      : null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: async () => ({ data: papelNoBanco, error: null }) }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-0000-4000-8000-000000000001";

function usuario(role: "admin" | "agent", mfa: boolean, platformAdmin = false): AuthUser {
  return {
    id: "u1",
    email: "u@invariant.test",
    full_name: null,
    avatar_url: null,
    is_platform_admin: platformAdmin,
    organizations: [{ organization_id: ORG, organization_name: "Org", role }],
    mfa_verificado: mfa,
  };
}

async function codigo(r: { ok: boolean; response?: Response }): Promise<string | null> {
  if (r.ok) return null;
  const body = (await r.response!.json()) as { error: { code: string } };
  return body.error.code;
}

describe("requireRole — papel que exige TOTP sem TOTP cadastrado", () => {
  beforeEach(() => loadAuthUser.mockReset());

  it("admin sem autenticador → 403 mfa_enrollment_required", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    papelNoBanco = "admin";
    loadAuthUser.mockResolvedValue(usuario("admin", false));
    const r = await requireRole("agent");
    expect(r.ok).toBe(false);
    expect(await codigo(r)).toBe("mfa_enrollment_required");
  });

  it("platform admin sem autenticador, pelo bypass de platform admin → 403", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    loadAuthUser.mockResolvedValue(usuario("agent", false, true));
    const r = await requireRole("admin", { allowPlatformAdmin: true });
    expect(await codigo(r)).toBe("mfa_enrollment_required");
  });

  it("admin COM autenticador → ok (probe positivo)", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    papelNoBanco = "admin";
    loadAuthUser.mockResolvedValue(usuario("admin", true));
    expect((await requireRole("agent")).ok).toBe(true);
  });

  it("atendente (agent) sem autenticador → ok: o papel não exige TOTP", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    papelNoBanco = "agent";
    loadAuthUser.mockResolvedValue(usuario("agent", false));
    expect((await requireRole("agent")).ok).toBe(true);
  });
});
