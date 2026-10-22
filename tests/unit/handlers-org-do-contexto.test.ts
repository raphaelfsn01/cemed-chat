/**
 * Os handlers compartilhados só tocam a organização do CONTEXTO (auditoria de
 * 2026-10-21, A6).
 *
 * O MCP, a automação e o agente chamam estes handlers com o service role, que
 * ignora o RLS. Antes, a conversa era buscada só por `id` e os leads listados sem
 * filtro de org: um token MCP da org A enviava WhatsApp numa conversa da org B
 * (pelo número dela), listava os leads de todas as organizações e editava lead
 * alheio.
 *
 * O dublê APLICA os filtros `eq`/`is` de verdade — um stub de linha fixa deixaria
 * o teste verde com o filtro apagado do handler, medindo o dublê e não o código.
 */
import { describe, expect, it } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { createLeadHandler, listLeadsHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

type Row = Record<string, unknown>;

/** Banco em memória com o subconjunto do query builder que os handlers usam. */
function banco(tabelas: Record<string, Row[]>) {
  const escritas: Array<{ tabela: string; op: string; row?: Row }> = [];

  function builder(tabela: string) {
    const filtros: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let patch: Row | null = null;
    let novo: Row | null = null;
    let limite: number | null = null;

    const linhas = () => (tabelas[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
    const executar = () => {
      if (op === "insert") {
        const row = { id: crypto.randomUUID(), ...novo };
        (tabelas[tabela] ??= []).push(row);
        escritas.push({ tabela, op, row });
        return [row];
      }
      const alvo = linhas();
      if (op === "update") {
        for (const r of alvo) Object.assign(r, patch);
        escritas.push({ tabela, op });
      }
      return limite === null ? alvo : alvo.slice(0, limite);
    };

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filtros.push((r) => r[col] === val);
        return b;
      },
      is: (col: string, val: unknown) => {
        filtros.push((r) => (r[col] ?? null) === val);
        return b;
      },
      order: () => b,
      or: () => b,
      limit: (n: number) => {
        limite = n;
        return b;
      },
      update: (p: Row) => {
        op = "update";
        patch = p;
        return b;
      },
      insert: (r: Row) => {
        op = "insert";
        novo = r;
        return b;
      },
      maybeSingle: async () => ({ data: executar()[0] ?? null, error: null }),
      single: async () => {
        const r = executar()[0];
        return r ? { data: r, error: null } : { data: null, error: { message: "no rows" } };
      },
      then: (ok: (v: unknown) => unknown) => ok({ data: executar(), error: null }),
    };
    return b;
  }

  const client = {
    from: (t: string) => builder(t),
    rpc: () => ({ then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null }) }),
  };
  return { client: client as never, escritas, tabelas };
}

const ctxA: HandlerCtx = {
  organization_id: ORG_A,
  actor: { type: "user", id: "u-a" },
  requestId: "req-a6",
};

describe("sendMessageHandler — conversa só da org do contexto", () => {
  it("conversa da org B com contexto da org A → 404 e nenhuma mensagem gravada", async () => {
    const db = banco({
      conversations: [{ id: "conv-b", organization_id: ORG_B, contact_id: "c-b", channel_session_id: "s-b" }],
      messages: [],
    });

    await expect(
      sendMessageHandler(db.client, ctxA, { conversation_id: "conv-b", type: "text", body: "oi" } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.escritas.filter((e) => e.tabela === "messages")).toEqual([]);
  });
});

describe("leads — lista, edição e vínculo de contato só na org do contexto", () => {
  const leads = () => [
    { id: "lead-a", organization_id: ORG_A, title: "A", created_at: "2026-10-01", stage_id: "st-a", pipeline_id: "p-a" },
    { id: "lead-b", organization_id: ORG_B, title: "B", created_at: "2026-10-02", stage_id: "st-b", pipeline_id: "p-b" },
  ];

  it("listar com o contexto da org A não traz o lead da org B", async () => {
    const db = banco({ crm_leads: leads() });
    const r = await listLeadsHandler(db.client, ctxA, {} as never);
    expect(r.leads.map((l) => l.id)).toEqual(["lead-a"]);
  });

  it("editar o lead da org B com o contexto da org A → 404 e nada muda", async () => {
    const db = banco({ crm_leads: leads() });
    await expect(updateLeadHandler(db.client, ctxA, "lead-b", { title: "invadido" } as never)).rejects.toMatchObject({
      status: 404,
    });
    expect(db.tabelas.crm_leads!.find((l) => l.id === "lead-b")?.title).toBe("B");
  });

  it("criar lead na org A ligado a contato da org B → 422 e nenhum lead criado", async () => {
    const db = banco({
      crm_stages: [{ id: "st-a", pipeline_id: "p-a", organization_id: ORG_A }],
      contacts: [{ id: "contato-b", organization_id: ORG_B }],
      crm_leads: [],
    });
    await expect(
      createLeadHandler(db.client, ctxA, {
        pipeline_id: "p-a",
        stage_id: "st-a",
        title: "novo",
        contact_id: "contato-b",
        source: "api",
      } as never),
    ).rejects.toMatchObject({ status: 422 });
    expect(db.tabelas.crm_leads).toEqual([]);
  });
});
