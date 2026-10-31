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
const SESSAO = "a2a20000-0000-4000-8000-0000000000e1";
/** UUID bem-formado que NÃO existe em lgpd_requests (o `requestId` HTTP da rota antiga). */
const PEDIDO_INEXISTENTE = "a2a20000-0000-4000-8000-0000000000dd";

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
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name,
                                   status, webhook_secret_encrypted)
     values ($1, $2, 'waha', 'anonimizar-rota', 'WORKING', '\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
});

afterAll(async () => {
  await pool.query(`delete from messages where organization_id = $1`, [ORG]);
  await pool.query(`delete from conversations where organization_id = $1`, [ORG]);
  await pool.query(`delete from storage_redaction_queue where organization_id = $1`, [ORG]);
  await pool.query(`delete from channel_sessions where id = $1`, [SESSAO]);
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

/**
 * `request_id` da cascata. `storage_redaction_queue.request_id` tem FK para
 * `lgpd_requests(id)` (nullable). A rota não tem pedido LGPD, então passa NULL;
 * o `requestId` HTTP (UUID aleatório) violaria a FK.
 *
 * Esta suíte roda SQL puro e não executa a função TypeScript: reproduzimos aqui
 * as mesmas duas operações de `cascadeRedactContact` (upsert do avatar na fila e
 * chamada do RPC). O que a TS passa em cada parâmetro é provado no unit.
 */
describe("request_id da cascata (FK com lgpd_requests)", () => {
  async function semearComFotoEMidia(id: string, sufixo: string) {
    const avatar = `${ORG}/avatars/${id}.jpg`;
    const midia = `${ORG}/midia/${id}.ogg`;
    const conversa = id.replace("-8000-", "-8001-");
    await pool.query(
      `insert into contacts (id, organization_id, name, display_name, phone_number,
                             source_metadata, avatar_storage_path)
       values ($1, $2, 'Fulano Foto', 'Fulano Foto', $3, '{"waha_lid": "123@lid"}'::jsonb, $4)`,
      [id, ORG, `+551180000${sufixo}`, avatar],
    );
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1, $2, $3, $4, 'open', false)`,
      [conversa, ORG, id, SESSAO],
    );
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
                             type, direction, status, body, media_storage_path, sent_at)
       values ($1, $2, $3, $4, 'audio', 'inbound', 'delivered', 'áudio', $5, now())`,
      [ORG, conversa, SESSAO, id, midia],
    );
    return { avatar, midia };
  }

  /** O upsert que `cascadeRedactContact` faz para o avatar. */
  const upsertAvatar = (path: string, requestId: string | null) =>
    pool.query(
      `insert into storage_redaction_queue (organization_id, request_id, bucket, object_path,
                                            status, attempts, processed_at, error_message)
       values ($1, $2, 'whatsapp-media', $3, 'pending', 0, null, null)
       on conflict (bucket, object_path) do update set
         request_id = excluded.request_id, status = 'pending', attempts = 0,
         processed_at = null, error_message = null`,
      [ORG, requestId, path],
    );

  const chamarRpc = (id: string, requestId: string | null) =>
    pool.query(`select fn_lgpd_cascade_redact_contact($1, $2, $3) as res`, [ORG, id, requestId]);

  it("request_id inexistente: o upsert do avatar viola a FK (23503)", async () => {
    const id = "a2a20000-0000-4000-8000-000000000101";
    const { avatar } = await semearComFotoEMidia(id, "0101");
    await expect(upsertAvatar(avatar, PEDIDO_INEXISTENTE)).rejects.toMatchObject({ code: "23503" });
  });

  it("request_id inexistente: o RPC aborta (23503) e nada é anonimizado", async () => {
    const id = "a2a20000-0000-4000-8000-000000000102";
    const { midia } = await semearComFotoEMidia(id, "0102");

    await expect(chamarRpc(id, PEDIDO_INEXISTENTE)).rejects.toMatchObject({ code: "23503" });

    const { rows } = await pool.query(
      `select is_anonymized, name, phone_number from contacts where id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ is_anonymized: false, name: "Fulano Foto" });
    expect(rows[0].phone_number).not.toBeNull();
    const { rows: fila } = await pool.query(
      `select 1 from storage_redaction_queue where object_path = $1`,
      [midia],
    );
    expect(fila).toHaveLength(0);
  });

  it("request_id NULL: avatar e mídia entram na fila sem pedido, o contato é anonimizado e wa_identity zera", async () => {
    const id = "a2a20000-0000-4000-8000-000000000103";
    const { avatar, midia } = await semearComFotoEMidia(id, "0103");

    const { rows: antes } = await pool.query(`select wa_identity from contacts where id = $1`, [id]);
    expect(antes[0].wa_identity).not.toBeNull();

    await upsertAvatar(avatar, null);
    await pool.query(
      `update contacts set avatar_storage_path = null, avatar_updated_at = now() where id = $1`,
      [id],
    );
    const { rows: r } = await chamarRpc(id, null);
    expect(r[0].res.already_anonymized).toBe(false);
    expect(r[0].res.media_paths).toEqual([midia]);

    const { rows: c } = await pool.query(
      `select is_anonymized, wa_identity from contacts where id = $1`,
      [id],
    );
    expect(c[0].is_anonymized).toBe(true);
    expect(c[0].wa_identity).toBeNull();

    const { rows: fila } = await pool.query(
      `select object_path, request_id, status from storage_redaction_queue
        where object_path = any($1::text[]) order by object_path`,
      [[avatar, midia]],
    );
    expect(fila.map((f) => f.object_path).sort()).toEqual([avatar, midia].sort());
    for (const f of fila) {
      expect(f.request_id).toBeNull();
      expect(f.status).toBe("pending");
    }

    const { rows: aud } = await pool.query(
      `select metadata from api_audit_log
        where action = 'lgpd.redact_executed' and resource_id = $1`,
      [id],
    );
    expect(aud).toHaveLength(1);
    expect(aud[0].metadata.request_id).toBeNull();
  });
});
