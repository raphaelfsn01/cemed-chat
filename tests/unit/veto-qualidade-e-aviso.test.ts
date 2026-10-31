/**
 * PR-1 do agente: veto de QUALIDADE vira reescrita (não transferência) e a trava
 * "avise antes" só vale com envio ENTREGUE.
 *
 * Defeito (teste real de 30/10): send_message vetado por promise_semantic; o modelo, sem
 * instrução, chamou request_human_handoff; o send_message seguinte foi vetado por
 * handoff_ativo. Nenhuma mensagem chegou ao paciente.
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";

import {
  applyRequestHumanHandoff,
  CODIGOS_DE_VETO_DE_QUALIDADE,
  criarEnviosEmAndamento,
  MAX_VETOS_DE_QUALIDADE,
  mensagemDeFallbackDoVeto,
  mensagemDeReescrita,
} from "@/lib/agent-engine/agent/human-handoff";

const IDS = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  leadId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000003",
};
const LOG = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;
const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** db fake: registra o SQL; tudo devolve vazio. O que importa é se o handoff chegou a gravar. */
function dbFalso() {
  const sqls: string[] = [];
  const db = {
    query: async (sql: string) => {
      sqls.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { db, gravouForceHuman: () => sqls.some((s) => /update contacts set force_human/.test(s)) };
}

describe("quais vetos contam como qualidade", () => {
  it("só promise_semantic e promise_out_of_table", () => {
    expect([...CODIGOS_DE_VETO_DE_QUALIDADE].sort()).toEqual(["promise_out_of_table", "promise_semantic"]);
  });

  it("vetos de parada e os com fail-safe próprio NÃO contam", () => {
    for (const code of [
      "contato_bloqueado",
      "handoff_ativo",
      "lgpd_anonymized",
      "case_promise_without_case",
      "internal_vocabulary_leak",
    ]) {
      expect(CODIGOS_DE_VETO_DE_QUALIDADE.has(code), code).toBe(false);
    }
  });

  it("a reescrita é UMA: o 2º veto aciona o fallback", () => {
    expect(MAX_VETOS_DE_QUALIDADE).toBe(2);
  });
});

describe("textos do veto e do fallback", () => {
  it("o veto manda reescrever uma vez e NÃO empurra para transferir", () => {
    const m = mensagemDeReescrita("motivo qualquer");
    expect(m).toContain("Reescreva UMA vez, sem prometer nada");
    expect(m).toContain("não transfira por causa deste aviso");
    expect(m).toContain("transfira só se a reescrita também for vetada");
    expect(m).toContain("motivo qualquer");
  });

  it("fallback com gente disponível: sem prazo e sem horário", () => {
    const t = mensagemDeFallbackDoVeto({ disponiveis: 2, total: 3 });
    expect(t).toBe(
      "Entendi. Vou passar sua conversa agora para uma pessoa da nossa equipe. Ela continua o atendimento em seguida.",
    );
    expect(t).not.toMatch(/\d/);
  });

  it("fallback sem ninguém disponível, ou com leitura que falhou: frase conservadora", () => {
    const esperado =
      "Entendi. Vou passar sua conversa agora para uma pessoa da nossa equipe. A equipe retorna assim que possível.";
    expect(mensagemDeFallbackDoVeto({ disponiveis: 0, total: 3 })).toBe(esperado);
    expect(mensagemDeFallbackDoVeto({ disponiveis: 0, total: 0 })).toBe(esperado);
    expect(mensagemDeFallbackDoVeto(null)).toBe(esperado);
  });
});

describe("avise_antes só vale com envio ENTREGUE (a espera vem antes da trava)", () => {
  it("envio em andamento que termina SEM entrega (vetado): o handoff é recusado", async () => {
    const { db, gravouForceHuman } = dbFalso();
    const envios = criarEnviosEmAndamento();
    const aviso = { tentou: false, jaRecusou: false };
    const fim = envios.iniciar();
    setTimeout(fim, 20); // vetado: termina sem marcar `tentou`

    const res = await applyRequestHumanHandoff(
      db,
      IDS,
      { conversationSummary: "s", log: LOG, aviso, envios, esperaMaximaMs: 2000 },
      {},
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("avise_antes");
    expect(gravouForceHuman()).toBe(false);
  });

  it("envio em andamento que ENTREGA durante a espera: o handoff passa", async () => {
    // Sem a espera antes da trava, `tentou` ainda seria false e o handoff seria recusado.
    const { db, gravouForceHuman } = dbFalso();
    const envios = criarEnviosEmAndamento();
    const aviso = { tentou: false, jaRecusou: false };
    const fim = envios.iniciar();
    setTimeout(() => {
      aviso.tentou = true; // entregue
      fim();
    }, 20);

    await applyRequestHumanHandoff(
      db,
      IDS,
      { conversationSummary: "s", log: LOG, aviso, envios, esperaMaximaMs: 2000 },
      {},
    ).catch(() => undefined); // o db fake pode falhar depois da gravação; só ela importa
    expect(gravouForceHuman()).toBe(true);
  });

  it("envio travado além do teto: o handoff segue SEM exigir entrega (PR #38)", async () => {
    const { db, gravouForceHuman } = dbFalso();
    const envios = criarEnviosEmAndamento();
    const aviso = { tentou: false, jaRecusou: false };
    const fim = envios.iniciar();

    await applyRequestHumanHandoff(
      db,
      IDS,
      { conversationSummary: "s", log: LOG, aviso, envios, esperaMaximaMs: 30 },
      {},
    ).catch(() => undefined);
    expect(gravouForceHuman()).toBe(true);
    fim();
    await dorme(0);
  });

  it("sem nenhum envio: recusa uma vez; a 2ª chamada (jaRecusou) passa", async () => {
    const a = dbFalso();
    const envios = criarEnviosEmAndamento();
    const r1 = await applyRequestHumanHandoff(
      a.db,
      IDS,
      { conversationSummary: "s", log: LOG, aviso: { tentou: false, jaRecusou: false }, envios },
      {},
    );
    expect(r1.ok).toBe(false);

    const b = dbFalso();
    await applyRequestHumanHandoff(
      b.db,
      IDS,
      { conversationSummary: "s", log: LOG, aviso: { tentou: false, jaRecusou: true }, envios },
      {},
    ).catch(() => undefined);
    expect(b.gravouForceHuman()).toBe(true);
  });
});
