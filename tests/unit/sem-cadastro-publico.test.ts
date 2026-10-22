/**
 * Não existe mais cadastro público (auditoria de 2026-10-21, C3).
 *
 * Antes: `/signup` era público e `/auth/confirm` criava uma ORGANIZAÇÃO NOVA, com a
 * pessoa como admin, para todo e-mail confirmado. Com o signup do GoTrue aberto,
 * qualquer pessoa da internet ganhava um tenant no banco da clínica — e com ele
 * acesso de usuário logado às RPCs, ao crédito de IA da instalação e aos webhooks
 * de saída.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { isPublicPath } from "@/lib/auth/public-paths";

const inserts: string[] = [];
let membership: { organization_id: string } | null = null;
const signOut = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      verifyOtp: async () => ({ data: { user: { id: "u-novo", email: "estranho@example.com" } }, error: null }),
      signOut,
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: membership, error: null }),
        insert: () => {
          inserts.push(tabela);
          return b;
        },
        single: async () => ({ data: { id: "x", slug: "x" }, error: null }),
      };
      return b;
    },
  }),
}));

function confirmar(type: string) {
  return new NextRequest(`https://app.example/auth/confirm?token_hash=abc&type=${type}`);
}

describe("sem cadastro público", () => {
  it("/signup não é rota pública", () => {
    expect(isPublicPath("/signup")).toBe(false);
  });

  it("e-mail confirmado de quem não é membro: sem organização nova, sessão encerrada, sem acesso", async () => {
    membership = null;
    const { GET } = await import("@/app/auth/confirm/route");
    const res = await GET(confirmar("signup"));

    expect(res.headers.get("location")).toContain("/login?error=sem_acesso");
    expect(inserts, "criou organização/membership para um estranho").toEqual([]);
    expect(signOut).toHaveBeenCalled();
  });

  it("e-mail confirmado de quem já é membro → entra no app (probe positivo)", async () => {
    membership = { organization_id: "org-1" };
    const { GET } = await import("@/app/auth/confirm/route");
    const res = await GET(confirmar("email"));
    expect(res.headers.get("location")).toMatch(/\/app\/inbox$/);
    expect(inserts).toEqual([]);
  });
});
