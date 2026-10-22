/**
 * Papel Coordenador no código (PR 3; o banco veio na migration 0124).
 *
 * O Coordenador é um Atendente que distribui o atendimento. Aqui se prova, com
 * os Route Handlers REAIS e o `requireRole` de produção (auth e Supabase
 * dublados, como em rbac-matrix.test.ts):
 *  - a escala: agent < coordinator < ai_operator < manager;
 *  - o que ele ganha: Distribuição de atendimento (GET/PATCH settings/routing),
 *    lista da Equipe, disponibilidade de um colega;
 *  - o que ele NÃO ganha: toda rota cujo piso é manager ou admin;
 *  - a navegação mostra a porta certa e esconde as de gerente;
 *  - não sobra cópia da escala de papéis fora de lib/auth/types.ts, e nenhuma
 *    tool do MCP usa o gate `coordinator` (o agente publicado, ai_operator,
 *    passaria por ele — o gate é de gente).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PAPEIS_HUMANOS, ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { NAV_DESTINATIONS, canSee } from "@/lib/navigation/registry";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const RAIZ = join(__dirname, "..", "..");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const COLEGA_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** PostgREST dublado: toda cadeia resolve com `tabelas[t]`; o rpc devolve o papel. */
function supabaseDublado(role: Role, tabelas: Record<string, unknown> = {}) {
  const cadeia = (tabela: string) => {
    const resultado = { data: tabela in tabelas ? tabelas[tabela] : [], error: null, count: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy: any = new Proxy(() => proxy, {
      get(_t, prop) {
        if (prop === "then") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (ok: any, ko: any) => Promise.resolve(resultado).then(ok, ko);
        }
        return () => proxy;
      },
      apply: () => proxy,
    });
    return proxy;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    from: (t: string) => cadeia(t),
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: role, error: null } : { data: null, error: null },
  };
}

