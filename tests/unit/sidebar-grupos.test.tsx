/**
 * Sidebar agrupado por objetivo. O que estes testes protegem:
 *
 *  - a hierarquia existe (o usuário reclamou de 17 itens no mesmo peso visual);
 *  - Funis é alcançável sem passar por Configurações — o achado que originou tudo;
 *  - agrupar não criou cabeçalho órfão (grupo cujos filhos a permissão filtrou);
 *  - colapsado não renderiza título nenhum: 6 rótulos em 64px seria ilegível.
 *
 * A regra de quem-vê-o-quê é do registro e está coberta em
 * `navegacao-registry.test.ts`; aqui é a superfície.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Sidebar } from "@/components/shell/Sidebar";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: null,
};

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => authRef,
  usePermission: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({
  toggleSidebar: vi.fn(),
}));
// Busca a versão via react-query; sem QueryClientProvider ele lança, e o
// rodapé de versão não é o que estes testes examinam.
vi.mock("@/components/shell/VersionFooter", () => ({
  VersionFooter: () => null,
}));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

afterEach(cleanup);

describe("Sidebar agrupado", () => {
  it("renderiza os títulos de grupo na ordem de uso", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const titulos = screen
      .getAllByRole("heading")
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    // Organização não tem título aqui: seu hub (Configurações) vive no rodapé
    // fixo, fora da área que rola — medido, ele caía fora da dobra até em 1080px.
    expect(titulos).toEqual(["Atendimento", "CRM", "Agente de IA", "Canais", "Análise"]);
  });

  it("leva a Funis sem passar por Configurações", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const funis = screen.getByRole("link", { name: /Funis/ });
    expect(funis).toHaveAttribute("href", "/app/settings/tenant/pipelines");
  });

  it("desenterra Audit Log", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    // Audit Log só existia via card em Configurações. Canal oficial não está
    // aqui de propósito: virou aba de Conexões no PR #105, e Conexões é a
    // porta. Nuvemshop foi removido do produto (instância única da CEMED,
    // sem e-commerce) — não há mais link a desenterrar.
    expect(screen.getByRole("link", { name: /Audit Log/ })).toBeTruthy();
  });

  it("não tem mais link de Nuvemshop (removido — sem escopo de e-commerce)", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.queryByRole("link", { name: /Nuvemshop/ })).toBeNull();
  });

  it("Configurações fica no rodapé, nunca dependendo de scroll", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    const config = screen.getByRole("link", { name: /Configurações/ });
    expect(config).toHaveAttribute("href", "/app/settings");
    // Fora da <nav> que rola.
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(nav.contains(config)).toBe(false);
  });

  it("não deixa cabeçalho órfão quando a permissão esvazia o grupo", () => {
    // CANAIS é todo manager+/admin. Um agent não pode ver o título sozinho.
    comoPapel("agent");
    render(<Sidebar collapsed={false} />);
    const titulos = screen.getAllByRole("heading").map((el) => el.textContent?.trim());
    expect(titulos).not.toContain("Canais");
    expect(titulos).toContain("Atendimento");
  });

  it("oferece o hub dos grupos que têm um", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: /Ver tudo em IA/ })).toHaveAttribute("href", "/app/ai");
  });

  it("colapsado esconde os títulos mas mantém os links", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    expect(screen.getByRole("link", { name: /Inbox/ })).toBeTruthy();
  });

  it("marca a rota atual com aria-current", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: /Inbox/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Kanban/ })).not.toHaveAttribute("aria-current");
  });
});
