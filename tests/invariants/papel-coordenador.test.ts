import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONV_AGENT_B, GOV_ORG, countAs, lastLine, seedGov, sql, writeCountAs } from "./gov-helpers";

/**
 * Papel `coordinator` (migration 0124) — o Coordenador é um Atendente que
 * distribui o atendimento.
 *
 * Org própria (namespace c0c0c0c0), e não a GOV_ORG: aqui a org roda com
 * `visibility_mode = 'own'`, o modo mais fechado, e um membro a mais no roster
 * compartilhado mudaria contagens dos outros invariantes gov-*.
 *
 * O que se prova:
 *  - o banco aceita o papel, e só ele (CHECK);
 *  - ele fica ENTRE agent e manager em `fn_role_at_least`/`fn_user_role_in`;
 *  - vê e trabalha a fila de todos (conversa e lead de outro atendente), que o
 *    Atendente no modo 'own' não vê;
 *  - pode receber e redistribuir conversa (`fn_conversation_assign`);
 *  - lê o roster e muda a disponibilidade de um colega;
 *  - NÃO alcança nada de manager/admin: config de funil, papel na equipe
 *    (inclusive o próprio), auditoria, LGPD; e não vê outra org.
 */

const ORG = "c0c0c0c0-0000-4000-8000-000000000001";
const COORD = "c0c0c0c0-1111-4000-8000-000000000001";
const AGENT_A = "c0c0c0c0-1111-4000-8000-000000000002";
const AGENT_B = "c0c0c0c0-1111-4000-8000-000000000003";
const MANAGER = "c0c0c0c0-1111-4000-8000-000000000004";
const ADMIN = "c0c0c0c0-1111-4000-8000-000000000005";
const SESSION = "c0c0c0c0-2222-4000-8000-000000000001";
const CONTACT_1 = "c0c0c0c0-3333-4000-8000-000000000001";
const CONTACT_2 = "c0c0c0c0-3333-4000-8000-000000000002";
/** Conversa do Atendente B — o Atendente A não a vê no modo 'own'. */
const CONV_B = "c0c0c0c0-4444-4000-8000-000000000001";
/** Conversa sem dono, para o Atendente A passar ao Coordenador. */
const CONV_LIVRE = "c0c0c0c0-4444-4000-8000-000000000002";
const PIPELINE = "c0c0c0c0-5555-4000-8000-000000000001";
const STAGE = "c0c0c0c0-5555-4000-8000-000000000002";
/** Lead do Atendente B. */
const LEAD_B = "c0c0c0c0-6666-4000-8000-000000000001";

const MEMBROS: ReadonlyArray<readonly [string, string, string]> = [
  [COORD, "coordinator", "coord"],
  [AGENT_A, "agent", "agent-a"],
  [AGENT_B, "agent", "agent-b"],
  [MANAGER, "manager", "manager"],
  [ADMIN, "admin", "admin"],
];

beforeAll(() => {
  seedGov(); // a outra org, para o teste de isolamento não passar vazio
  sql(`
    ${MEMBROS.map(
      ([id, , tag]) =>
        `insert into auth.users (id, email) values ('${id}', 'coordenador-${tag}@invariant.test') on conflict do nothing;`,
    ).join("\n")}
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'coordenador-inv', 'Coordenador Invariant Org', 'Coord Inv',
              '{"visibility_mode":"own"}'::jsonb)
      on conflict (id) do update set settings = excluded.settings;
    ${MEMBROS.map(
      ([id, role]) =>
        `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
           values ('${id}', '${ORG}', '${role}', now()) on conflict do nothing;`,
    ).join("\n")}
    do $c$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSION}', '${ORG}', 'coordenador-inv', '\\x00'::bytea);
    exception when unique_violation then null; end $c$;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTACT_1}', '${ORG}', 'Coord Contact 1'), ('${CONTACT_2}', '${ORG}', 'Coord Contact 2')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind)
      values ('${CONV_B}', '${ORG}', '${CONTACT_1}', '${SESSION}', 'claimed', '${AGENT_B}', now(), 'user')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_LIVRE}', '${ORG}', '${CONTACT_2}', '${SESSION}', 'open')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE}', '${ORG}', 'Coord Invariant', 'coord-inv') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPELINE}', 'Novo', 'novo', 1000) on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id)
      values ('${LEAD_B}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Lead do atendente B', '${AGENT_B}')
      on conflict do nothing;
    insert into public.api_audit_log (organization_id, action)
      select '${ORG}', 'coordenador.invariant'
       where not exists (select 1 from public.api_audit_log where organization_id = '${ORG}');
    insert into public.lgpd_requests (organization_id, request_type, source, due_at)
      select '${ORG}', 'data_request', 'manual', now() + interval '7 days'
       where not exists (select 1 from public.lgpd_requests where organization_id = '${ORG}');
  `);
});

