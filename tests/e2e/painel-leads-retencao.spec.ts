/**
 * Aviso de retenção (RetentionNotice) — prova pela TELA do veto `handoff_ativo`
 * e a regressão do `contato_bloqueado`.
 *
 * Caminho REAL: semeia uma linha em `before_send_traces` (vetoed_gate/vetoed_code)
 * e deixa a rota /api/v1/conversations/[id]/retention e o hook useRetention
 * trazerem o aviso. Nada de interceptação de rota.
 *
 *   - handoff_ativo: "Conversa com a equipe", texto de equipe, estilo NEUTRO
 *     (não o vermelho de conformidade). 360px e 1440px.
 *   - contato_bloqueado (regressão): continua "Resposta bloqueada por
 *     conformidade", com o texto de opt-out e o estilo de alerta. 360px.
 *
 * Medidas por ferramenta: o próprio aviso, o contêiner dele, o <main> e o
 * documento não rolam na horizontal.
 *
 * Evidência: `.superpowers/evidence/2026-10-painel-leads/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginAdmin } from "../journeys/_login";

const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence", "2026-10-painel-leads");
fs.mkdirSync(EVIDENCE, { recursive: true });

const TOLERANCIA_PX = 1;
const CONTATO = "Paciente Retenção E2E";
const SESSAO = "e2e-painel-retencao-session";

let conversaId = "";
let semearVeto: (code: string, gate: string) => Promise<void>;

function lerEnvLocal(): Record<string, string> {
  const env: Record<string, string> = {};
  const arquivo = path.join(process.cwd(), ".env.local");
  for (const linha of fs.readFileSync(arquivo, "utf8").split("\n")) {
    const m = linha.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return env;
}

async function preparar(): Promise<void> {
  const env = lerEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const orgId = lerCreds().org_id;
  const ok = <T>(etapa: string, r: { data: T | null; error: { message: string } | null }): T => {
    if (r.error || !r.data) throw new Error(`seed retencao (${etapa}): ${r.error?.message}`);
    return r.data;
  };

  const sessao = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", SESSAO)
    .maybeSingle();
  const sessaoId =
    (sessao.data as { id: string } | null)?.id ??
    ok<{ id: string }>(
      "channel_session",
      await admin
        .from("channel_sessions")
        .insert({
          organization_id: orgId,
          waha_session_name: SESSAO,
          display_name: "Número Retenção E2E",
          webhook_secret_encrypted: "\\x00",
        } as never)
        .select("id")
        .single(),
    ).id;

  const contato = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("display_name", CONTATO)
    .maybeSingle();
  const contatoId =
    (contato.data as { id: string } | null)?.id ??
    ok<{ id: string }>(
      "contact",
      await admin
        .from("contacts")
        .insert({ organization_id: orgId, display_name: CONTATO } as never)
        .select("id")
        .single(),
    ).id;

  const estado = {
    status: "open",
    assigned_to_user_id: null,
    assignee_kind: null,
    assigned_at: null,
    last_message_at: new Date().toISOString(),
    last_message_preview: "Quero falar com alguém",
  };
  const conversa = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contatoId)
    .eq("channel_session_id", sessaoId)
    .maybeSingle();
  if (conversa.data) {
    conversaId = (conversa.data as { id: string }).id;
    ok(
      "conversation update",
      await admin
        .from("conversations")
        .update(estado as never)
        .eq("id", conversaId)
        .select("id")
        .single(),
    );
  } else {
    conversaId = ok<{ id: string }>(
      "conversation",
      await admin
        .from("conversations")
        .insert({
          organization_id: orgId,
          contact_id: contatoId,
          channel_session_id: sessaoId,
          ...estado,
        } as never)
        .select("id")
        .single(),
    ).id;
  }

  // Um único veto por vez: apaga os do contato (só deste fixture) e insere o pedido.
  semearVeto = async (code, gate) => {
    const del = await admin
      .from("before_send_traces")
      .delete()
      .eq("organization_id", orgId)
      .eq("contact_id", contatoId);
    if (del.error) throw new Error(`seed retencao (limpar traces): ${del.error.message}`);
    // O trace pertence a um job_queue (FK). 'done' para nenhum worker pegá-lo.
    const jobId = randomUUID();
    const job = await admin.from("job_queue").insert({
      id: jobId,
      organization_id: orgId,
      contact_id: contatoId,
      kind: "inbound_turn",
      status: "done",
    } as never);
    if (job.error) throw new Error(`seed retencao (job_queue): ${job.error.message}`);
    const ins = await admin.from("before_send_traces").insert({
      organization_id: orgId,
      channel_session_id: sessaoId,
      contact_id: contatoId,
      job_id: jobId,
      trace: [],
      vetoed_gate: gate,
      vetoed_code: code,
    } as never);
    if (ins.error) throw new Error(`seed retencao (trace ${code}): ${ins.error.message}`);
  };
}

async function abrirConversa(page: Page, largura: number, altura: number): Promise<void> {
  await page.setViewportSize({ width: largura, height: altura });
  await loginAdmin(page);
  await page.goto(`/app/inbox?filter=all&id=${conversaId}`);
  await expect(page.getByRole("textbox", { name: "Mensagem" })).toBeVisible({ timeout: 30_000 });
}

/** Mede o aviso, o contêiner dele, o <main> e o documento. */
async function medirAviso(page: Page, nome: string): Promise<void> {
  const m = await page.evaluate(() => {
    const aviso = document.querySelector<HTMLElement>('[data-testid="retention-notice"]')!;
    const pai = aviso.parentElement!;
    const doc = document.documentElement;
    const main = document.querySelector("main")!;
    const r = aviso.getBoundingClientRect();
    return {
      aviso: [aviso.scrollWidth, aviso.clientWidth],
      conteiner: [pai.scrollWidth, pai.clientWidth],
      main: [main.scrollWidth, main.clientWidth],
      documento: [doc.scrollWidth, doc.clientWidth],
      avisoDireita: r.right,
      janela: window.innerWidth,
      corDoBorda: getComputedStyle(aviso).borderTopColor,
      corDoTexto: getComputedStyle(aviso).color,
    };
  });
  fs.writeFileSync(path.join(EVIDENCE, `medidas-${nome}.json`), `${JSON.stringify(m)}\n`);
  expect(m.aviso[0], "aviso rola na horizontal").toBeLessThanOrEqual(m.aviso[1]! + TOLERANCIA_PX);
  expect(m.conteiner[0], "contêiner do aviso rola na horizontal").toBeLessThanOrEqual(
    m.conteiner[1]! + TOLERANCIA_PX,
  );
  expect(m.main[0], "<main> rola na horizontal").toBeLessThanOrEqual(m.main[1]! + TOLERANCIA_PX);
  expect(m.documento[0], "documento rola na horizontal").toBeLessThanOrEqual(
    m.documento[1]! + TOLERANCIA_PX,
  );
  expect(m.avisoDireita, "aviso passa da janela").toBeLessThanOrEqual(m.janela + TOLERANCIA_PX);
}

