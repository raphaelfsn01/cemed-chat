/**
 * Painel do inbox — "Leads recentes" mostra a ETAPA e as TAGS do card.
 *
 * Origem: no teste real de 23/10 o painel imprimiu só "open · —" para um card
 * que estava na etapa Qualificado e tinha a tag medicina_trabalho, e a equipe
 * concluiu que o lead estava sem etapa. Esta spec prova pela TELA, como a
 * pessoa que atende veria, em duas larguras:
 *
 *   - 360px (celular pequeno): o painel vive na gaveta "Detalhes do contato";
 *   - 1440px (desktop): o painel é a terceira coluna do inbox.
 *
 * Além do conteúdo, mede o que não pode estourar: documento, `<main>`, o painel
 * e cada card de lead não rolam na horizontal, e nenhuma tag passa da borda do
 * card — por ferramenta (scrollWidth × clientWidth, getBoundingClientRect), não
 * a olho. Uma das tags do fixture é propositalmente longa e sem espaço para
 * forçar o truncamento.
 *
 * Banco fresco estilo VPS: baseline.sql + scripts/seed-e2e-credentials.ts. As
 * fixtures (funil, contato, conversa, 2 leads) são semeadas aqui, com service
 * role, SEMPRE na org do `.e2e-creds.json`.
 *
 * Evidência: `.superpowers/evidence/2026-10-painel-leads/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Locator, type Page } from "@playwright/test";

import { lerCreds, loginAdmin } from "../journeys/_login";

const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence", "2026-10-painel-leads");
fs.mkdirSync(EVIDENCE, { recursive: true });

const TOLERANCIA_PX = 1;

const CONTATO = "Paciente Painel Leads E2E";
const SESSAO = "e2e-painel-leads-session";
const PIPELINE_SLUG = "e2e-painel-leads";
const TITULO_COM_ETAPA = "Medicina do trabalho — ASO";
const TITULO_SEM_TAGS = "Lead sem tags E2E";
const TAG_LONGA = "tag_muito_longa_sem_espaco_para_forcar_o_truncamento_no_celular_360";

let conversaId = "";

function lerEnvLocal(): Record<string, string> {
  const env: Record<string, string> = {};
  const arquivo = path.join(process.cwd(), ".env.local");
  for (const linha of fs.readFileSync(arquivo, "utf8").split("\n")) {
    const m = linha.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return env;
}

async function semear(): Promise<string> {
  const env = lerEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const orgId = lerCreds().org_id;
  const falha = (etapa: string, erro: { message: string } | null): never => {
    throw new Error(`seed painel-leads (${etapa}): ${erro?.message ?? "sem dados"}`);
  };

  // Sessão de canal
  let sessaoId: string;
  const sessao = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", SESSAO)
    .maybeSingle();
  if (sessao.data) sessaoId = (sessao.data as { id: string }).id;
  else {
    const nova = await admin
      .from("channel_sessions")
      .insert({
        organization_id: orgId,
        waha_session_name: SESSAO,
        display_name: "Número Painel Leads E2E",
        webhook_secret_encrypted: "\\x00",
      } as never)
      .select("id")
      .single();
    if (nova.error || !nova.data) falha("channel_session", nova.error);
    sessaoId = (nova.data as { id: string }).id;
  }

  // Contato
  let contatoId: string;
  const contato = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("display_name", CONTATO)
    .maybeSingle();
  if (contato.data) contatoId = (contato.data as { id: string }).id;
  else {
    const novo = await admin
      .from("contacts")
      .insert({ organization_id: orgId, display_name: CONTATO } as never)
      .select("id")
      .single();
    if (novo.error || !novo.data) falha("contact", novo.error);
    contatoId = (novo.data as { id: string }).id;
  }

  // Conversa aberta, sem dono (o admin enxerga em "Todas")
  const estado = {
    status: "open",
    assigned_to_user_id: null,
    assignee_kind: null,
    assigned_at: null,
    last_message_at: new Date().toISOString(),
    last_message_preview: "Preciso do ASO para admissão",
  };
  const conversa = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contatoId)
    .eq("channel_session_id", sessaoId)
    .maybeSingle();
  let id: string;
  if (conversa.data) {
    id = (conversa.data as { id: string }).id;
    const r = await admin
      .from("conversations")
      .update(estado as never)
      .eq("id", id);
    if (r.error) falha("conversation update", r.error);
  } else {
    const nova = await admin
      .from("conversations")
      .insert({
        organization_id: orgId,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        ...estado,
      } as never)
      .select("id")
      .single();
    if (nova.error || !nova.data) falha("conversation", nova.error);
    id = (nova.data as { id: string }).id;
  }

  // Funil "Atendimento" com duas etapas
  let pipelineId: string;
  const pipeline = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("slug", PIPELINE_SLUG)
    .maybeSingle();
  if (pipeline.data) pipelineId = (pipeline.data as { id: string }).id;
  else {
    const novo = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: orgId,
        name: "Atendimento",
        slug: PIPELINE_SLUG,
        is_default: false,
        position: 9100,
      } as never)
      .select("id")
      .single();
    if (novo.error || !novo.data) falha("pipeline", novo.error);
    pipelineId = (novo.data as { id: string }).id;
  }

  const etapas: Record<string, string> = {};
  for (const [position, nome, slug] of [
    [1, "Novo", "novo"],
    [2, "Qualificado", "qualificado"],
  ] as const) {
    const existente = await admin
      .from("crm_stages")
      .select("id")
      .eq("pipeline_id", pipelineId)
      .eq("slug", slug)
      .maybeSingle();
    if (existente.data) {
      etapas[slug] = (existente.data as { id: string }).id;
      continue;
    }
    const nova = await admin
      .from("crm_stages")
      .insert({
        organization_id: orgId,
        pipeline_id: pipelineId,
        name: nome,
        slug,
        position,
        is_won: false,
        is_lost: false,
        is_archived: false,
      } as never)
      .select("id")
      .single();
    if (nova.error || !nova.data) falha(`stage ${slug}`, nova.error);
    etapas[slug] = (nova.data as { id: string }).id;
  }

  // Dois leads do contato: um com etapa + tags (uma longa), outro sem tags.
  // Recriados a cada rodada (só os do fixture: org + título exatos).
  const del = await admin
    .from("crm_leads")
    .delete()
    .eq("organization_id", orgId)
    .eq("contact_id", contatoId)
    .in("title", [TITULO_COM_ETAPA, TITULO_SEM_TAGS]);
  if (del.error) falha("limpar leads", del.error);

  const agora = Date.now();
  for (const lead of [
    {
      title: TITULO_COM_ETAPA,
      stage_id: etapas.qualificado,
      tags: ["medicina_trabalho", "aso", TAG_LONGA],
      updated_at: new Date(agora).toISOString(),
    },
    {
      title: TITULO_SEM_TAGS,
      stage_id: etapas.novo,
      tags: [],
      updated_at: new Date(agora - 60_000).toISOString(),
    },
  ]) {
    const r = await admin.from("crm_leads").insert({
      organization_id: orgId,
      pipeline_id: pipelineId,
      contact_id: contatoId,
      status: "open",
      source: "manual",
      position_in_stage: 1,
      ...lead,
    } as never);
    if (r.error) falha(`lead ${lead.title}`, r.error);
  }

  return id;
}

/** O painel visível: na gaveta (celular) ou na 3ª coluna (desktop). */
function painel(page: Page): Locator {
  return page.locator("aside:visible").filter({ hasText: "Leads recentes" });
}