/** Executa como `authenticated` com o JWT do usuário e devolve a última linha. */
function comoUsuario(userId: string, script: string): string {
  return lastLine(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${script}
    `),
  );
}

describe("papel coordinator — o banco aceita, e só ele", () => {
  it("CHECK aceita 'coordinator' e continua recusando papel inventado e o do agente", () => {
    expect(
      sql(`select role from public.user_organizations where user_id = '${COORD}' and organization_id = '${ORG}';`),
    ).toBe("coordinator");
    for (const invalido of ["foo", "ai_operator"]) {
      expect(() =>
        sql(`update public.user_organizations set role = '${invalido}'
               where user_id = '${AGENT_A}' and organization_id = '${ORG}';`),
      ).toThrow(/user_organizations_role_check/);
    }
  });
});

describe("papel coordinator — fica entre atendente e gerente", () => {
  const LIMIARES = ["viewer", "agent", "coordinator", "manager", "admin"];
  const vetor = (userId: string): string =>
    comoUsuario(
      userId,
      `select ${LIMIARES.map((t) => `public.fn_role_at_least('${ORG}', '${t}')::int::text`).join(" || ',' || ")};`,
    );

  it("fn_role_at_least: agent < coordinator < manager", () => {
    expect(vetor(AGENT_A)).toBe("1,1,0,0,0");
    expect(vetor(COORD)).toBe("1,1,1,0,0");
    expect(vetor(MANAGER)).toBe("1,1,1,1,0");
    expect(vetor(ADMIN)).toBe("1,1,1,1,1");
  });

  it("fn_user_role_in devolve 3 para o Coordenador", () => {
    expect(comoUsuario(COORD, `select public.fn_user_role_in('${ORG}')::text;`)).toBe("3");
  });
});

describe("papel coordinator — vê e trabalha a fila de todos", () => {
  it("vê a conversa de outro atendente; o Atendente, no modo 'own', não", () => {
    const q = `select count(*) from public.conversations where id = '${CONV_B}';`;
    expect(countAs(COORD, q)).toBe(1);
    expect(countAs(AGENT_A, q)).toBe(0);
  });

  it("vê o lead de outro atendente; o Atendente, no modo 'own', não", () => {
    const q = `select count(*) from public.crm_leads where id = '${LEAD_B}';`;
    expect(countAs(COORD, q)).toBe(1);
    expect(countAs(AGENT_A, q)).toBe(0);
  });

  it("edita o lead de outro atendente (reatribuição); o Atendente, não", () => {
    expect(
      writeCountAs(AGENT_A, `update public.crm_leads set title = title where id = '${LEAD_B}'`),
    ).toBe(0);
    expect(
      writeCountAs(COORD, `update public.crm_leads set title = title where id = '${LEAD_B}'`),
    ).toBe(1);
  });

  it("recebe conversa: o Atendente passa uma conversa para o Coordenador", () => {
    const dono = comoUsuario(
      AGENT_A,
      `select assigned_to_user_id::text from public.fn_conversation_assign('${ORG}', '${CONV_LIVRE}', '${COORD}', 'transfer');`,
    );
    expect(dono).toBe(COORD);
  });

  it("redistribui: tira a conversa do Atendente B e passa para o Atendente A", () => {
    const dono = comoUsuario(
      COORD,
      `select assigned_to_user_id::text from public.fn_conversation_assign('${ORG}', '${CONV_B}', '${AGENT_A}', 'transfer');`,
    );
    expect(dono).toBe(AGENT_A);
    // devolve ao dono original para o arquivo ser reexecutável
    sql(`update public.conversations set assigned_to_user_id = '${AGENT_B}' where id = '${CONV_B}';`);
  });

  it("lê o roster inteiro da org; o Atendente só a própria linha", () => {
    const q = `select count(*) from public.user_organizations where organization_id = '${ORG}';`;
    expect(countAs(COORD, q)).toBe(MEMBROS.length);
    expect(countAs(AGENT_A, q)).toBe(1);
  });

  it("muda a disponibilidade de um colega; o Atendente, não", () => {
    sql(`delete from public.attendant_availability where organization_id = '${ORG}';`);
    expect(
      writeCountAs(
        AGENT_A,
        `insert into public.attendant_availability (organization_id, user_id, is_available)
           values ('${ORG}', '${AGENT_B}', true)`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        COORD,
        `insert into public.attendant_availability (organization_id, user_id, is_available)
           values ('${ORG}', '${AGENT_B}', true)`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        AGENT_A,
        `update public.attendant_availability set is_available = false
          where organization_id = '${ORG}' and user_id = '${AGENT_B}'`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        COORD,
        `update public.attendant_availability set is_available = false
          where organization_id = '${ORG}' and user_id = '${AGENT_B}'`,
      ),
    ).toBe(1);
  });
});

describe("papel coordinator — não alcança gerente nem administrador", () => {
  it("não altera config de funil (pipeline e etapa são manager+)", () => {
    expect(
      writeCountAs(COORD, `update public.crm_pipelines set name = name where id = '${PIPELINE}'`),
    ).toBe(0);
    expect(writeCountAs(COORD, `update public.crm_stages set name = name where id = '${STAGE}'`)).toBe(0);
    // controle positivo: a mesma escrita passa para o Gerente
    expect(
      writeCountAs(MANAGER, `update public.crm_pipelines set name = name where id = '${PIPELINE}'`),
    ).toBe(1);
  });

  it("não se promove nem muda o papel de ninguém (escrita no roster é admin)", () => {
    expect(
      writeCountAs(
        COORD,
        `update public.user_organizations set role = 'manager'
          where user_id = '${COORD}' and organization_id = '${ORG}'`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        COORD,
        `update public.user_organizations set role = 'viewer'
          where user_id = '${AGENT_A}' and organization_id = '${ORG}'`,
      ),
    ).toBe(0);
    expect(
      sql(`select role from public.user_organizations where user_id = '${COORD}' and organization_id = '${ORG}';`),
    ).toBe("coordinator");
  });

  it("não lê auditoria nem pedidos LGPD (controle positivo: o Administrador lê)", () => {
    for (const tabela of ["api_audit_log", "lgpd_requests"]) {
      const q = `select count(*) from public.${tabela} where organization_id = '${ORG}';`;
      expect(countAs(COORD, q), tabela).toBe(0);
      expect(countAs(ADMIN, q), tabela).toBeGreaterThan(0);
    }
  });

  it("não vê nada de outra organização", () => {
    // controle positivo: a conversa da outra org existe
    expect(sql(`select count(*) from public.conversations where id = '${GOV_CONV_AGENT_B}';`)).toBe("1");
    expect(countAs(COORD, `select count(*) from public.conversations where organization_id = '${GOV_ORG}';`)).toBe(0);
    expect(countAs(COORD, `select count(*) from public.conversations where id = '${GOV_CONV_AGENT_B}';`)).toBe(0);
  });
});
