import { describe, expect, it, vi } from "vitest";

import { getLeadContext, nomeSeguroParaModelo } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { buildOpeningMessage } from "@/lib/agent-engine/agent/inbound-turn";

/**
 * Telefone e e-mail do paciente não podem chegar ao modelo. O banco falso ENTREGA
 * os dois valores (como um select antigo faria) — o contrato é que o resultado
 * não os carrega, e que o select nem peça as colunas.
 */
const TELEFONE = "+5522999990000";
const EMAIL = "x@y.com";
const KNOBS = { historyLimit: 20, maxTokens: 1_000 };
const ENTRADA = { tenantId: "org-1", leadId: "contato-1" };

function dbFalso(nome: { name: string | null; display_name: string | null }) {
  const sqls: string[] = [];
  return {
    sqls,
    db: {
      query: async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("from contacts")) {
          return {
            rows: [
              {
                ...nome,
                email: EMAIL,
                phone_number: TELEFONE,
                tags: [],
                is_blocked: false,
                source: "whatsapp",
                consent: null,
                is_anonymized: false,
              },
            ],
          };
        }
        return { rows: [] };
      },
    },
  };
}

async function contexto(nome: { name: string | null; display_name: string | null }) {
  const { db, sqls } = dbFalso(nome);
  const r = await getLeadContext(db as never, {} as never, ENTRADA, KNOBS);
  if (!r.ok) throw new Error("contexto falhou");
  return { context: r.context, sqls };
}

describe("contexto do agente sem telefone nem e-mail", () => {
  it("o contexto serializado não contém telefone nem e-mail, nem as chaves", async () => {
    const { context } = await contexto({ name: "Maria Souza", display_name: null });
    const json = JSON.stringify(context);
    expect(json).not.toContain("5522999990000");
    expect(json).not.toContain(EMAIL);
    expect("phone" in context.contact).toBe(false);
    expect("email" in context.contact).toBe(false);
  });

  it("o select nem lê as colunas phone_number e email", async () => {
    const { sqls } = await contexto({ name: "Maria Souza", display_name: null });
    const sqlContato = sqls.find((s) => s.includes("from contacts")) ?? "";
    expect(sqlContato).not.toMatch(/phone_number|email/);
  });

  it("a abertura do turno não contém os dois valores", async () => {
    const { context } = await contexto({ name: "Maria Souza", display_name: null });
    const abertura = buildOpeningMessage(null, null, context, "—");
    expect(abertura).not.toContain("5522999990000");
    expect(abertura).not.toContain(EMAIL);
  });
});

describe("nome que é telefone ou e-mail vira contato sem nome", () => {
  it.each([
    ["+55 22 99999-0000"],
    ["(22) 99999-0000"],
    ["5522999990000"],
    ["x@y.com"],
    ["  "],
    ["+55 21 98085-0940"],
    ["João 21980850940"],
    ["+55 21 98085\u20110940"],
    ["\u200E+55 21 98085-0940\u200E"],
    ["\u202A+55 21 98085-0940\u202C"],
    ["Maria x@y.com"],
  ])("%s → null", async (nome) => {
    const { context } = await contexto({ name: nome, display_name: null });
    expect(context.contact.name).toBeNull();
  });

  it("display_name numérico também é barrado, mesmo com name vazio", async () => {
    const { context } = await contexto({ name: null, display_name: "+55 22 99999-0000" });
    expect(context.contact.name).toBeNull();
  });

  it("nome normal continua igual", async () => {
    const { context } = await contexto({ name: "Maria Souza", display_name: null });
    expect(context.contact.name).toBe("Maria Souza");
  });

  it.each(["Maria Souza", "Ana 2", "Dr. João 3º"])("nome normal %s passa", (nome) => {
    expect(nomeSeguroParaModelo(nome)).toBe(nome);
  });

  it("null e vazio viram null", () => {
    expect(nomeSeguroParaModelo(null)).toBeNull();
    expect(nomeSeguroParaModelo("")).toBeNull();
  });

  it("nome com poucos dígitos (< 8) não é barrado", () => {
    expect(nomeSeguroParaModelo("Sala 12")).toBe("Sala 12");
    expect(nomeSeguroParaModelo("1234567")).toBe("1234567");
  });
});

describe("tools que devolvem telefone/e-mail não entram no turno", () => {
  it("crm_get_contact e crm_search_contacts são descartadas mesmo vindo em toolIds", async () => {
    const pickToolsFromMcp = vi.fn(() => ({}));
    vi.resetModules();
    vi.doMock("@/lib/ai/runtime/tools", () => ({ pickToolsFromMcp }));
    vi.doMock("@/lib/ai/runtime/mcp_token", () => ({
      mintEphemeralToken: async () => ({ id: "tok-1" }),
      revokeEphemeralToken: async () => undefined,
    }));
    const { buildMcpTurnTools } = await import("@/lib/agent-engine/edge/crm/mcp-tools");
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await buildMcpTurnTools(
      { supabase: {} } as never,
      { organizationId: "org-1", jobId: "job-1" },
      { toolIds: ["crm_get_contact", "crm_search_contacts", "crm_get_lead"] } as never,
      log as never,
    );

    const chamada = pickToolsFromMcp.mock.calls[0] as unknown as [{ toolIds: string[] }];
    expect(chamada[0].toolIds).toEqual(["crm_get_lead"]);

    // Só as bloqueadas: nada a montar, nem token.
    pickToolsFromMcp.mockClear();
    const vazio = await buildMcpTurnTools(
      { supabase: {} } as never,
      { organizationId: "org-1", jobId: "job-2" },
      { toolIds: ["crm_get_contact", "crm_search_contacts"] } as never,
      log as never,
    );
    expect(vazio).toBeNull();
    expect(pickToolsFromMcp).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/ai/runtime/tools");
    vi.doUnmock("@/lib/ai/runtime/mcp_token");
  });
});
