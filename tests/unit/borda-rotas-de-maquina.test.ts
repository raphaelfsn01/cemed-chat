import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runnerUrl } from "@/lib/ai/dispatcher";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/env", () => ({ env: {} }));

/**
 * ROTAS DE MÁQUINA SÓ PELA REDE INTERNA (auditoria 2026-10-21, B7).
 *
 * O Caddy devolve 403 para /api/internal/* e /api/v1/cron/* vindos do domínio.
 * Isso só é seguro enquanto NINGUÉM legítimo os chama pelo domínio — senão o
 * bloqueio vira falha calada: o `curl -fsS ... >/dev/null` do scheduler engole
 * o 403, e o runner do agente é fire-and-forget. Este arquivo cerca os dois
 * lados: a borda bloqueia, e quem chama usa o endereço interno.
 *
 * A prova de comportamento (30 variantes de caminho contra um Caddy de verdade)
 * está no PR; aqui fica o que reprova uma regressão no CI.
 */

const RAIZ = join(__dirname, "..", "..");
const ler = (arq: string) => readFileSync(join(RAIZ, arq), "utf8");

/** Bloco de um serviço no compose: da linha `  <nome>:` até o próximo serviço. */
function servico(yml: string, nome: string): string {
  const m = yml.match(new RegExp(`\\n  ${nome}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9_-]*:\\n|\\nvolumes:)`));
  if (!m) throw new Error(`serviço ${nome} não achado no compose`);
  return m[1]!;
}

describe("quem chama rota de máquina usa a rede interna", () => {
  it("todo curl do scheduler vai para http://app:3000", () => {
    const urls = [...servico(ler("docker-compose.prod.yml"), "scheduler").matchAll(/curl [^\n]*?"?(\S*\/api\/[^\s"]+)/g)].map(
      (m) => m[1]!,
    );
    expect(urls.length).toBeGreaterThan(0);
    const porFora = urls.filter((u) => !u.startsWith("http://app:3000/"));
    expect(porFora, `linha do scheduler chamando pelo domínio leva 403 do Caddy, calada: ${porFora.join(", ")}`).toEqual([]);
  });

  it("o app recebe INTERNAL_APP_URL apontando para si mesmo na rede do compose", () => {
    expect(servico(ler("docker-compose.prod.yml"), "app")).toMatch(
      /INTERNAL_APP_URL: \$\{INTERNAL_APP_URL:-http:\/\/app:3000\}/,
    );
  });

  it("o dispatcher chama o runner pelo endereço interno quando ele existe", () => {
    expect(
      runnerUrl({ INTERNAL_APP_URL: "http://app:3000", NEXT_PUBLIC_APP_URL: "https://cemed.exemplo.com" }),
    ).toBe("http://app:3000/api/internal/agents/run");
    expect(runnerUrl({ INTERNAL_APP_URL: "http://app:3000/" })).toBe("http://app:3000/api/internal/agents/run");
  });

  it("sem endereço interno (Vercel, dev), cai no NEXT_PUBLIC_APP_URL", () => {
    expect(runnerUrl({ INTERNAL_APP_URL: "", NEXT_PUBLIC_APP_URL: "https://x.vercel.app" })).toBe(
      "https://x.vercel.app/api/internal/agents/run",
    );
  });
});

describe("Caddyfile: a borda", () => {
  const caddy = ler("Caddyfile");
  const route = caddy.slice(caddy.indexOf("route {"));

  it("recusa /api/internal/* e /api/v1/cron/* antes do reverse_proxy", () => {
    const matcher = caddy.match(/^\s*@maquina path (.+)$/m);
    expect(matcher, "matcher @maquina sumiu").not.toBeNull();
    expect(matcher![1]!.split(/\s+/).sort()).toEqual(
      ["/api/internal", "/api/internal/*", "/api/v1/cron", "/api/v1/cron/*"].sort(),
    );
    const bloqueio = route.indexOf("respond @maquina 403");
    expect(bloqueio, "o respond tem de estar dentro de `route`, senão o Caddy o põe depois do proxy").toBeGreaterThan(0);
    expect(bloqueio).toBeLessThan(route.indexOf("reverse_proxy app:3000"));
  });

  it("não há mais proxy dedicado para /api/internal", () => {
    expect(caddy).not.toMatch(/reverse_proxy @\w+ app:3000/);
  });

  it("HSTS de 6 meses, sem includeSubDomains e sem preload", () => {
    const hsts = caddy.match(/^\s*header Strict-Transport-Security "([^"]+)"$/m);
    expect(hsts, "header HSTS sumiu").not.toBeNull();
    expect(hsts![1]).toBe("max-age=15768000");
  });
});
