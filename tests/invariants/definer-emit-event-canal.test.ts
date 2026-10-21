import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  GOV_VIEWER,
  countAs,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * Migration 0123 — os três buracos da auditoria de 2026-10-21 que moram no banco.
 *
 * 1. Seis `security definer` estavam executáveis pela anon key EM PRODUÇÃO, entre
 *    elas a anonimização irreversível de paciente. O install limpo daqui nunca
 *    mostrou isso: a produção recebeu os grants dos default privileges do
 *    Supabase cloud. Este arquivo roda DEPOIS do `scripts/test-db.sh` sujar o
 *    banco (EXECUTE de tudo para anon e authenticated) e re-aplicar o baseline —
 *    então prova que o update CURA, não só que o install nasce limpo. A varredura
 *    genérica (`hardening-definer-varredura.test.ts`) cobre todas; aqui ficam as
 *    seis nomeadas, para o defeito real ter nome no relatório de falha.
 * 2. `emit_event` aceitava organização alheia de quem estivesse logado.
 * 3. Qualquer membro escrevia em `channel_sessions` pelo PostgREST.
 */

const OUTRA_ORG = "eeeeeeee-0000-4000-8000-0000000000b1";

const SEIS = [
  "public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid)",
  "public.retrieve_top_k_chunks(uuid, uuid, public.vector, integer, real)",
  "public.activate_kb_version(uuid, uuid)",
  "public.fn_decrypt_oauth(bytea)",
  "public.fn_encrypt_oauth(text)",
  "public.fn_update_budget_consumption()",
] as const;

function pode(role: string, fn: string): boolean {
  return lastLine(sql(`select has_function_privilege('${role}', '${fn}', 'EXECUTE');`)) === "t";
}

/** Roda como authenticated com o claim do usuário; devolve stderr do psql (vazio = ok). */
function erroComo(userId: string, query: string): string {
  try {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${query}
    `);
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'fase1-outra', 'Outra Org Invariant', 'Outra')
      on conflict (id) do nothing;
  `);
});

describe("0123 — as seis definer abertas em produção ficam fechadas depois do update", () => {
  it.each(SEIS)("%s: nem anon nem authenticated executam; service_role sim", (fn) => {
    expect(pode("anon", fn), `${fn} executável pela anon key`).toBe(false);
    expect(pode("authenticated", fn), `${fn} executável por qualquer logado`).toBe(false);
    expect(pode("service_role", fn), `${fn} perdeu o service_role (o worker quebraria)`).toBe(true);
  });

  it("anon chamando a anonimização recebe permission denied (comportamento, não só catálogo)", () => {
    let stderr = "";
    try {
      sql(`
        set role anon;
        select public.fn_lgpd_cascade_redact_contact(
          '${GOV_ORG}'::uuid, gen_random_uuid(), gen_random_uuid());
      `);
    } catch (err) {
      stderr = (err as { stderr?: string }).stderr ?? String(err);
    }
    expect(stderr).toMatch(/permission denied for function fn_lgpd_cascade_redact_contact/);
  });

  it("os helpers de RLS continuam executáveis por authenticated (a leitura logada não quebra)", () => {
    for (const fn of [
      "public.fn_user_org_ids()",
      "public.fn_role_at_least(uuid, text)",
      "public.fn_can_view_conversation(uuid, uuid)",
      "public.fn_mfa_satisfeito()",
    ]) {
      expect(pode("authenticated", fn), fn).toBe(true);
    }
    expect(countAs(GOV_VIEWER, `select count(*) from public.contacts where organization_id = '${GOV_ORG}';`))
      .toBeGreaterThan(0);
  });
});

describe("0123 — emit_event só grava na organização de quem chama", () => {
  const emitir = (org: string) =>
    `select public.emit_event('fase1.probe', 'test', null, '{}'::jsonb, '{}'::jsonb, '${org}');`;

  it("membro logado emitindo para OUTRA organização é recusado (42501)", () => {
    expect(erroComo(GOV_VIEWER, emitir(OUTRA_ORG))).toMatch(/fora do alcance de quem chama/);
  });

  it("membro logado emitindo para a própria organização continua funcionando", () => {
    expect(erroComo(GOV_VIEWER, emitir(GOV_ORG))).toBe("");
  });

  it("sem sessão de usuário (service role, worker, trigger) segue como antes", () => {
    expect(() => sql(emitir(OUTRA_ORG))).not.toThrow();
  });
});

describe("0123 — channel_sessions: membro lê, só admin escreve", () => {
  const atualizar = `update public.channel_sessions set display_name = display_name where id = '${GOV_SESSION}'`;
  const apagar = `delete from public.channel_sessions where id = '${GOV_SESSION}'`;
  const inserir = `insert into public.channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
    values ('${GOV_ORG}', 'fase1-intruso-' || gen_random_uuid(), '\\x00'::bytea)`;

  it("viewer, agent e manager leem a linha do canal", () => {
    for (const u of [GOV_VIEWER, GOV_AGENT_A, GOV_MANAGER]) {
      expect(countAs(u, `select count(*) from public.channel_sessions where id = '${GOV_SESSION}';`)).toBe(1);
    }
  });

  it.each([
    ["viewer", GOV_VIEWER],
    ["agent", GOV_AGENT_A],
    ["manager", GOV_MANAGER],
  ])("%s não insere, não altera e não apaga", (_papel, u) => {
    expect(writeCountAs(u, inserir)).toBe(0);
    expect(writeCountAs(u, atualizar)).toBe(0);
    expect(writeCountAs(u, apagar)).toBe(0);
  });

  it("admin altera (probe positivo: a policy não fechou para todo mundo)", () => {
    expect(writeCountAs(GOV_ADMIN, atualizar)).toBe(1);
  });

  it("a policy ALL antiga não existe mais (sobraria OR permissivo)", () => {
    const n = lastLine(
      sql(`select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'channel_sessions'
              and policyname = 'channel_sessions_tenant_isolation_all';`),
    );
    expect(n).toBe("0");
  });
});

