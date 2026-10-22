/**
 * `loadAuthUser` diz se a pessoa tem autenticador, a partir do `getUser()` (que o
 * GoTrue valida — não do cookie). Se este mapeamento quebrar, o gate de "admin sem
 * TOTP" fica morto em silêncio: todo mundo pareceria cadastrado, ou ninguém.
 */
import { describe, expect, it, vi } from "vitest";

let fatores: Array<{ status: string }> | undefined;

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1", email: "u@invariant.test", user_metadata: {}, factors: fatores } } }),
    },
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }),
      };
      return b;
    },
  }),
}));

describe("loadAuthUser.mfa_verificado", () => {
  it.each([
    [[{ status: "verified" }], true],
    [[{ status: "unverified" }], false],
    [[], false],
    [undefined, false],
  ])("fatores %j → %s", async (f, esperado) => {
    fatores = f;
    const { loadAuthUser } = await import("@/lib/auth/server");
    expect((await loadAuthUser())?.mfa_verificado).toBe(esperado);
  });
});