test.describe("inbox — aviso de retenção (RetentionNotice)", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    expect(
      fs.existsSync(path.join(process.cwd(), ".e2e-creds.json")),
      "rode scripts/seed-e2e-credentials.ts",
    ).toBe(true);
    await preparar();
  });

  for (const [nome, largura, altura] of [
    ["handoff-360px", 360, 740],
    ["handoff-1440px", 1440, 900],
  ] as const) {
    test(`handoff_ativo em ${largura}px: "Conversa com a equipe", tom neutro, sem rolagem`, async ({
      page,
    }) => {
      await semearVeto("handoff_ativo", "stop");
      await abrirConversa(page, largura, altura);

      const aviso = page.getByTestId("retention-notice");
      await expect(aviso).toBeVisible({ timeout: 30_000 });
      await expect(aviso).toContainText("Conversa com a equipe");
      await expect(aviso).toContainText("A conversa está com a equipe. O automático está pausado.");
      await expect(aviso).not.toContainText(/bloqueada|conformidade/i);
      // Neutro: não é o vermelho de conformidade (`text-destructive`/`border-destructive`).
      await expect(aviso).not.toHaveClass(/destructive/);
      await expect(aviso).toHaveClass(/bg-muted/);

      await medirAviso(page, nome);
      await aviso.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(EVIDENCE, `retencao-${nome}.png`) });
    });
  }

  test("contato_bloqueado em 360px (regressão): título e texto de opt-out intactos", async ({
    page,
  }) => {
    await semearVeto("contato_bloqueado", "stop");
    await abrirConversa(page, 360, 740);

    const aviso = page.getByTestId("retention-notice");
    await expect(aviso).toBeVisible({ timeout: 30_000 });
    await expect(aviso).toContainText("Resposta bloqueada por conformidade");
    await expect(aviso).toContainText(
      "O contato pediu para não receber mensagens (opt-out). Nada será enviado a ele.",
    );
    await expect(aviso).not.toContainText("Conversa com a equipe");
    await expect(aviso).toHaveClass(/destructive/);

    await medirAviso(page, "contato-bloqueado-360px");
    await page.screenshot({ path: path.join(EVIDENCE, "retencao-contato-bloqueado-360px.png") });
  });
});
