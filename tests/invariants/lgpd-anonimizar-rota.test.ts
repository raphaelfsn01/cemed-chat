import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Anonimizar contato pela tela (POST /api/v1/lgpd/anonymize), em Postgres de verdade.
 *
 * (i) Diagnóstico: o UPDATE que a rota antiga fazia gravava `email_normalized`,
 *     coluna GERADA — o Postgres recusa com 428C9 e nada era anonimizado.
 * (ii) A cascata do RPC (a que a rota passou a usar) anonimiza TODAS as colunas
 *     de `contacts` que ela cita e não toca contato vizinho nem de outra org.
 *
 * Dados 100% fictícios.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "a2a20000-0000-4000-8000-000000000001";
const ORG_OUTRA = "a2a20000-0000-4000-8000-0000000000ff";
const REQ = "a2a20000-0000-4000-8000-000000000002";
const ALVO = "a2a20000-0000-4000-8000-00000000000a";
const IRMAO = "a2a20000-0000-4000-8000-00000000000b";
const OUTRA_ORG_CONTATO = "a2a20000-0000-4000-8000-00000000000c";

async function semear(id: string, org: string, sufixo: string): Promise<void> {
  await pool.query(
    `insert into contacts
       (id, organization_id, name, display_name, email, phone_number, cpf_encrypted,
        cpf_hash, birthdate, consent, source_metadata, tags)
     values ($1, $2, $3, $3, $4, $5, '\\xdeadbeef'::bytea, $6, '1990-01-01',
             '{"marketing": true}'::jsonb, '{"origem": "teste"}'::jsonb, array['vip','teste'])
     on conflict (id) do nothing`,
    [id, org, `Fulano ${sufixo}`, `Fulano.${sufixo}@Exemplo.invalid`, `+551190000${sufixo}`, `hash${sufixo}`],
  );
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "anonimizar-rota-a"],
    [ORG_OUTRA, "anonimizar-rota-b"],
  ]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
      [id, slug],
    );
  }
  await pool.query(
    `insert into lgpd_requests (id, organization_id, request_type, source, scope, due_at)
     values ($1, $2, 'redact', 'manual', 'contact', now() + interval '15 days')
     on conflict (id) do nothing`,
    [REQ, ORG],
  );
  await semear(ALVO, ORG, "0001");
  await semear(IRMAO, ORG, "0002");
  await semear(OUTRA_ORG_CONTATO, ORG_OUTRA, "0003");
});

afterAll(async () => {
  await pool.query(`delete from contacts where organization_id = any($1::uuid[])`, [[ORG, ORG_OUTRA]]);
  await pool.query(`delete from lgpd_requests where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = any($1::uuid[])`, [[ORG, ORG_OUTRA]]);
  await pool.end();
});

describe("anonimização de contato pela rota", () => {
  it("o UPDATE da rota antiga (com email_normalized) falha com 428C9 — coluna gerada", async () => {
    await expect(
      pool.query(`update contacts set email_normalized = null where id = $1`, [ALVO]),
    ).rejects.toMatchObject({ code: "428C9" });
  });

  it("a cascata anonimiza todas as colunas citadas no RPC", async () => {
    const { rows: r } = await pool.query(
      `select fn_lgpd_cascade_redact_contact($1, $2, $3) as res`,
      [ORG, ALVO, REQ],
    );
    expect(r[0].res.already_anonymized).toBe(false);

    const { rows } = await pool.query(`select * from contacts where id = $1`, [ALVO]);
    const c = rows[0];
    expect(c.name).toMatch(/^Cliente Anonimizado #a2a20000$/);
    expect(c.display_name).toBe(c.name);
    expect(c.email).toBeNull();
    expect(c.email_normalized).toBeNull();
    expect(c.phone_number).toBeNull();
    expect(c.cpf_encrypted).toBeNull();
    expect(c.cpf_hash).toBeNull();
    expect(c.birthdate).toBeNull();
    expect(c.is_anonymized).toBe(true);
    expect(c.anonymized_at).not.toBeNull();
    expect(c.consent).toEqual({});
    expect(c.source_metadata).toEqual({});
    expect(c.tags).toEqual([]);
  });

  it("não toca outro contato da mesma org nem contato de outra org", async () => {
    for (const id of [IRMAO, OUTRA_ORG_CONTATO]) {
      const { rows } = await pool.query(`select * from contacts where id = $1`, [id]);
      const c = rows[0];
      expect(c.is_anonymized).toBe(false);
      expect(c.name).toMatch(/^Fulano /);
      expect(c.email_normalized).toBe(String(c.email).toLowerCase().trim());
      expect(c.phone_number).not.toBeNull();
      expect(c.cpf_hash).not.toBeNull();
      expect(c.tags).toEqual(["vip", "teste"]);
    }
  });
});
