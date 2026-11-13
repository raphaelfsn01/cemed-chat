import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as Queue from "@/lib/agent-engine/queue/queue";

/**
 * Job que falha volta à fila COM espera (15 s dobrando, teto 2 min).
 *
 * Caso de origem (23/10, 14:10 BRT): o provedor de IA respondeu 404 e o
 * `inbound_turn` queimou as 5 tentativas em ~25 s — morreu dentro da própria
 * instabilidade que o retry existe para atravessar.
 *
 * Contra Postgres real porque a conta do `run_after` é feita no SQL do `failJob`
 * (relógio do banco) e o que importa é o efeito no `claimJobs`: job em espera
 * NÃO pode ser reclamado. O unit de `retryBackoffMs` só prova a tabela de valores.
 */

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "0e4aaaaa-0000-4000-8000-000000000001";
const WORKER = "retry-espera";

let queue: typeof Queue;

async function esperaRestanteMs(jobId: string): Promise<number> {
  const { rows } = await pool.query<{ ms: string }>(
    `select extract(epoch from (run_after - now())) * 1000 as ms from job_queue where id = $1`,
    [jobId],
  );
  return Number(rows[0]!.ms);
}

/** Simula a passagem do tempo: a espera do job vence agora. */
async function venceAEspera(jobId: string): Promise<void> {
  await pool.query(`update job_queue set run_after = now() where id = $1`, [jobId]);
}

async function reclama(): Promise<Queue.JobRow | undefined> {
  const [job] = await queue.claimJobs(pool, { workerId: WORKER, maxConcurrency: 1 });
  return job;
}

beforeAll(async () => {
  queue = await import("@/lib/agent-engine/queue/queue");
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'fila-retry-espera','Fila Retry Espera','Fila Retry Espera')
     on conflict (id) do nothing`,
    [ORG],
  );
});

beforeEach(async () => {
  // O PG efêmero é compartilhado: neutraliza jobs alheios para o claim pegar o deste arquivo.
  await pool.query("update job_queue set status = 'done' where status in ('pending','running')");
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
});

describe("failJob — retry com espera", () => {
  it("cada falha adia o job: 15 s, 30 s, 60 s, 120 s; na 5ª ele morre e a Central é avisada", async () => {
    const { job } = await queue.enqueueJob(pool, ORG, { kind: "watchdog", maxAttempts: 5 });

    const esperado = [15_000, 30_000, 60_000, 120_000];
    for (const [i, ms] of esperado.entries()) {
      const claimed = await reclama();
      expect(claimed?.id, `tentativa ${i + 1} não foi reclamada`).toBe(job.id);
      const falho = await queue.failJob(pool, job.id, WORKER, new Error("provedor fora do ar"));
      expect(falho).toMatchObject({ status: "pending", attempts: i + 1 });

      // Tolerância de 2 s: o relógio é o do banco e o teste roda logo depois do UPDATE.
      const resta = await esperaRestanteMs(job.id);
      expect(resta).toBeGreaterThan(ms - 2_000);
      expect(resta).toBeLessThanOrEqual(ms);

      // O ponto do conserto: em espera, o job NÃO é reclamável.
      expect(await reclama(), `job reclamado antes da espera de ${ms} ms`).toBeUndefined();
      await venceAEspera(job.id);
    }

    const ultima = await reclama();
    expect(ultima?.id).toBe(job.id);
    const antes = await pool.query<{ run_after: Date }>(`select run_after from job_queue where id = $1`, [job.id]);
    const morto = await queue.failJob(pool, job.id, WORKER, new Error("provedor fora do ar"));
    expect(morto).toMatchObject({ status: "dead", attempts: 5 });
    // Job morto não ganha espera nova: o run_after fica como estava.
    expect(morto!.run_after.getTime()).toBe(antes.rows[0]!.run_after.getTime());

    const { rows: avisos } = await pool.query<{ kind: string; severity: string; ref_id: string }>(
      `select kind, severity, ref_id from agent_inbox_items where organization_id = $1`,
      [ORG],
    );
    expect(avisos).toEqual([{ kind: "job_dead", severity: "critical", ref_id: job.id }]);
  });

  it("a espera é do job que falhou, não da fila: outro job pendente é reclamado na hora", async () => {
    const { job: falho } = await queue.enqueueJob(pool, ORG, { kind: "watchdog", maxAttempts: 5 });
    expect((await reclama())?.id).toBe(falho.id);
    await queue.failJob(pool, falho.id, WORKER, new Error("x"));

    const { job: outro } = await queue.enqueueJob(pool, ORG, { kind: "watchdog" });
    expect((await reclama())?.id).toBe(outro.id);
  });

  it("lease de outro worker: failJob não mexe em nada (nem no run_after)", async () => {
    const { job } = await queue.enqueueJob(pool, ORG, { kind: "watchdog", maxAttempts: 5 });
    expect((await reclama())?.id).toBe(job.id);
    expect(await queue.failJob(pool, job.id, "outro-worker", new Error("x"))).toBeNull();
    const { rows } = await pool.query<{ status: string; atrasado: boolean }>(
      `select status, run_after > now() as atrasado from job_queue where id = $1`,
      [job.id],
    );
    expect(rows[0]).toEqual({ status: "running", atrasado: false });
  });
});
