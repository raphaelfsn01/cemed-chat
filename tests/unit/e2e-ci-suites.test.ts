import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  conferir,
  lerSuites,
  listarSpecs,
  RAIZ,
  resumo,
  type Suites,
} from "@/scripts/ci/e2e-suites";

/**
 * A lista de specs do e2e tem UMA fonte (`tests/e2e/ci-suites.json`) e toda spec
 * tem destino declarado. Antes eram três listas escritas à mão no `e2e.yml`, e
 * duas specs ficaram de fora sem ninguém ter decidido — o resumo do job dizia
 * "32 de 36" com 40 specs no repositório.
 */
const base: Suites = {
  parte1: ["a.spec.ts"],
  parte2: ["b.spec.ts"],
  responsivo: ["r.spec.ts"],
  fora: { "c.spec.ts": "precisa de serviço externo" },
};
const SPECS = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "r.spec.ts"];

describe("conferir — toda spec tem exatamente um destino", () => {
  it("tudo declarado → sem problemas", () => {
    expect(conferir(SPECS, base)).toEqual([]);
  });

  it("spec nova sem destino → problema que diz o que fazer", () => {
    const p = conferir([...SPECS, "nova.spec.ts"], base);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("nova.spec.ts");
    expect(p[0]).toContain('"fora"');
  });

  it("spec em dois lugares, spec inexistente e 'fora' sem motivo → cada um vira problema", () => {
    expect(conferir(SPECS, { ...base, parte2: ["b.spec.ts", "a.spec.ts"] }).join("\n")).toContain(
      "mais de um lugar",
    );
    expect(
      conferir(SPECS, { ...base, parte1: ["a.spec.ts", "sumiu.spec.ts"] }).join("\n"),
    ).toContain("não existe");
    expect(conferir(SPECS, { ...base, fora: { "c.spec.ts": "  " } }).join("\n")).toContain(
      "sem motivo",
    );
  });
});

describe("resumo — contagem sai dos dados, não de texto fixo", () => {
  it("conta o que roda sobre o total e lista o motivo de cada spec de fora", () => {
    const md = resumo(SPECS, base);
    expect(md).toContain("3 de 4 specs");
    expect(md).toContain("- **c**: precisa de serviço externo");
  });
});

describe("o repositório de verdade", () => {
  it("ci-suites.json cobre todas as specs de tests/e2e", () => {
    expect(conferir(listarSpecs(), lerSuites())).toEqual([]);
  });

  it("o e2e.yml não voltou a ter lista de specs escrita à mão", () => {
    const yml = fs.readFileSync(path.join(RAIZ, ".github/workflows/e2e.yml"), "utf8");
    const semComentario = yml
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    const citadas = [...semComentario.matchAll(/[\w-]+\.spec\.ts/g)].map((m) => m[0]);
    // Só a responsiva é citada pelo nome: ela roda com `--project` próprios.
    expect([...new Set(citadas)]).toEqual(["responsivo.spec.ts"]);
    // E a lista `responsivo` do JSON tem que ser exatamente essa: o workflow não a
    // lê. Uma spec acrescentada ali passaria no `check` e nunca rodaria.
    expect(lerSuites().responsivo).toEqual(["responsivo.spec.ts"]);
    expect(semComentario).toContain("scripts/ci/e2e-suites.ts parte1");
    expect(semComentario).toContain("scripts/ci/e2e-suites.ts parte2");
  });

  it("nenhum workflow usa versão móvel: runner, action ou Supabase CLI", () => {
    const dir = path.join(RAIZ, ".github/workflows");
    const arquivos = [
      ...fs.readdirSync(dir).map((f) => path.join(dir, f)),
      path.join(RAIZ, ".github/actions/setup/action.yml"),
    ];
    for (const arquivo of arquivos) {
      const linhas = fs
        .readFileSync(arquivo, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"));
      for (const linha of linhas) {
        const nome = path.basename(arquivo);
        expect(linha, `${nome}: runner móvel`).not.toMatch(/runs-on:\s*ubuntu-latest/);
        expect(linha, `${nome}: versão "latest"`).not.toMatch(/version:\s*latest/);
        const uses = /uses:\s*(\S+)/.exec(linha)?.[1];
        if (uses !== undefined && !uses.startsWith("./")) {
          expect(uses, `${nome}: action sem SHA fixo`).toMatch(/@[0-9a-f]{40}$/);
        }
      }
    }
  });
});