interface Medidas {
  documento: [number, number];
  main: [number, number];
  painel: [number, number];
  cards: {
    titulo: string;
    scrollWidth: number;
    clientWidth: number;
    maiorTagDireita: number;
    cardDireita: number;
  }[];
}

async function medir(page: Page): Promise<Medidas> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main")!;
    const aside = Array.from(document.querySelectorAll("aside")).find(
      (a) => a.offsetParent !== null && a.textContent?.includes("Leads recentes"),
    )!;
    const secao = Array.from(aside.querySelectorAll("section")).find(
      (s) => s.querySelector("h3")?.textContent === "Leads recentes",
    )!;
    const cards = Array.from(secao.querySelectorAll("li")).map((li) => {
      const direita = li.getBoundingClientRect().right;
      const tags = Array.from(li.querySelectorAll('[data-testid="lead-tags"] > *'));
      return {
        titulo: li.querySelector(".font-medium")?.textContent ?? "",
        scrollWidth: li.scrollWidth,
        clientWidth: li.clientWidth,
        maiorTagDireita: tags.reduce((m, t) => Math.max(m, t.getBoundingClientRect().right), 0),
        cardDireita: direita,
      };
    });
    return {
      documento: [doc.scrollWidth, doc.clientWidth],
      main: [main.scrollWidth, main.clientWidth],
      painel: [aside.scrollWidth, aside.clientWidth],
      cards,
    };
  });
}