function sessao(role: Role, tabelas: Record<string, unknown> = {}) {
  const user: AuthUser = {
    id: USER_ID,
    email: "coord@clinica.test",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(supabaseDublado(role, tabelas) as any);
}

const req = (url: string, init?: { method?: string; body?: string }) =>
  new NextRequest(`http://localhost${url}`, init);

async function codigoDeErro(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

beforeEach(() => vi.clearAllMocks());

describe("escala de papéis", () => {
  it("agent < coordinator < ai_operator < manager < admin", () => {
    expect(ROLE_RANK.agent).toBeLessThan(ROLE_RANK.coordinator);
    expect(ROLE_RANK.coordinator).toBeLessThan(ROLE_RANK.ai_operator);
    expect(ROLE_RANK.ai_operator).toBeLessThan(ROLE_RANK.manager);
    expect(ROLE_RANK.manager).toBeLessThan(ROLE_RANK.admin);
  });

  it("o Coordenador é papel de pessoa", () => {
    expect(PAPEIS_HUMANOS).toContain("coordinator");
  });
});

describe("Coordenador — o que ele ganha (distribuir o atendimento)", () => {
  it("lê e grava a Distribuição de atendimento (settings/routing)", async () => {
    sessao("coordinator", { organizations: { settings: {} } });
    // a escrita em organizations vai pelo admin client (ver a rota)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(createAdminClient).mockReturnValue(supabaseDublado("coordinator", { organizations: { settings: {} } }) as any);
    const { GET, PATCH } = await import("@/app/api/v1/settings/routing/route");
    expect((await GET(req("/api/v1/settings/routing"))).status).toBe(200);
    const res = await PATCH(
      req("/api/v1/settings/routing", { method: "PATCH", body: JSON.stringify({ visibility_mode: "own" }) }),
    );
    expect(res.status).toBe(200);
  });

  it("Atendente continua sem a Distribuição (controle)", async () => {
    sessao("agent", { organizations: { settings: {} } });
    const { GET, PATCH } = await import("@/app/api/v1/settings/routing/route");
    const res = await GET(req("/api/v1/settings/routing"));
    expect(res.status).toBe(403);
    expect(await codigoDeErro(res)).toBe("forbidden_role");
    const resPatch = await PATCH(req("/api/v1/settings/routing", { method: "PATCH", body: "{}" }));
    expect(resPatch.status).toBe(403);
  });

  it("vê a lista da Equipe; o Atendente não", async () => {
    sessao("coordinator", { user_organizations: [] });
    const { GET } = await import("@/app/api/v1/team/route");
    expect((await GET(req("/api/v1/team"))).status).toBe(200);

    sessao("agent", { user_organizations: [] });
    const res = await GET(req("/api/v1/team"));
    expect(res.status).toBe(403);
    expect(await codigoDeErro(res)).toBe("forbidden_role");
  });

  it("muda a disponibilidade de um colega; o Atendente só a própria", async () => {
    const tabelas = {
      user_organizations: { user_id: COLEGA_ID },
      attendant_availability: { user_id: COLEGA_ID, is_available: false, capacity: 5 },
    };
    const { PATCH } = await import("@/app/api/v1/attendants/availability/[user_id]/route");
    const chamar = () =>
      PATCH(
        req(`/api/v1/attendants/availability/${COLEGA_ID}`, {
          method: "PATCH",
          body: JSON.stringify({ is_available: false }),
        }),
        { params: Promise.resolve({ user_id: COLEGA_ID }) },
      );

    sessao("coordinator", tabelas);
    expect((await chamar()).status).toBe(200);

    sessao("agent", tabelas);
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(await codigoDeErro(res)).toBe("forbidden_role");
  });
});

/**
 * Rotas cujo PRIMEIRO passo é `requireRole("manager"|"admin")` — conferido
 * método a método. O Coordenador tem que cair no 403 antes de qualquer coisa.
 */
const ROTAS_DE_GERENTE_OU_ADMIN: ReadonlyArray<[string, string, "GET" | "POST" | "PATCH", string]> = [
  ["agentes de IA", "@/app/api/v1/ai/agents/route", "GET", "/api/v1/ai/agents"],
  ["credenciais de IA", "@/app/api/v1/ai/credentials/route", "GET", "/api/v1/ai/credentials"],
  ["conhecimento", "@/app/api/v1/ai/knowledge/sources/route", "POST", "/api/v1/ai/knowledge/sources"],
  ["memória", "@/app/api/v1/ai/memory/entries/route", "POST", "/api/v1/ai/memory/entries"],
  ["skills", "@/app/api/v1/ai/skills/import/route", "POST", "/api/v1/ai/skills/import"],
  ["uso de IA", "@/app/api/v1/ai/usage/route", "GET", "/api/v1/ai/usage"],
  ["evolução da IA", "@/app/api/v1/ai/evolution/route", "GET", "/api/v1/ai/evolution"],
  ["orçamento de IA", "@/app/api/v1/ai/budget/route", "GET", "/api/v1/ai/budget"],
  ["follow-ups (escrita)", "@/app/api/v1/ai/followup-flows/route", "POST", "/api/v1/ai/followup-flows"],
  ["roteadores (escrita)", "@/app/api/v1/ai/routers/route", "POST", "/api/v1/ai/routers"],
  ["webhooks", "@/app/api/v1/webhook-sources/route", "GET", "/api/v1/webhook-sources"],
  ["automações", "@/app/api/v1/automation-rules/route", "GET", "/api/v1/automation-rules"],
  ["funis", "@/app/api/v1/pipelines/route", "POST", "/api/v1/pipelines"],
  ["auditoria", "@/app/api/v1/audit/route", "GET", "/api/v1/audit"],
  ["convite", "@/app/api/v1/team/invite/route", "POST", "/api/v1/team/invite"],
  ["LGPD", "@/app/api/v1/lgpd/requests/route", "GET", "/api/v1/lgpd/requests"],
  ["tokens de API", "@/app/api/v1/settings/api-tokens/route", "GET", "/api/v1/settings/api-tokens"],
];

describe("Coordenador — o que ele NÃO ganha (piso manager ou admin)", () => {
  it.each(ROTAS_DE_GERENTE_OU_ADMIN)("%s → 403 forbidden_role", async (_nome, modulo, metodo, url) => {
    sessao("coordinator");
    const mod = (await import(/* @vite-ignore */ modulo)) as Record<
      string,
      (r: NextRequest) => Promise<Response>
    >;
    const handler = mod[metodo]!;
    const res = await handler(req(url, metodo === "GET" ? undefined : { method: metodo, body: "{}" }));
    expect(res.status).toBe(403);
    expect(await codigoDeErro(res)).toBe("forbidden_role");
  });

  it("troca de papel na Equipe (PATCH /team/:id/role) é só do Administrador", async () => {
    sessao("coordinator");
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/role/route");
    const res = await PATCH(
      req(`/api/v1/team/${COLEGA_ID}/role`, { method: "PATCH", body: JSON.stringify({ role: "manager" }) }),
      { params: Promise.resolve({ user_id: COLEGA_ID }) },
    );
    expect(res.status).toBe(403);
    expect(await codigoDeErro(res)).toBe("forbidden_role");
  });
});

describe("navegação do Coordenador", () => {
  const visivel = (href: string, role: Role) => {
    const d = NAV_DESTINATIONS.find((x) => x.href === href);
    expect(d, href).toBeDefined();
    return canSee(d!, false, role);
  };

  it("mostra Distribuição de atendimento, Equipe e Desempenho", () => {
    for (const href of ["/app/settings/atendimento", "/app/team", "/app/metrics", "/app/inbox"]) {
      expect(visivel(href, "coordinator"), href).toBe(true);
    }
    expect(visivel("/app/settings/atendimento", "agent")).toBe(false);
  });

  it("esconde o que é de gerente ou administrador", () => {
    const deGerente = NAV_DESTINATIONS.filter(
      (d) => d.minRole && ROLE_RANK[d.minRole] >= ROLE_RANK.manager,
    );
    expect(deGerente.map((d) => d.href)).toEqual(
      expect.arrayContaining(["/app/ai/agents", "/app/audit", "/app/settings/tenant/pipelines"]),
    );
    for (const d of deGerente) expect(canSee(d, false, "coordinator"), d.href).toBe(false);
  });
});

function arquivosDe(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivosDe(caminho);
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [caminho] : [];
  });
}
const CODIGO = ["app", "lib", "components", "hooks"].flatMap((d) => arquivosDe(join(RAIZ, d)));

