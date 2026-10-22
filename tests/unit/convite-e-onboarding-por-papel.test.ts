/**
 * Ninguém se promove por link nem pelo onboarding (auditoria de 2026-10-21, C4/M5).
 *
 * Antes: as actions de onboarding exigiam só login (um `viewer` se convidava como
 * admin — o link volta na resposta quando não há e-mail configurado), e aceitar
 * convite SOBRESCREVIA o papel de quem já era membro e REATIVAVA removido.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

// ---------------------------------------------------------------------------
// aplicarConvite — regra única do aceite
// ---------------------------------------------------------------------------

const ORG = "11111111-0000-4000-8000-000000000001";
const USER = "22222222-0000-4000-8000-000000000002";

type Linha = { id: string; user_id: string; organization_id: string; role: string; revoked_at: string | null };

function dbDeMembership(inicial: Linha | null) {
  const estado = { linha: inicial ? { ...inicial } : null, inserts: 0, updates: 0 };
  const builder = () => {
    let op: "select" | "update" | "insert" = "select";
    let dados: Record<string, unknown> = {};
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      update: (p: Record<string, unknown>) => ((op = "update"), (dados = p), b),
      insert: (p: Record<string, unknown>) => ((op = "insert"), (dados = p), b),
      maybeSingle: async () => ({ data: estado.linha, error: null }),
      single: async () => {
        estado.inserts++;
        estado.linha = { id: "novo", ...(dados as Omit<Linha, "id">) };
        return { data: { id: "novo" }, error: null };
      },
      then: (ok: (v: unknown) => unknown) => {
        if (op === "update" && estado.linha) {
          estado.updates++;
          Object.assign(estado.linha, dados);
        }
        return ok({ error: null });
      },
    };
    return b;
  };
  return { client: { from: () => builder() } as never, estado };
}

const agora = () => Math.floor(Date.now() / 1000);
const convite = (role: string, iat: number) => ({
  invite_id: "inv",
  email: "x@invariant.test",
  organization_id: ORG,
  role,
  exp: iat + 86400,
  iat,
});

describe("aplicarConvite", () => {
  it("membro ATIVO com convite de papel maior continua com o papel que tinha", async () => {
    const { aplicarConvite } = await import("@/lib/team/aplicar-convite");
    const db = dbDeMembership({ id: "m1", user_id: USER, organization_id: ORG, role: "viewer", revoked_at: null });

    const r = await aplicarConvite(db.client, USER, convite("admin", agora()));

    expect(r).toEqual({ ok: true, efeito: "ja_era_membro" });
    expect(db.estado.linha?.role).toBe("viewer");
    expect(db.estado.updates).toBe(0);
  });

  it("removido NÃO volta com convite emitido antes da remoção", async () => {
    const { aplicarConvite } = await import("@/lib/team/aplicar-convite");
    const removidoEm = new Date().toISOString();
    const db = dbDeMembership({ id: "m1", user_id: USER, organization_id: ORG, role: "agent", revoked_at: removidoEm });

    const r = await aplicarConvite(db.client, USER, convite("agent", agora() - 3600));

    expect(r).toEqual({ ok: false, erro: "convite_anterior_a_remocao" });
    expect(db.estado.linha?.revoked_at).toBe(removidoEm);
  });

  it("removido volta com convite emitido DEPOIS da remoção (decisão nova do admin)", async () => {
    const { aplicarConvite } = await import("@/lib/team/aplicar-convite");
    const db = dbDeMembership({
      id: "m1",
      user_id: USER,
      organization_id: ORG,
      role: "agent",
      revoked_at: new Date(Date.now() - 3_600_000).toISOString(),
    });

    const r = await aplicarConvite(db.client, USER, convite("agent", agora()));

    expect(r).toEqual({ ok: true, efeito: "reativado" });
    expect(db.estado.linha?.revoked_at).toBeNull();
  });

  it("sem membership: entra com o papel do convite", async () => {
    const { aplicarConvite } = await import("@/lib/team/aplicar-convite");
    const db = dbDeMembership(null);

    const r = await aplicarConvite(db.client, USER, convite("agent", agora()));

    expect(r).toEqual({ ok: true, efeito: "entrou" });
    expect(db.estado.linha?.role).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// requireOnboardingCtx — só admin
// ---------------------------------------------------------------------------

const loadAuthUser = vi.fn<() => Promise<AuthUser | null>>();
const resolveActiveOrg = vi.fn();
let onboardedAt: string | null = null;

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: () => loadAuthUser(),
  resolveActiveOrg: (u: AuthUser) => resolveActiveOrg(u),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { onboarding_state: {}, onboarded_at: onboardedAt }, error: null }),
      };
      return b;
    },
  }),
}));

function usuario(mfa: boolean): AuthUser {
  return {
    id: USER,
    email: "u@invariant.test",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [],
    mfa_verificado: mfa,
  };
}

describe("requireOnboardingCtx", () => {
  beforeEach(() => {
    onboardedAt = null;
    loadAuthUser.mockReset();
    resolveActiveOrg.mockReset();
  });

  it.each(["viewer", "agent", "coordinator", "manager"])("%s → forbidden (não configura o início nem convida)", async (role) => {
    const { requireOnboardingCtx } = await import("@/app/actions/onboarding/_shared");
    loadAuthUser.mockResolvedValue(usuario(true));
    resolveActiveOrg.mockResolvedValue({ orgId: ORG, name: "Org", role });
    await expect(requireOnboardingCtx()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("admin no primeiro acesso (onboarding aberto, ainda sem TOTP) → ok", async () => {
    const { requireOnboardingCtx } = await import("@/app/actions/onboarding/_shared");
    loadAuthUser.mockResolvedValue(usuario(false));
    resolveActiveOrg.mockResolvedValue({ orgId: ORG, name: "Org", role: "admin" });
    await expect(requireOnboardingCtx()).resolves.toMatchObject({ orgId: ORG, role: "admin" });
  });

  it("admin sem TOTP depois do onboarding concluído → forbidden", async () => {
    const { requireOnboardingCtx } = await import("@/app/actions/onboarding/_shared");
    onboardedAt = "2026-10-01T00:00:00Z";
    loadAuthUser.mockResolvedValue(usuario(false));
    resolveActiveOrg.mockResolvedValue({ orgId: ORG, name: "Org", role: "admin" });
    await expect(requireOnboardingCtx()).rejects.toMatchObject({ code: "forbidden" });
  });
});
