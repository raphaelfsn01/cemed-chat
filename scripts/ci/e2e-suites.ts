/**
 * Fonte única das suítes de E2E do CI — `tests/e2e/ci-suites.json`.
 *
 * As listas de specs viviam escritas à mão em três lugares do `e2e.yml` (duas
 * invocações do Playwright e o resumo do job) e derivaram sem ninguém notar: com
 * 40 specs no repositório o resumo dizia "32 de 36", e duas specs do painel de
 * leads ficaram de fora sem que alguém tivesse decidido isso. Spec que não roda
 * e não está declarada como "fora" se lê como cobertura que não existe.
 *
 * Uso (o `e2e.yml` e o job `verify` chamam):
 *   tsx scripts/ci/e2e-suites.ts parte1 | parte2   → nomes das specs, separados por espaço
 *   tsx scripts/ci/e2e-suites.ts check             → falha se alguma spec não tem destino
 *   tsx scripts/ci/e2e-suites.ts resumo            → Markdown para o resumo do job
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Suites {
  parte1: string[];
  parte2: string[];
  responsivo: string[];
  /** spec → por que não roda no CI. Motivo vazio não vale como declaração. */
  fora: Record<string, string>;
}

export const RAIZ = path.resolve(__dirname, "../..");
export const DIR_SPECS = path.join(RAIZ, "tests/e2e");
export const ARQUIVO_SUITES = path.join(DIR_SPECS, "ci-suites.json");

export function lerSuites(arquivo: string = ARQUIVO_SUITES): Suites {
  return JSON.parse(fs.readFileSync(arquivo, "utf8")) as Suites;
}

export function listarSpecs(dir: string = DIR_SPECS): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
}

/** Devolve a lista de problemas; vazia = toda spec tem exatamente um destino. */
export function conferir(specs: readonly string[], suites: Suites): string[] {
  const problemas: string[] = [];
  const destinos = new Map<string, string[]>();
  const anota = (spec: string, onde: string): void => {
    destinos.set(spec, [...(destinos.get(spec) ?? []), onde]);
  };
  for (const s of suites.parte1) anota(s, "parte1");
  for (const s of suites.parte2) anota(s, "parte2");
  for (const s of suites.responsivo) anota(s, "responsivo");
  for (const s of Object.keys(suites.fora)) anota(s, "fora");

  const existentes = new Set(specs);
  for (const spec of specs) {
    const onde = destinos.get(spec);
    if (onde === undefined) {
      problemas.push(
        `${spec}: não está em nenhuma suíte nem em "fora" — ponha em parte1/parte2 ou declare o motivo em "fora"`,
      );
    } else if (onde.length > 1) {
      problemas.push(`${spec}: aparece em mais de um lugar (${onde.join(", ")})`);
    }
  }
  for (const spec of destinos.keys()) {
    if (!existentes.has(spec))
      problemas.push(`${spec}: citada no ci-suites.json mas não existe em tests/e2e`);
  }
  for (const [spec, motivo] of Object.entries(suites.fora)) {
    if (motivo.trim() === "") problemas.push(`${spec}: está em "fora" sem motivo`);
  }
  return problemas;
}

export function resumo(specs: readonly string[], suites: Suites): string {
  const nome = (s: string): string => s.replace(/\.spec\.ts$/, "");
  const rodam = suites.parte1.length + suites.parte2.length + suites.responsivo.length;
  const linhas = [
    "## E2E — cobertura deste job",
    "",
    `**Rodam no CI: ${rodam} de ${specs.length} specs** ` +
      `(parte 1: ${suites.parte1.length}; parte 2: ${suites.parte2.length}; ` +
      `responsivo: ${suites.responsivo.length}, na outra perna da matriz).`,
    "",
    `Parte 1: ${suites.parte1.map(nome).join(", ")}.`,
    "",
    `Parte 2: ${suites.parte2.map(nome).join(", ")}.`,
    "",
    `**Não rodam (${Object.keys(suites.fora).length}):**`,
    ...Object.entries(suites.fora).map(([spec, motivo]) => `- **${nome(spec)}**: ${motivo}`),
    "",
    "Fonte: `tests/e2e/ci-suites.json`. Expandir é trabalho de seguimento — issue #63.",
  ];
  return linhas.join("\n");
}

function main(argv: readonly string[]): number {
  const comando = argv[0];
  const suites = lerSuites();
  const specs = listarSpecs();
  if (comando === "parte1" || comando === "parte2") {
    const lista = suites[comando];
    if (lista.length === 0) {
      process.stderr.write(
        `suíte ${comando} vazia — rodar o Playwright sem filtro executaria TUDO\n`,
      );
      return 1;
    }
    process.stdout.write(`${lista.join(" ")}\n`);
    return 0;
  }
  if (comando === "resumo") {
    process.stdout.write(`${resumo(specs, suites)}\n`);
    return 0;
  }
  if (comando === "check") {
    const problemas = conferir(specs, suites);
    if (problemas.length === 0) {
      process.stdout.write(`e2e-suites: ${specs.length} specs, todas com destino declarado\n`);
      return 0;
    }
    process.stderr.write(
      `e2e-suites: ${problemas.length} problema(s) em tests/e2e/ci-suites.json\n`,
    );
    for (const p of problemas) process.stderr.write(`  - ${p}\n`);
    return 1;
  }
  process.stderr.write("uso: tsx scripts/ci/e2e-suites.ts parte1|parte2|check|resumo\n");
  return 2;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
