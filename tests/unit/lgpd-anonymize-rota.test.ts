/**
 * POST /api/v1/lgpd/anonymize usa a cascata do RPC (`cascadeRedactContact`).
 *
 * A rota antiga fazia `update contacts set email_normalized = null`, coluna GERADA:
 * o Postgres recusava e nada era anonimizado. Aqui o handler REAL roda com o
 * gate de papel real (`requireRole`); só a sessão, o Supabase e a cascata são
 * dublês. O dublê do Supabase respeita a regra de RLS que a rota assume: só
 * devolve o contato se o chamador for membro da org dele.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthUser, Role } from "@/lib/auth/types";

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const USER = "cccccccc-0000-4000-8000-00000000000c";
const CONTATO_A = "dddddddd-0000-4000-8000-00000000000d";
const CONTATO_B = "eeeeeeee-0000-4000-8000-00000000000e";

const cascadeRedactContact = vi.fn();
const auditMock = vi.fn(async () => undefined);
const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];

const estado = {
  papel: "admin" as Role,
  contatos: new Map<string, Record<string, unknown>>(),
};

vi.mock("@/lib/lgpd/redact-cascade", () => ({
  cascadeRedactContact: (...a: unknown[]) => cascadeRedactContact(...a),
}));
vi.mock("@/lib/audit", () => ({
  audit: (...a: unknown[]) => auditMock(...(a as [])),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async (): Promise<AuthUser> => ({
    id: USER,
    email: "teste@exemplo.invalid",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    mfa_verificado: true,
    organizations: [
      {
        organization_id: ORG_A,
        organization_name: "Org A",
        role: estado.papel,
      } as AuthUser["organizations"][number],
    ],
  }),
  resolveActiveOrg: async () => ({ orgId: ORG_A, name: "Org A", role: estado.papel }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: estado.papel, error: null } : { data: null, error: null },
    from: (table: string) => {
      let filtroId: string | null = null;
      const b = {
        select: () => b,
        eq: (col: string, v: string) => {
          if (col === "id") filtroId = v;
          return b;
        },
        update: (patch: Record<string, unknown>) => {
          updates.push({ table, patch });
          return b;
        },
        maybeSingle: async () => {
          const row = filtroId ? estado.contatos.get(filtroId) : undefined;
          // RLS: só enxerga contato de org da qual é membro (ORG_A).
          const visivel = row && row.organization_id === ORG_A ? row : null;
          return { data: visivel ?? null, error: null };
        },
        then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }),
      };
      return b;
    },
  }),
}));

const { POST } = await import("@/app/api/v1/lgpd/anonymize/route");

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/lgpd/anonymize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const JUSTIFICATIVA = "Solicitação formal do titular";

beforeEach(() => {
  cascadeRedactContact.mockReset();
  cascadeRedactContact.mockResolvedValue({ alreadyAnonymized: false, counts: {}, mediaPaths: [] });
  auditMock.mockClear();
  updates.length = 0;
  estado.papel = "admin";
  estado.contatos = new Map([
    [CONTATO_A, { id: CONTATO_A, organization_id: ORG_A, is_anonymized: false, anonymized_at: null }],
    [CONTATO_B, { id: CONTATO_B, organization_id: ORG_B, is_anonymized: false, anonymized_at: null }],
  ]);
});

describe("POST /api/v1/lgpd/anonymize", () => {
  it("admin da org A anonimiza contato da org A pela cascata, sem update manual", async () => {
    const res = await POST(req({ contact_id: CONTATO_A, justification: JUSTIFICATIVA }));
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.data.contact_id).toBe(CONTATO_A);
    expect(corpo.data.action).toBe("anonymized");
    expect(typeof corpo.data.anonymized_at).toBe("string");

    expect(cascadeRedactContact).toHaveBeenCalledTimes(1);
    expect(cascadeRedactContact.mock.calls[0]![0]).toMatchObject({
      organizationId: ORG_A,
      contactId: CONTATO_A,
    });
    for (const u of updates) expect(u.patch).not.toHaveProperty("email_normalized");
    expect(updates.filter((u) => u.table === "contacts")).toHaveLength(0);
  });

  it("a cascata recebe requestId nulo; o id HTTP fica só na resposta e na auditoria", async () => {
    // `requestId` da cascata vira `request_id` com FK para `lgpd_requests`. O id
    // HTTP é um UUID aleatório que não existe lá: a FK (23503) abortaria o RPC.
    const res = await POST(req({ contact_id: CONTATO_A, justification: JUSTIFICATIVA }));
    expect(res.status).toBe(200);
    expect(cascadeRedactContact.mock.calls[0]![0]).toHaveProperty("requestId", null);

    const idHttp = res.headers.get("X-Request-Id");
    expect(idHttp).toMatch(/^[0-9a-f-]{36}$/);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lgpd.anonymize_executed", requestId: idHttp }),
    );
  });

  it.each(["viewer", "agent", "coordinator"] as Role[])("%s → 403 e a cascata não roda", async (papel) => {
    estado.papel = papel;
    const res = await POST(req({ contact_id: CONTATO_A, justification: JUSTIFICATIVA }));
    expect(res.status).toBe(403);
    expect(cascadeRedactContact).not.toHaveBeenCalled();
  });

  it("admin da org A com contato da org B → 404 e a cascata não roda", async () => {
    const res = await POST(req({ contact_id: CONTATO_B, justification: JUSTIFICATIVA }));
    expect([403, 404]).toContain(res.status);
    expect(cascadeRedactContact).not.toHaveBeenCalled();
  });

  it.each([
    ["justificativa curta", { contact_id: CONTATO_A, justification: "curta" }],
    ["contact_id inválido", { contact_id: "nao-e-uuid", justification: JUSTIFICATIVA }],
    ["corpo vazio", {}],
  ])("corpo inválido (%s) → 422 e a cascata não roda", async (_nome, corpo) => {
    const res = await POST(req(corpo));
    expect(res.status).toBe(422);
    expect(cascadeRedactContact).not.toHaveBeenCalled();
  });

  it("contato já anonimizado → 200 com action already_anonymized, sem cascata", async () => {
    estado.contatos.set(CONTATO_A, {
      id: CONTATO_A,
      organization_id: ORG_A,
      is_anonymized: true,
      anonymized_at: "2026-10-01T00:00:00.000Z",
    });
    const res = await POST(req({ contact_id: CONTATO_A, justification: JUSTIFICATIVA }));
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.data).toMatchObject({
      contact_id: CONTATO_A,
      anonymized_at: "2026-10-01T00:00:00.000Z",
      action: "already_anonymized",
    });
    expect(cascadeRedactContact).not.toHaveBeenCalled();
  });

  it("falha da cascata → 500 e nenhuma auditoria de sucesso", async () => {
    cascadeRedactContact.mockRejectedValueOnce(new Error("rpc failed"));
    const res = await POST(req({ contact_id: CONTATO_A, justification: JUSTIFICATIVA }));
    expect(res.status).toBe(500);
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "lgpd.anonymize_executed" }),
    );
  });
});
