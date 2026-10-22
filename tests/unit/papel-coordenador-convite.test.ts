/**
 * Coordenador no convite e na troca de papel (PR 4; o papel veio no PR 3).
 *
 * Quem atribui papel NÃO mudou: só o Administrador convida e troca papel. O que
 * muda é que `coordinator` entra na lista de papéis que o Administrador pode
 * atribuir. Aqui se prova, com os Route Handlers e as Server Actions REAIS e o
 * `requireRole` de produção (auth e Supabase dublados, como em
 * papel-coordenador-codigo.test.ts):
 *  - convite: Administrador convida Coordenador (token e e-mail certos); todo
 *    outro papel recebe 403 e NADA é emitido; `ai_operator` não é convidável;
 *  - troca de papel (rota canônica e alias): Administrador promove a
 *    Coordenador; Coordenador e Gerente recebem 403 sem escrever nada;
 *  - aceitar: token com role=coordinator grava `coordinator` em
 *    user_organizations; papel inválido é recusado antes de qualquer escrita;
 *  - uma lista de papéis só (ROLES = PAPEIS_HUMANOS), sem cópia literal.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { INVITE_TTL_SECONDS, signInviteToken, verifyInviteToken } from "@/lib/auth/invite-token";
import { PAPEIS_HUMANOS, type AuthUser, type Role } from "@/lib/auth/types";
import { ROLES } from "@/lib/schemas/team";

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
vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://chat.clinica.test" },
}));
const sendEmail = vi.fn(async (_msg: { text: string; html: string }) => ({ ok: true as boolean }));
vi.mock("@/lib/email/resend", () => ({
  sendEmail: (m: { text: string; html: string }) => sendEmail(m),
}));
// A action de aceitar termina em redirect(): no Next ele lança; aqui vira um marcador.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// O gate do wizard de onboarding tem teste próprio (convite-e-onboarding-por-papel);
// aqui interessa o que o Administrador consegue convidar por ele.
vi.mock("@/app/actions/onboarding/_shared", () => ({
  OnboardingError: class OnboardingError extends Error {},
  requireOnboardingCtx: vi.fn(async () => ({
    userId: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    orgName: "CEMED Saúde",
    role: "admin",
    fullName: "Dra. Ana",
    email: "admin@clinica.test",
  })),
  patchOnboardingState: vi.fn(async () => undefined),
}));

const RAIZ = join(__dirname, "..", "..");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ALVO_ID = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EMAIL_CONVIDADO = "nova@clinica.test";

const NAO_ADMINS: Role[] = ["coordinator", "manager", "agent", "viewer"];

/** Dublê do que a troca de papel lê e escreve em user_organizations. */
interface Estado {
  alvo: { id: string; user_id: string; role: string; revoked_at: string | null } | null;
  admins: number;
  updates: Array<Record<string, unknown>>;
}