async function provarPainel(page: Page, nome: string): Promise<void> {
  const lista = painel(page);
  await expect(lista).toBeVisible();
  const comEtapa = lista.locator("li").filter({ hasText: TITULO_COM_ETAPA });
  const semTags = lista.locator("li").filter({ hasText: TITULO_SEM_TAGS });

  // Etapa por NOME (nunca o uuid) e as tags do card.
  await expect(comEtapa.getByTestId("lead-etapa")).toHaveText("Etapa: Qualificado");
  const tags = comEtapa.getByTestId("lead-tags");
  await expect(tags).toContainText("medicina_trabalho");
  await expect(tags).toContainText("aso");
  await expect(tags).toContainText(TAG_LONGA.slice(0, 20));
  // O que já aparecia continua aparecendo.
  await expect(comEtapa).toContainText(/open · —/);

  // Lead sem tags: sem bloco de tags, sem resíduo de "undefined"/"null"/vírgula.
  await expect(semTags.getByTestId("lead-etapa")).toHaveText("Etapa: Novo");
  await expect(semTags.getByTestId("lead-tags")).toHaveCount(0);
  const textoSemTags = (await semTags.innerText()).replace(/\s+/g, " ");
  expect(textoSemTags).not.toMatch(/undefined|null|NaN|,\s*$/);
  expect((await lista.innerText()).includes("undefined")).toBe(false);

  await page.waitForTimeout(300);
  const m = await medir(page);
  fs.writeFileSync(path.join(EVIDENCE, `medidas-${nome}.json`), `${JSON.stringify(m)}\n`);
  await page.screenshot({ path: path.join(EVIDENCE, `${nome}.png`) });

  expect(m.documento[0], "documento rola na horizontal").toBeLessThanOrEqual(
    m.documento[1] + TOLERANCIA_PX,
  );
  expect(m.main[0], "<main> rola na horizontal").toBeLessThanOrEqual(m.main[1] + TOLERANCIA_PX);
  expect(m.painel[0], "painel rola na horizontal").toBeLessThanOrEqual(m.painel[1] + TOLERANCIA_PX);
  expect(m.cards.length, "cards de lead medidos").toBeGreaterThanOrEqual(2);
  for (const c of m.cards) {
    expect(c.scrollWidth, `card "${c.titulo}" estoura a largura`).toBeLessThanOrEqual(
      c.clientWidth + TOLERANCIA_PX,
    );
    expect(c.maiorTagDireita, `tag passa da borda do card "${c.titulo}"`).toBeLessThanOrEqual(
      c.cardDireita + TOLERANCIA_PX,
    );
  }
}

test.describe("inbox — Leads recentes mostra etapa e tags do card", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    expect(
      fs.existsSync(path.join(process.cwd(), ".e2e-creds.json")),
      "rode scripts/seed-e2e-credentials.ts",
    ).toBe(true);
    conversaId = await semear();
  });

  test("celular 360px: gaveta Detalhes mostra etapa e tags sem rolagem horizontal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await loginAdmin(page);
    await page.goto(`/app/inbox?filter=all&id=${conversaId}`);
    await expect(page.getByRole("textbox", { name: "Mensagem" })).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Mais ações da conversa" }).click();
    await page.getByRole("menuitem", { name: "Detalhes do contato" }).click();
    await expect(page.getByRole("dialog", { name: "Detalhes do contato" })).toBeVisible();
    await provarPainel(page, "360px");
  });

  test("desktop 1440px: terceira coluna mostra etapa e tags sem rolagem horizontal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    await page.goto(`/app/inbox?filter=all&id=${conversaId}`);
    await expect(page.getByRole("textbox", { name: "Mensagem" })).toBeVisible({ timeout: 30_000 });
    await provarPainel(page, "1440px");
  });
});
