/**
 * Invariante de ALCANCE: o que a `OPENROUTER_API_KEY` roteia — e o que ela não
 * roteia.
 *
 * Por que este arquivo existe: o `.env.example` afirma ao self-hoster quais
 * caminhos passam a usar a OpenRouter quando ele preenche a chave. Afirmação em
 * comentário não se defende sozinha — a primeira pessoa que ligar o resolver a
 * um caminho novo não vai lembrar de reescrever o aviso, e o usuário decide a
 * configuração da instalação lendo justamente esse aviso.
 *
 * ATÉ A MIGRATION 0119 este arquivo cravava o oposto do que crava hoje: que a
 * OpenRouter NÃO alcançava o agente, e que por isso o aviso não precisava
 * assustar com tool calling. A versão anterior dizia, textualmente, "no dia em
 * que alcançar, o aviso PRECISA assustar — e este teste é quem obriga a decidir
 * isso conscientemente". A 0119 foi esse dia: a OpenRouter virou provider de
 * primeira classe do agente (`lib/agent-engine/edge/llm/providers.ts`, que é o
 * runtime do turno real, e `lib/ai/runtime/agent.ts`, que é a tela de teste).
 *
 * O risco que o aviso precisa carregar agora: o agente opera por FERRAMENTAS, e
 * modelo com tool calling fraco não falha alto — devolve texto plausível e nunca
 * cria o lead nem move o card. A OpenRouter expõe centenas de modelos, então a
 * escolha do id virou decisão de risco, não de preço.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = resolve(__dirname, "../..");

/** Arquivos de produção que importam o resolver (exclui testes e o próprio módulo). */
function chamadoresDoResolver(): string[] {
  const saida = execFileSync(
    "git",
    ["grep", "-l", "resolveLanguageModel", "--", "lib", "workers", "app", "scripts"],
    { cwd: RAIZ, encoding: "utf8" },
  );
  return saida
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes(".test.") && f !== "lib/ai/gateway.ts" && f !== "lib/env.ts");
}

/** Os dois runtimes que passam `tools` ao modelo e montam o LM por conta própria. */
const RUNTIMES_COM_FERRAMENTAS = [
  "lib/agent-engine/edge/llm/providers.ts",
  "lib/ai/runtime/agent.ts",
];

const DOCS_DE_ENV = [".env.example", ".env.hostgator.example"];

describe("alcance da OPENROUTER_API_KEY", () => {
  it("o resolver tem chamadores — senão o invariante estaria passando por vacuidade", () => {
    // Sem esta asserção, apagar o resolver deixaria o teste abaixo verde e o
    // aviso do .env.example desprotegido.
    expect(chamadoresDoResolver().length).toBeGreaterThan(0);
  });

  it("os runtimes COM ferramentas conhecem a OpenRouter — os dois, não só um", () => {
    // Meio caminho é pior que nenhum: o turno de WhatsApp funcionando pela
    // OpenRouter enquanto a tela de teste estoura `unsupported_provider` é uma
    // divergência que só aparece quando alguém clica em "testar".
    for (const arquivo of RUNTIMES_COM_FERRAMENTAS) {
      expect(
        readFileSync(resolve(RAIZ, arquivo), "utf8").toLowerCase(),
        `${arquivo} não conhece a OpenRouter, mas o outro runtime com ferramentas conhece`,
      ).toContain("openrouter");
    }
  });

  it("o aviso de env carrega o risco de tool calling — porque agora ele existe", () => {
    // Este é o teste que a versão anterior deste arquivo prometeu: alcançou o
    // agente, então o aviso tem que assustar. Se alguém amaciar o texto, cai aqui.
    for (const doc of DOCS_DE_ENV) {
      const conteudo = readFileSync(resolve(RAIZ, doc), "utf8").toLowerCase();
      expect(conteudo, `${doc} não menciona OpenRouter`).toContain("openrouter");
      expect(
        conteudo,
        `${doc} fala da OpenRouter sem avisar do risco de tool calling — o agente ` +
          "roda por ferramentas e modelo fraco falha em silêncio",
      ).toContain("tool calling");
    }
  });

  it("a OpenRouter não vira provider de embedding por engano", () => {
    // Ela não faz embedding. Se alguém apontar o embed pra lá, o RAG morre
    // silenciosamente — e o aviso de env que manda manter OPENAI_API_KEY vira
    // mentira.
    const embed = readFileSync(
      resolve(RAIZ, "lib/agent-engine/edge/llm/embed.ts"),
      "utf8",
    ).toLowerCase();
    expect(embed).not.toContain("openrouter");
  });
});
