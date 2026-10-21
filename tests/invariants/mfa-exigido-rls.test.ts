import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * MFA exigido no RLS (migration 0122).
 *
 * O defeito que este arquivo trava, medido em produção em 2026-10-14: o login com
 * senha grava uma sessão AAL1 antes de pedir o código, e nada conferia o nível
 * depois. O proxy passou a barrar as telas e a API; isto prova que o BANCO também
 * barra — senão, com a senha, um token AAL1 pego direto no Supabase Auth lê tudo
 * pelo PostgREST com a anon key.
 *
 * Regra: quem tem fator verificado só enxerga com claim `aal = aal2`. Quem não tem
 * fator verificado (a atendente) enxerga como sempre — isso não pode regredir.
 */

const ORG = "dddddddd-0000-4000-8000-0000000000a1";
const ADMIN = "dddddddd-1111-4000-8000-0000000000a1"; // fator verificado
const ATENDENTE = "dddddddd-1111-4000-8000-0000000000a2"; // sem fator
const PENDENTE = "dddddddd-1111-4000-8000-0000000000a3"; // fator não confirmado

function as(userId: string, aal: "aal1" | "aal2", query: string): string {
  return lastLine(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}","aal":"${aal}"}', false);
      ${query}
    `),
  );
}

const CONTATOS = "select count(*) from public.contacts;";
const MEMBROS = `select count(*) from public.user_organizations where organization_id = '${ORG}';`;
const PLATFORM_ADMIN = "select public.fn_is_platform_admin();";

beforeAll(() => {
  // Sem PII real (LGPD): e-mails sintéticos.
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'mfa-admin@invariant.test'),
      ('${ATENDENTE}', 'mfa-atendente@invariant.test'),
      ('${PENDENTE}', 'mfa-pendente@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'mfa-inv', 'MFA Invariant', 'MFA')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN}', '${ORG}', 'admin', now()),
      ('${ATENDENTE}', '${ORG}', 'agent', now()),
      ('${PENDENTE}', '${ORG}', 'admin', now())
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, reason)
      select '${ADMIN}', '${ADMIN}', 'invariante mfa'
      where not exists (select 1 from public.platform_admins where user_id = '${ADMIN}');
    insert into auth.mfa_factors (user_id, status)
      select '${ADMIN}', 'verified'
      where not exists (select 1 from auth.mfa_factors where user_id = '${ADMIN}');
    insert into auth.mfa_factors (user_id, status)
      select '${PENDENTE}', 'unverified'
      where not exists (select 1 from auth.mfa_factors where user_id = '${PENDENTE}');
    insert into public.contacts (organization_id, display_name)
      select '${ORG}', 'MFA Invariant Contact'
      where not exists (select 1 from public.contacts where organization_id = '${ORG}');
  `);
});

describe("MFA exigido no RLS", () => {
  it("admin com autenticador e só a senha (AAL1) não enxerga nada da organização", () => {
    expect(as(ADMIN, "aal1", CONTATOS)).toBe("0");
    // Só a própria linha de vínculo (policy `user_id = auth.uid()`); a equipe some.
    expect(as(ADMIN, "aal1", MEMBROS)).toBe("1");
    expect(as(ADMIN, "aal1", PLATFORM_ADMIN)).toBe("f");
  });

  it("o mesmo admin depois de digitar o código (AAL2) enxerga a organização", () => {
    expect(Number(as(ADMIN, "aal2", CONTATOS))).toBeGreaterThan(0);
    expect(as(ADMIN, "aal2", MEMBROS)).toBe("3");
    expect(as(ADMIN, "aal2", PLATFORM_ADMIN)).toBe("t");
  });

  it("atendente sem autenticador enxerga com AAL1, como sempre", () => {
    expect(Number(as(ATENDENTE, "aal1", CONTATOS))).toBeGreaterThan(0);
  });

  it("fator só iniciado (não confirmado) não trava — é o meio do cadastro no primeiro acesso", () => {
    expect(Number(as(PENDENTE, "aal1", CONTATOS))).toBeGreaterThan(0);
  });

  it("fn_mfa_satisfeito não é alcançável pela anon key", () => {
    expect(
      sql(
        "select has_function_privilege('anon', 'public.fn_mfa_satisfeito()', 'execute');",
      ),
    ).toBe("f");
  });
});
