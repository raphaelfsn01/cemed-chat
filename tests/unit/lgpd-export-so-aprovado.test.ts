import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O worker de exportação só roda pedido APROVADO, e a falha não tira a aprovação.
 *
 * `lgpd.data_request_received` entra no bus por `emit_event`, chamável com a
 * sessão do usuário. O worker só pulava `completed` e tipo errado: um evento
 * emitido sem a aprovação do admin, com o pedido ainda `received`, gerava o PDF
 * com os dados do paciente e o enviava por e-mail. A aprovação passa o pedido
 * para `processing` antes de emitir; é esse estado que o worker exige — a mesma
 * guarda do worker de anonimização (`lgpd-redact-so-aprovado.test.ts`).
 *
 * Como a guarda exige `processing`, a falha não pode mais gravar `received`:
 * a retentativa (teto 3) mantém `processing`.
 */

const findLgpdRequest = vi.fn();
const collectExportData = vi.fn();
const sendExportEmail = vi.fn();
const updates: Record<string, unknown>[] = [];

class EmailNotConfigured extends Error {}
class EmailSendFailed extends Error {}

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/lgpd/repository", () => ({
  findLgpdRequest: (...a: unknown[]) => findLgpdRequest(...a),
}));
vi.mock("@/lib/lgpd/export-collector", () => ({
  collectExportData: (...a: unknown[]) => collectExportData(...a),
}));
vi.mock("@/lib/lgpd/pdf-renderer", () => ({
  renderLgpdPdf: vi.fn(async () => Buffer.from("pdf")),
}));
vi.mock("@/lib/lgpd/pades-signer", () => ({
  isPadesConfigured: () => false,
  signPdfPades: vi.fn(async (b: Buffer) => ({
    signed: b,
    sha256: "0".repeat(64),
    signed_pades: false,
    warning: "unsigned",
  })),
}));
vi.mock("@/lib/lgpd/email-delivery", () => ({
  EmailNotConfigured,
  EmailSendFailed,
  hashEmail: () => "hash-do-email",
  sendExportEmail: (...a: unknown[]) => sendExportEmail(...a),
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
  builder.storage = {
    from: () => ({
      upload: async () => ({ error: null }),
      createSignedUrl: async () => ({
        data: { signedUrl: "https://storage.invalid/assinada" },
        error: null,
      }),
    }),
  };
  return { createAdminClient: () => builder };
});

const { processLgpdExport } = await import("@/workers/lgpd-export-worker");

const ORG = "11111111-0000-4000-8000-000000000001";
const REQ = "22222222-0000-4000-8000-000000000001";

function evento() {
  return {
    id: "33333333-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: "lgpd.data_request_received",
    entity_kind: "lgpd_request",
    entity_id: REQ,
    payload: { request_id: REQ },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function pedido(status: string, attempts = 0) {
  return {
    id: REQ,
    organization_id: ORG,
    status,
    request_type: "data_request",
    scope: "contact",
    attempts,
    contact_id: "44444444-0000-4000-8000-000000000001",
    external_customer_id: null,
    request_payload: { delivery: { address: "titular@exemplo.invalid" } },
  };
}

const DADOS = { contact: { email: null } };

beforeEach(() => {
  findLgpdRequest.mockReset();
  collectExportData.mockReset();
  sendExportEmail.mockReset();
  updates.length = 0;
});

describe("lgpd-export-worker: só pedido aprovado exporta", () => {
  it.each([
    ["received", "not_approved"],
    ["expired", "not_approved"],
    ["pending_review", "not_approved"],
    ["failed", "already_failed"],
    ["completed", "already_completed"],
  ])("pedido %s: pula (%s), não coleta dado nem toca no pedido", async (status, detail) => {
    findLgpdRequest.mockResolvedValue(pedido(status));

    const r = await processLgpdExport(evento());

    expect(r).toMatchObject({ status: "skipped", detail });
    expect(collectExportData).not.toHaveBeenCalled();
    expect(sendExportEmail).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("pedido aprovado (processing): coleta, envia e conclui (probe positivo)", async () => {
    findLgpdRequest.mockResolvedValue(pedido("processing"));
    collectExportData.mockResolvedValue(DADOS);
    sendExportEmail.mockResolvedValue({ messageId: "msg-1" });

    const r = await processLgpdExport(evento());

    expect(r.status).toBe("ok");
    expect(collectExportData).toHaveBeenCalledTimes(1);
    expect(sendExportEmail).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({ status: "completed" });
  });
});

describe("lgpd-export-worker: falha mantém o pedido aprovado para a retentativa", () => {
  it("falha na coleta antes do teto: continua `processing`", async () => {
    findLgpdRequest.mockResolvedValue(pedido("processing"));
    collectExportData.mockRejectedValue(new Error("banco fora"));

    const r = await processLgpdExport(evento());

    expect(r).toMatchObject({ status: "error", detail: "export_failed_will_retry" });
    expect(updates.at(-1)).toMatchObject({ status: "processing" });
    expect(updates.map((u) => u.status)).not.toContain("received");
  });

  it("falha no envio do e-mail: continua `processing`", async () => {
    findLgpdRequest.mockResolvedValue(pedido("processing"));
    collectExportData.mockResolvedValue(DADOS);
    sendExportEmail.mockRejectedValue(new EmailSendFailed("resend 500"));

    const r = await processLgpdExport(evento());

    expect(r).toMatchObject({ status: "error", detail: "email_send_failed" });
    expect(updates.at(-1)).toMatchObject({ status: "processing" });
    expect(updates.map((u) => u.status)).not.toContain("received");
  });

  it("falha no envio do e-mail na 3ª tentativa: vira `failed`", async () => {
    findLgpdRequest.mockResolvedValue(pedido("processing", 2));
    collectExportData.mockResolvedValue(DADOS);
    sendExportEmail.mockRejectedValue(new EmailSendFailed("resend 500"));

    await processLgpdExport(evento());

    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("falha ao carregar o pedido: erro (o dreno tenta de novo), não `skipped`", async () => {
    findLgpdRequest.mockRejectedValue(new Error("banco fora"));

    const r = await processLgpdExport(evento());

    expect(r).toMatchObject({ status: "error", detail: "request_load_failed" });
    expect(collectExportData).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("pedido que não existe: `skipped` (não há o que tentar de novo)", async () => {
    findLgpdRequest.mockResolvedValue(null);

    const r = await processLgpdExport(evento());

    expect(r).toMatchObject({ status: "skipped", detail: "request_not_found" });
  });

  it("falha na 3ª tentativa: vira `failed`", async () => {
    findLgpdRequest.mockResolvedValue(pedido("processing", 2));
    collectExportData.mockRejectedValue(new Error("banco fora"));

    await processLgpdExport(evento());

    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });
});
