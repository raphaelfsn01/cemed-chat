// @vitest-environment node
//
// A marca nos artefatos que saem do sistema sem passar por tela: o PDF LGPD que
// o paciente recebe e os e-mails de convite e de alarme de IA. Antes do rebrand
// para a CEMED, os três levavam o nome do projeto original em string solta. O
// PDF é renderizado de verdade e lido de volta pelo mesmo extrator do RAG — o
// rodapé é `fixed` no react-pdf, e só o texto extraído prova que ele saiu.

import { afterEach, describe, expect, it } from "vitest";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { DEFAULT_APP_NAME } from "@/lib/branding";
import { buildBudgetAlarmEmail } from "@/lib/email/templates/ai-budget-alarm";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import type { ExportPayload } from "@/lib/lgpd/export-collector";
import { renderLgpdPdf } from "@/lib/lgpd/pdf-renderer";

const APP_NAME_ORIGINAL = process.env.APP_NAME;

afterEach(() => {
  if (APP_NAME_ORIGINAL === undefined) delete process.env.APP_NAME;
  else process.env.APP_NAME = APP_NAME_ORIGINAL;
});

const PAYLOAD_VAZIO: ExportPayload = {
  request_id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  generated_at: "2026-10-21T12:00:00.000Z",
  no_local_footprint: true,
  contact: null,
  consents: [],
  conversations: [],
  messages_count_total: 0,
  messages_recent: [],
  leads: [],
  orders: [],
  activities: [],
  audit_log_extract: [],
};

describe("PDF LGPD entregue ao titular", () => {
  it("o rodapé leva a marca da instalação (padrão: CEMED Saúde)", async () => {
    delete process.env.APP_NAME;
    const texto = await extractPdfText(await renderLgpdPdf(PAYLOAD_VAZIO));

    expect(DEFAULT_APP_NAME).toBe("CEMED Saúde");
    expect(texto).toMatch(/CEMED Saúde\s*·\s*Relatório LGPD Art\. 18 II/);
    expect(texto).not.toMatch(/deskcomm/i);
  });

  it("segue o APP_NAME do .env, não uma string fixa", async () => {
    process.env.APP_NAME = "Clínica Exemplo";
    const texto = await extractPdfText(await renderLgpdPdf(PAYLOAD_VAZIO));

    expect(texto).toMatch(/Clínica Exemplo\s*·\s*Relatório LGPD/);
  });
});

describe("e-mails", () => {
  it("convite: assunto sem o nome repetido e sem o projeto original", () => {
    const email = buildInviteEmail({
      inviterName: "Ana",
      orgName: "CEMED Saúde",
      acceptUrl: "https://app.exemplo.com.br/team/accept-invite/tok",
      role: "agent",
      expiresAt: new Date("2026-10-22T12:00:00.000Z"),
    });

    expect(email.subject).toBe("Ana convidou você para a equipe da CEMED Saúde");
    expect(`${email.subject}\n${email.html}\n${email.text}`).not.toMatch(/deskcomm/i);
  });

  it("alarme de orçamento de IA: assunto termina com a marca da instalação", () => {
    delete process.env.APP_NAME;
    const email = buildBudgetAlarmEmail({
      pct: 82.5,
      consumedCents: 8250,
      limitCents: 10000,
      orgName: "CEMED Saúde",
      dashboardUrl: "https://app.exemplo.com.br/app/settings/ai",
    });

    expect(email.subject).toBe("Alerta IA: orçamento atingiu 82.50% — CEMED Saúde");
    expect(`${email.html}\n${email.text}`).not.toMatch(/deskcomm/i);
  });
});
