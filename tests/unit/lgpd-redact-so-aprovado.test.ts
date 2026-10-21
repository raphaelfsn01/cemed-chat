import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O worker de anonimização só roda pedido APROVADO (auditoria de 2026-10-21).
 *
 * `lgpd.redact_received` entra no bus por `emit_event`, que é chamável com a
 * sessão do usuário. Antes, o worker rodava qualquer pedido que não estivesse
 * `completed`/`failed` — um evento emitido sem a aprovação do admin, com o pedido
 * ainda `received`, anonimizava o paciente de forma irreversível. A aprovação
 * passa o pedido para `processing` antes de emitir; é esse estado que o worker
 * exige.
 */

const findLgpdRequest = vi.fn();
const cascadeRedactContact = vi.fn();
const updates: Record<string, unknown>[] = [];

vi.mock("@/lib/lgpd/repository", () => ({
  findLgpdRequest: (...a: unknown[]) => findLgpdRequest(...a),
  findContactByExternalId: vi.fn(async () => null),
}));
vi.mock("@/lib/lgpd/redact-cascade", () => ({
  cascadeRedactContact: (...a: unknown[]) => cascadeRedactContact(...a),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => {
  // Encadeável e awaitable: cada `update(...)` registra o patch; o resto devolve
  // o próprio builder até o `await`.
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "in", "single", "maybeSingle", "insert", "rpc"]) {
    builder[m] = () => builder;
  }
  builder.update = (patch: Record<string, unknown>) => {
    updates.push(patch);
    return builder;
  };
  builder.then = (ok: (v: unknown) => unknown) => ok({ data: null, error: null });
  return { createAdminClient: () => builder };
});

const { processLgpdRedact } = await import("@/workers/lgpd-redact-worker");

const ORG = "11111111-0000-4000-8000-000000000001";
const REQ = "22222222-0000-4000-8000-000000000001";

function evento() {
  return {
    id: "33333333-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: "lgpd.redact_received",
    entity_kind: "lgpd_request",
    entity_id: REQ,
    payload: { request_id: REQ },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function pedido(status: string) {
  return {
    id: REQ,
    organization_id: ORG,
    status,
    request_type: "redact",
    scope: "contact",
    attempts: 0,
    contact_id: "44444444-0000-4000-8000-000000000001",
    external_customer_id: null,
    request_payload: {},
  };
}

beforeEach(() => {
  findLgpdRequest.mockReset();
  cascadeRedactContact.mockReset();
  updates.length = 0;
});

describe("lgpd-redact-worker: só pedido aprovado anonimiza", () => {
  it.each(["received", "expired"])(
    "pedido %s (sem aprovação): pula, não toca no contato nem no pedido",
    async (status) => {
      findLgpdRequest.mockResolvedValue(pedido(status));

      const r = await processLgpdRedact(evento());

      expect(r).toMatchObject({ status: "skipped", detail: "not_approved" });
      expect(cascadeRedactContact).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    },
  );

  it("pedido aprovado (processing): segue para a anonimização (probe positivo)", async () => {
    findLgpdRequest.mockResolvedValue(pedido("processing"));
    cascadeRedactContact.mockResolvedValue({ already_anonymized: false, counts: {}, media_paths: [] });

    await processLgpdRedact(evento());

    expect(cascadeRedactContact).toHaveBeenCalledTimes(1);
  });
});
