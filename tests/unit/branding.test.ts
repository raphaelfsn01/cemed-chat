import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_APP_NAME, resolveBranding, resolveSupportEmail } from "@/lib/branding";

const RAIZ = process.cwd();

describe("resolveBranding", () => {
  it("cai no padrão quando não há marca configurada", () => {
    expect(resolveBranding(undefined, undefined)).toEqual({
      name: DEFAULT_APP_NAME,
      logoUrl: null,
      initial: "C",
    });
  });

  it("trata string vazia e só-espaços como ausência de marca", () => {
    // `install.sh` grava a chave declarada mesmo quando o operador não responde
    // (APP_NAME=), então "vazio" chega como string — não como undefined. Tratar
    // isso como marca válida deixaria a interface sem nome nenhum.
    expect(resolveBranding("", "").name).toBe(DEFAULT_APP_NAME);
    expect(resolveBranding("   ", "   ").name).toBe(DEFAULT_APP_NAME);
    expect(resolveBranding("   ", "   ").logoUrl).toBeNull();
  });

  it("usa a marca configurada e deriva a inicial", () => {
    const b = resolveBranding("  Vendas Turbo  ", "  https://cdn.exemplo.com/logo.svg  ");
    expect(b.name).toBe("Vendas Turbo");
    expect(b.logoUrl).toBe("https://cdn.exemplo.com/logo.svg");
    expect(b.initial).toBe("V");
  });

  it("mantém o nome mas dispensa o logo quando só o nome é configurado", () => {
    const b = resolveBranding("Acme CRM", undefined);
    expect(b.name).toBe("Acme CRM");
    expect(b.logoUrl).toBeNull();
  });

  it("não parte code point ao derivar a inicial", () => {
    // `[0]` cru devolveria metade do par substituto e renderizaria caractere
    // inválido na sidebar recolhida.
    expect(resolveBranding("🚀 Foguete", null).initial).toBe("🚀");
    expect(resolveBranding("Ótimo CRM", null).initial).toBe("Ó");
  });
});

describe("resolveSupportEmail", () => {
  it("sem SUPPORT_EMAIL não há e-mail — a tela manda falar com o responsável", () => {
    // Vazio chega como string (a chave declarada no .env sem valor), não como
    // undefined. Um "mailto:" vazio seria um link que não leva a lugar nenhum.
    expect(resolveSupportEmail(undefined)).toBeNull();
    expect(resolveSupportEmail("")).toBeNull();
    expect(resolveSupportEmail("   ")).toBeNull();
  });

  it("devolve o e-mail configurado, aparado", () => {
    expect(resolveSupportEmail("  contato@exemplo.com.br  ")).toBe("contato@exemplo.com.br");
  });
});

describe("guarda de white-label (self-host)", () => {
  const branding = fs.readFileSync(path.join(RAIZ, "lib/branding.ts"), "utf8");
  const publicEnvScript = fs.readFileSync(
    path.join(RAIZ, "app/public-env-script.tsx"),
    "utf8",
  );

  it("não usa prefixo NEXT_PUBLIC_ para a marca", () => {
    // POR QUE ESTE TESTE EXISTE: a convenção do Next empurra qualquer valor lido
    // no browser para NEXT_PUBLIC_*, e alguém vai "corrigir" isso um dia. Mas
    // NEXT_PUBLIC_* é queimada no bundle durante o `next build`, e o self-hoster
    // roda uma imagem PRÉ-BUILDADA: a marca dele nunca apareceria. O defeito
    // passaria em typecheck, lint e em toda a suíte, funcionaria em dev e na
    // Vercel, e falharia apenas na VPS de quem a feature existe para servir.
    expect(branding).not.toMatch(/NEXT_PUBLIC_APP_(NAME|LOGO_URL)/);
    expect(publicEnvScript).not.toMatch(/NEXT_PUBLIC_APP_(NAME|LOGO_URL)/);
  });

  it("injeta a marca em runtime pelo PublicEnvScript", () => {
    // Sem estas duas chaves no payload, os client components (Sidebar,
    // AdminSidebar) caem no padrão e só a marca do servidor muda — a instalação
    // ficaria com o nome do revendedor no título da aba e o nosso na sidebar.
    expect(publicEnvScript).toMatch(/APP_NAME:\s*env\.APP_NAME/);
    expect(publicEnvScript).toMatch(/APP_LOGO_URL:\s*env\.APP_LOGO_URL/);
  });

  it("o nome do projeto original não volta ao código que vira tela, e-mail, PDF ou arquivo servido", () => {
    // O CEMED Chat é fork do DeskcommCRM (ver NOTICE). O nome antigo saía em
    // e-mail, no PDF LGPD do paciente e em contato de suporte por string solta,
    // fora do branding(). As exceções abaixo são casadas pelo TOKEN, não pelo
    // arquivo: um "DeskcommCRM" novo num arquivo que já tem o cookie reprova.
    const IDENTIFICADORES_MANTIDOS: Record<string, string> = {
      "sb-deskcomm-auth": "cookie de sessão — trocar desloga todo mundo",
      "deskcomm-impersonate": "cookie de impersonação do super-admin",
      "deskcomm-theme": "chave do tema no localStorage — trocar zera a preferência de cada pessoa",
      "deskcomm.show_ai_citations": "chave de debug no localStorage",
      "deskcomm.designshowcase.v1": "chave do showcase /design no localStorage",
    };
    const ARQUIVOS_DE_PROCEDENCIA: Record<string, string> = {
      "lib/agent-engine/db/repository.ts": "comentário do porte Vendaval → DeskcommCRM",
      "lib/system/changelog.test.ts": "fixture do CHANGELOG real do projeto original",
    };

    const alvos: string[] = [];
    const varrer = (dir: string, aceita: (rel: string) => boolean) => {
      for (const entrada of fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entrada.name);
        if (entrada.isDirectory()) varrer(rel, aceita);
        else if (aceita(rel)) alvos.push(rel);
      }
    };
    const codigo = (rel: string) => /\.tsx?$/.test(rel);
    for (const dir of ["app", "components", "lib", "hooks"]) varrer(dir, codigo);
    varrer("supabase/templates", () => true);
    varrer("public", (rel) => !/\.(png|jpe?g|gif|webp|ico)$/.test(rel));

    const reincidentes: string[] = [];
    for (const f of alvos) {
      if (f in ARQUIVOS_DE_PROCEDENCIA) continue;
      const tokens = fs.readFileSync(path.join(RAIZ, f), "utf8").match(/[\w.-]*deskcomm[\w.-]*/gi) ?? [];
      for (const t of tokens) if (!(t in IDENTIFICADORES_MANTIDOS)) reincidentes.push(`${f}: ${t}`);
    }
    expect(
      reincidentes,
      `o nome do projeto original voltou — para o nome da marca use branding() de lib/branding.ts:\n` +
        reincidentes.map((r) => `  ${r}`).join("\n"),
    ).toEqual([]);
  });
});