function supabaseDublado(role: Role, estado: Estado) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER_ID, email: EMAIL_CONVIDADO } }, error: null }) },
    from: (tabela: string) => {
      if (tabela !== "user_organizations") throw new Error(`tabela inesperada ${tabela}`);
      return {
        select: (_cols: string, opts?: { count?: string }) => {
          const cadeia = {
            eq: () => cadeia,
            is: () => Promise.resolve({ count: estado.admins, error: null }),
            maybeSingle: () => Promise.resolve({ data: opts?.count ? null : estado.alvo, error: null }),
          };
          return cadeia;
        },
        update: (valores: Record<string, unknown>) => ({
          eq: () => {
            estado.updates.push(valores);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: role, error: null } : { data: null, error: null },
  };
}

function estadoInicial(papelDoAlvo = "agent"): Estado {
  return {
    alvo: { id: MEMBERSHIP_ID, user_id: ALVO_ID, role: papelDoAlvo, revoked_at: null },
    admins: 2,
    updates: [],
  };
}

function sessao(role: Role, estado: Estado = estadoInicial()) {
  const user: AuthUser = {
    id: USER_ID,
    email: "quem-chama@clinica.test",
    full_name: "Quem Chama",
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(supabaseDublado(role, estado) as any);
}

async function codigoDeErro(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

function conviteReq(role: string) {
  return new NextRequest("http://localhost/api/v1/team/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invitations: [{ email: EMAIL_CONVIDADO, role }] }),
  });
}

function trocaReq(role: string) {
  return new NextRequest(`http://localhost/api/v1/team/${ALVO_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
}
const params = { params: Promise.resolve({ user_id: ALVO_ID }) };

function tokenDe(role: string): string {
  return signInviteToken({
    invite_id: "55555555-5555-4555-8555-555555555555",
    email: EMAIL_CONVIDADO,
    organization_id: ORG_ID,
    role,
    exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
  });
}

/** Token que a rota de convite devolveu em `accept_url`. */
function tokenDoLink(link: string): string {
  return link.slice(link.lastIndexOf("/") + 1);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INVITE_TOKEN_SECRET", "s".repeat(64));
  sendEmail.mockResolvedValue({ ok: true });
});

describe("convite (POST /api/v1/team/invite)", () => {
  it("Administrador convida um Coordenador: token com o papel e e-mail que diz Coordenador", async () => {
    sessao("admin");
    const { POST } = await import("@/app/api/v1/team/invite/route");
    const res = await POST(conviteReq("coordinator"));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { sent: Array<{ accept_url: string }>; failed: unknown[] } };
    expect(body.data.failed).toEqual([]);
    expect(verifyInviteToken(tokenDoLink(body.data.sent[0]!.accept_url))).toMatchObject({
      role: "coordinator",
      organization_id: ORG_ID,
      email: EMAIL_CONVIDADO,
    });
    const { text, html } = sendEmail.mock.calls[0]![0];
    expect(text).toContain("como Coordenador.");
    expect(html).toContain("<strong>Coordenador</strong>");
    expect(
      vi.mocked(audit).mock.calls.some(
        ([e]) => e.action === "member.invited" && (e.metadata as { role?: string }).role === "coordinator",
      ),
    ).toBe(true);
  });

  it.each(NAO_ADMINS)("%s NÃO convida ninguém: 403 e nenhum e-mail sai", async (role) => {
    sessao(role);
    const { POST } = await import("@/app/api/v1/team/invite/route");
    const res = await POST(conviteReq("coordinator"));

    expect(res.status).toBe(403);
    expect(await codigoDeErro(res)).toBe("forbidden_role");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(vi.mocked(audit).mock.calls.some(([e]) => e.action === "member.invited")).toBe(false);
  });

  it.each(["ai_operator", "superuser"])("papel %s não é convidável: 422 e nenhum e-mail sai", async (papel) => {
    sessao("admin");
    const { POST } = await import("@/app/api/v1/team/invite/route");
    const res = await POST(conviteReq(papel));

    expect(res.status).toBe(422);
    expect(await codigoDeErro(res)).toBe("validation_error");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("convite pelo wizard de onboarding", () => {
  it("Administrador convida um Coordenador: o token sai com o papel", async () => {
    sendEmail.mockResolvedValue({ ok: false }); // o link volta em `undelivered`
    const { sendOnboardingInvites } = await import("@/app/actions/onboarding/sendOnboardingInvites");
    const res = await sendOnboardingInvites({ invitations: [{ email: EMAIL_CONVIDADO, role: "coordinator" }] });

    expect(res).toMatchObject({ ok: true });
    if (!res.ok) throw new Error("esperava ok");
    expect(verifyInviteToken(tokenDoLink(res.undelivered![0]!.accept_url))?.role).toBe("coordinator");
  });

  it("ai_operator não é convidável pelo wizard", async () => {
    const { sendOnboardingInvites } = await import("@/app/actions/onboarding/sendOnboardingInvites");
    const res = await sendOnboardingInvites({
      invitations: [{ email: EMAIL_CONVIDADO, role: "ai_operator" as never }],
    });

    expect(res).toMatchObject({ ok: false, error: "invalid_input" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe.each([
  ["rota canônica", "@/app/api/v1/team/[user_id]/route"],
  ["alias /role", "@/app/api/v1/team/[user_id]/role/route"],
])("troca de papel — %s", (_nome, rota) => {
  it("Administrador promove um Atendente a Coordenador: 200, grava e audita antes/depois", async () => {
    const estado = estadoInicial("agent");
    sessao("admin", estado);
    const { PATCH } = await import(/* @vite-ignore */ rota);
    const res = await PATCH(trocaReq("coordinator"), params);

    expect(res.status).toBe(200);
    expect(estado.updates).toHaveLength(1);
    expect(estado.updates[0]).toMatchObject({ role: "coordinator" });
    const entrada = vi
      .mocked(audit)
      .mock.calls.map(([e]) => e)
      .find((e) => e.action === "team.role_changed");
    expect(entrada).toMatchObject({
      actorUserId: USER_ID,
      organizationId: ORG_ID,
      resourceId: MEMBERSHIP_ID,
      metadata: { target_user_id: ALVO_ID, old_role: "agent", new_role: "coordinator" },
    });
  });

  it("Administrador rebaixa um Coordenador a Atendente: 200", async () => {
    const estado = estadoInicial("coordinator");
    sessao("admin", estado);
    const { PATCH } = await import(/* @vite-ignore */ rota);
    const res = await PATCH(trocaReq("agent"), params);

    expect(res.status).toBe(200);
    expect(estado.updates[0]).toMatchObject({ role: "agent" });
  });

  it.each(NAO_ADMINS)("%s NÃO troca papel de ninguém: 403, nenhum write, nenhum audit de troca", async (role) => {
    const estado = estadoInicial("agent");
    sessao(role, estado);
    const { PATCH } = await import(/* @vite-ignore */ rota);
    const res = await PATCH(trocaReq("coordinator"), params);

    expect(res.status).toBe(403);
    expect(await codigoDeErro(res)).toBe("forbidden_role");
    expect(estado.updates).toHaveLength(0);
    expect(vi.mocked(audit).mock.calls.some(([e]) => e.action === "team.role_changed")).toBe(false);
  });

  it("ai_operator não é atribuível: 422 e nenhum write", async () => {
    const estado = estadoInicial("agent");
    sessao("admin", estado);
    const { PATCH } = await import(/* @vite-ignore */ rota);
    const res = await PATCH(trocaReq("ai_operator"), params);

    expect(res.status).toBe(422);
    expect(estado.updates).toHaveLength(0);
  });

  it("o último Administrador continua sem poder ser rebaixado (a Coordenador inclusive)", async () => {
    const estado = { ...estadoInicial("admin"), admins: 1 };
    sessao("admin", estado);
    const { PATCH } = await import(/* @vite-ignore */ rota);
    const res = await PATCH(trocaReq("coordinator"), params);

    expect(res.status).toBe(409);
    expect(estado.updates).toHaveLength(0);
  });
});

describe("aceitar o convite (acceptInviteAction)", () => {
  /** Admin client dublado: não há membership e registra o INSERT. */
  function adminDublado() {
    const inserts: Array<Record<string, unknown>> = [];
    const client = {
      from: (tabela: string) => {
        if (tabela !== "user_organizations") throw new Error(`tabela inesperada ${tabela}`);
        const leitura = {
          eq: () => leitura,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return {
          select: () => leitura,
          insert: (valores: Record<string, unknown>) => {
            inserts.push(valores);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: MEMBERSHIP_ID }, error: null }) }) };
          },
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(createAdminClient).mockReturnValue(client as any);
    return inserts;
  }

  it("token com role=coordinator grava coordinator em user_organizations", async () => {
    sessao("agent"); // só para o createClient().auth.getUser() do convidado logado
    const inserts = adminDublado();
    const { acceptInviteAction } = await import("@/app/actions/team/acceptInvite");

    await expect(acceptInviteAction(tokenDe("coordinator"))).rejects.toThrow("NEXT_REDIRECT:/app/inbox");

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ user_id: USER_ID, organization_id: ORG_ID, role: "coordinator" });
    expect(
      vi.mocked(audit).mock.calls.some(
        ([e]) => e.action === "member.accepted" && (e.metadata as { role?: string }).role === "coordinator",
      ),
    ).toBe(true);
  });

  it.each(["ai_operator", "superuser"])("token com papel %s é recusado e nada é gravado", async (papel) => {
    sessao("agent");
    const inserts = adminDublado();
    const { acceptInviteAction } = await import("@/app/actions/team/acceptInvite");

    const res = await acceptInviteAction(tokenDe(papel));

    expect(res).toEqual({ ok: false, error: "invalid_or_expired" });
    expect(inserts).toHaveLength(0);
  });

  it("papel inválido é recusado por verifyInviteToken, que também serve criar-conta-pelo-convite e a página", () => {
    expect(verifyInviteToken(tokenDe("coordinator"))?.role).toBe("coordinator");
    expect(verifyInviteToken(tokenDe("ai_operator"))).toBeNull();
    expect(verifyInviteToken(tokenDe(""))).toBeNull();
  });
});

describe("uma lista de papéis só", () => {
  it("ROLES (convite e troca de papel) é PAPEIS_HUMANOS, na mesma ordem, sem ai_operator", () => {
    expect([...ROLES]).toEqual([...PAPEIS_HUMANOS]);
    expect(ROLES).toContain("coordinator");
    expect(ROLES).not.toContain("ai_operator");
  });

  it("nenhuma lista literal de papéis (z.enum / união) sobrou fora das duas fontes", () => {
    const fontes = new Set([join("lib", "auth", "types.ts"), join("lib", "schemas", "team.ts")]);
    const arquivos = ["app", "lib", "components", "hooks"].flatMap(arquivosDe);
    const copias = arquivos
      .filter((f) => !fontes.has(relative(RAIZ, f)))
      .filter((f) => /["']viewer["']\s*,\s*["']agent["']\s*,\s*["']manager["']|["']viewer["']\s*\|\s*["']agent["']\s*\|\s*["']manager["']/.test(readFileSync(f, "utf8")));
    expect(copias.map((f) => relative(RAIZ, f))).toEqual([]);
  });
});

function arquivosDe(dir: string): string[] {
  return readdirSync(join(RAIZ, dir)).flatMap((nome) => {
    const caminho = join(RAIZ, dir, nome);
    if (statSync(caminho).isDirectory()) return arquivosDe(join(dir, nome));
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [caminho] : [];
  });
}
