/**
 * Convite, cron e rotas internas não dividem mais o mesmo segredo (auditoria de
 * 2026-10-21, M5/B6).
 *
 * Antes: o convite era assinado com `INVITE_TOKEN_SECRET ?? INTERNAL_SECRET ??
 * "dev-fallback"` e os crons aceitavam `INTERNAL_CRON_SECRET` OU `INTERNAL_SECRET`.
 * Com o `scheduler` mandando o `INTERNAL_SECRET`, quem lesse o env dele assinava
 * convite de admin para qualquer organização.
 */
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

const envFalso: Record<string, string> = { INTERNAL_SECRET: "", INTERNAL_CRON_SECRET: "" };
vi.mock("@/lib/env", () => ({ env: envFalso }));

const payload = () => ({
  invite_id: "inv",
  email: "x@invariant.test",
  organization_id: "11111111-0000-4000-8000-000000000001",
  role: "admin",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

/** Token montado como o código ANTIGO montava, assinado com o segredo cru. */
function assinadoCom(segredo: string): string {
  const body = Buffer.from(JSON.stringify(payload()), "utf8").toString("base64url");
  const sig = createHmac("sha256", segredo).update(body).digest().toString("base64url");
  return `${body}.${sig}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("token de convite", () => {
  it("com INVITE_TOKEN_SECRET definido, um token assinado com o INTERNAL_SECRET é recusado", async () => {
    vi.stubEnv("INVITE_TOKEN_SECRET", "c".repeat(64));
    vi.stubEnv("INTERNAL_SECRET", "segredo-interno-do-cron");
    const { verifyInviteToken } = await import("@/lib/auth/invite-token");
    expect(verifyInviteToken(assinadoCom("segredo-interno-do-cron"))).toBeNull();
  });

  it("sem INVITE_TOKEN_SECRET, o INTERNAL_SECRET CRU também não assina (a chave é derivada)", async () => {
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "segredo-interno-do-cron");
    const { signInviteToken, verifyInviteToken } = await import("@/lib/auth/invite-token");
    expect(verifyInviteToken(assinadoCom("segredo-interno-do-cron"))).toBeNull();
    // probe positivo: o caminho derivado funciona ida e volta
    expect(verifyInviteToken(signInviteToken(payload()))).toMatchObject({ role: "admin" });
  });

  it("sem nenhum segredo, não assina com valor conhecido: lança", async () => {
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "");
    const { signInviteToken } = await import("@/lib/auth/invite-token");
    expect(() => signInviteToken(payload())).toThrow(/invite_token_secret_missing/);
    // e o literal antigo não abre nada
    const { verifyInviteToken } = await import("@/lib/auth/invite-token");
    expect(() => verifyInviteToken(assinadoCom("dev-fallback"))).toThrow();
  });
});

describe("segredo de cron", () => {
  const req = (bearer: string) =>
    new Request("http://app/api/v1/cron/x", { headers: { authorization: `Bearer ${bearer}` } });

  afterEach(() => {
    envFalso.INTERNAL_SECRET = "";
    envFalso.INTERNAL_CRON_SECRET = "";
  });

  it("com INTERNAL_CRON_SECRET definido, o INTERNAL_SECRET NÃO abre os crons", async () => {
    envFalso.INTERNAL_SECRET = "interno";
    envFalso.INTERNAL_CRON_SECRET = "so-do-cron";
    const { cronAutorizado } = await import("@/lib/auth/cron-secret");
    expect(cronAutorizado(req("interno"))).toBe(false);
    expect(cronAutorizado(req("so-do-cron"))).toBe(true);
  });

  it("sem INTERNAL_CRON_SECRET, o INTERNAL_SECRET segue valendo (clone antigo não para)", async () => {
    envFalso.INTERNAL_SECRET = "interno";
    const { cronAutorizado } = await import("@/lib/auth/cron-secret");
    expect(cronAutorizado(req("interno"))).toBe(true);
    expect(cronAutorizado(req("outro"))).toBe(false);
  });

  it("sem segredo nenhum, ninguém entra (nem com Bearer vazio)", async () => {
    const { cronAutorizado } = await import("@/lib/auth/cron-secret");
    expect(cronAutorizado(req(""))).toBe(false);
    expect(cronAutorizado(new Request("http://app/api/v1/cron/x"))).toBe(false);
  });
});

describe("toda rota de cron passa pelo helper", () => {
  it("nenhuma compara segredo à mão nem lê INTERNAL_SECRET direto", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raiz = path.join(process.cwd(), "app/api/v1/cron");
    const rotas = fs
      .readdirSync(raiz)
      .map((d) => path.join(raiz, d, "route.ts"))
      .filter((f) => fs.existsSync(f))
      .concat(path.join(process.cwd(), "app/api/v1/system/agent/route.ts"));

    expect(rotas.length, "guarda de vacuidade").toBeGreaterThanOrEqual(13);
    for (const f of rotas) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, `${f} não usa cronAutorizado`).toMatch(/cronAutorizado\(req\)/);
      expect(src, `${f} ainda lê o segredo direto`).not.toMatch(/env\.INTERNAL_(CRON_)?SECRET/);
    }
  });
});
