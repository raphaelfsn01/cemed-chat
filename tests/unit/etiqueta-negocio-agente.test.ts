/**
 * `etiquetaNegocioDoAgente` — a etiquetagem da triagem pelo agente.
 *
 * O que este arquivo protege:
 *
 * 1. **União, nunca substituição.** É a razão de este módulo existir em vez de
 *    ligar `crm_update_lead` ao modelo: aquele caminho SUBSTITUI o array
 *    (`app/api/v1/leads/_handler.ts:373`) e apagaria a tag que a atendente pôs à
 *    mão. Se alguém trocar a união por atribuição, cai aqui.
 * 2. **Vocabulário fechado.** Tag fora das `canonical_tags` do pipeline é
 *    recusada — deriva silenciosa ("exame"/"exames"/"Exames") estraga relatório
 *    sem ninguém notar.
 * 3. **Ambiguidade não etiqueta.** Contato com dois negócios abertos: marcar o
 *    errado é pior que não marcar.
 * 4. **Banco fora ≠ estado normal.** Erro de rede não pode virar "sem_negocio".
 */
import { describe, expect, it, vi } from "vitest";

import { etiquetaNegocioDoAgente } from "@/lib/leads/agent-tag-sync";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";

const VOCAB = ["medicina_trabalho", "especialidades", "exames", "generico", "outros"];

interface Cenario {
  leads?: unknown[];
  erroLeads?: { message: string } | null;
  settings?: unknown;
  erroPipeline?: { message: string } | null;
  erroUpdate?: { message: string } | null;
}

/** Dublê mínimo do supabase-js: só as duas cadeias que o módulo usa. */
function fakeAdmin(c: Cenario) {
  const updates: Array<Record<string, unknown>> = [];
  const admin = {
    from(tabela: string) {
      if (tabela === "crm_leads") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: c.leads ?? [], error: c.erroLeads ?? null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { eq: () => ({ eq: () => Promise.resolve({ error: c.erroUpdate ?? null }) }) };
          },
        };
      }
      if (tabela === "crm_pipelines") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: c.erroPipeline ? null : { settings: c.settings ?? { canonical_tags: VOCAB } },
                  error: c.erroPipeline ?? null,
                }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  };
  return { admin: admin as never, updates };
}

function leadAberto(over: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organization_id: ORG,
    pipeline_id: PIPELINE,
    status: "open",
    tags: [],
    created_at: "2026-09-01T10:00:00Z",
    last_activity_at: null,
    ...over,
  };
}

describe("etiquetaNegocioDoAgente", () => {
  it("etiqueta o negócio aberto do contato", async () => {
    const { admin, updates } = fakeAdmin({ leads: [leadAberto()] });
    const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
    expect(r.etiquetou).toBe(true);
    expect(r.motivo).toBe("etiquetado");
    expect(updates[0]?.tags).toEqual(["exames"]);
  });

  it("SOMA à tag que já existe — não substitui o que o humano marcou", async () => {
    // O invariante central deste módulo.
    const { admin, updates } = fakeAdmin({ leads: [leadAberto({ tags: ["vip"] })] });
    const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
    expect(r.etiquetou).toBe(true);
    expect(updates[0]?.tags).toEqual(["vip", "exames"]);
  });

  it("não regrava quando a tag já está lá", async () => {
    const { admin, updates } = fakeAdmin({ leads: [leadAberto({ tags: ["exames"] })] });
    const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
    expect(r.motivo).toBe("ja_tem");
    expect(updates).toHaveLength(0);
  });

  it("normaliza caixa e espaço antes de comparar", async () => {
    const { admin, updates } = fakeAdmin({ leads: [leadAberto()] });
    await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["  Exames "] });
    expect(updates[0]?.tags).toEqual(["exames"]);
  });

  describe("vocabulário fechado", () => {
    it("recusa tag fora das canonical_tags e devolve a lista aceita", async () => {
      const { admin, updates } = fakeAdmin({ leads: [leadAberto()] });
      const r = await etiquetaNegocioDoAgente(admin, {
        organizationId: ORG,
        contactId: CONTATO,
        tags: ["cardiologia"],
      });
      expect(r.motivo).toBe("fora_do_vocabulario");
      expect(r.detalhe).toContain("exames"); // a lista volta ao modelo como ensino
      expect(updates).toHaveLength(0);
    });

    it("pipeline sem canonical_tags não vira porta aberta", async () => {
      const { admin, updates } = fakeAdmin({ leads: [leadAberto()], settings: {} });
      const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
      expect(r.motivo).toBe("fora_do_vocabulario");
      expect(updates).toHaveLength(0);
    });
  });

  describe("quando NÃO etiquetar é o certo", () => {
    it("contato sem negócio aberto", async () => {
      const { admin, updates } = fakeAdmin({ leads: [] });
      const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
      expect(r.motivo).toBe("sem_negocio");
      expect(updates).toHaveLength(0);
    });

    it("dois negócios abertos: nenhum é etiquetado", async () => {
      const { admin, updates } = fakeAdmin({
        leads: [leadAberto(), leadAberto({ id: "55555555-5555-4555-8555-555555555555" })],
      });
      const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
      expect(r.motivo).toBe("ambiguo");
      expect(updates).toHaveLength(0);
    });

    it("nenhuma tag informada", async () => {
      const { admin } = fakeAdmin({ leads: [leadAberto()] });
      const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["  "] });
      expect(r.motivo).toBe("fora_do_vocabulario");
    });
  });

  describe("incidente não se disfarça de estado normal", () => {
    it("banco fora ao ler leads vira 'indisponivel', não 'sem_negocio'", async () => {
      // supabase-js não lança em falha de rede — devolve { data: null, error }.
      // Descartar o erro faria queda de banco virar rotina.
      const { admin } = fakeAdmin({ leads: [], erroLeads: { message: "ECONNREFUSED" } });
      const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
      expect(r.motivo).toBe("indisponivel");
      expect(r.detalhe).toContain("ECONNREFUSED");
    });

    it("falha ao gravar vira 'falha_de_escrita'", async () => {
      const { admin } = fakeAdmin({ leads: [leadAberto()], erroUpdate: { message: "deadlock" } });
      const r = await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
      expect(r.motivo).toBe("falha_de_escrita");
      expect(r.etiquetou).toBe(false);
    });
  });

  it("filtra pela organização — nunca etiqueta card de outro tenant", async () => {
    // A cadeia .eq(organization_id).eq(contact_id) é a trava; este teste cobra
    // que ela é usada, via espião no update.
    const espiao = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }));
    const admin = {
      from: (t: string) =>
        t === "crm_leads"
          ? {
              select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [leadAberto()], error: null }) }) }),
              update: () => ({ eq: espiao }),
            }
          : {
              select: () => ({
                eq: () => ({ maybeSingle: () => Promise.resolve({ data: { settings: { canonical_tags: VOCAB } }, error: null }) }),
              }),
            },
    } as never;
    await etiquetaNegocioDoAgente(admin, { organizationId: ORG, contactId: CONTATO, tags: ["exames"] });
    expect(espiao).toHaveBeenCalled();
  });
});