describe("token de API com papel de Coordenador", () => {
  it("role:coordinator é reconhecido (antes caía em silêncio para agent)", async () => {
    const tabelas = {
      api_tokens: { id: "tok-1", organization_id: ORG_ID, scopes: ["role:coordinator"], revoked_at: null, expires_at: null },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(createAdminClient).mockReturnValue(supabaseDublado("coordinator", tabelas) as any);
    const { validateBearerToken } = await import("@/lib/mcp/auth");
    const r = await validateBearerToken("Bearer dsk_token_de_teste");
    expect(r.role).toBe("coordinator");
  });
});

describe("uma escala só", () => {
  it("nenhuma tabela papel→número fora de lib/auth/types.ts", () => {
    // A cópia local de contacts/_handler.ts (1–4) não conhecia o Coordenador.
    const copias = CODIGO.filter((f) => relative(RAIZ, f) !== join("lib", "auth", "types.ts")).filter(
      (f) => /\b(viewer|agent|manager|admin)\s*:\s*\d+\s*,/.test(readFileSync(f, "utf8")),
    );
    expect(copias.map((f) => relative(RAIZ, f))).toEqual([]);
  });

  it("nenhuma tool do MCP nem do agente usa o gate coordinator (o agente passaria por ele)", () => {
    const agente = ["lib/mcp", "lib/agent-engine", "lib/ai"].flatMap((d) => arquivosDe(join(RAIZ, d)));
    const usos = agente.filter((f) =>
      /(ensureRole|requireRole)\([^)]*["']coordinator["']/.test(readFileSync(f, "utf8")),
    );
    expect(usos.map((f) => relative(RAIZ, f))).toEqual([]);
  });
});
