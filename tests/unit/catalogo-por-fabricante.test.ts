/**
 * A derivação de FABRICANTE a partir do catálogo — o que alimenta as duas
 * caixas do card "A inteligência que ele usa".
 *
 * Por que este arquivo existe: a caixa "Empresa" tinha uma lista FIXA no código
 * (`AgentForm.tsx`), e foi exatamente isso que deixou `openrouter` de fora
 * quando a migration 0119 o adicionou em todo o resto — o valor vindo do banco
 * não casava com nenhuma opção e a tela zerava modelo e credencial sozinha.
 *
 * A lista agora é derivada do catálogo (`ai_models` sob provider `openrouter`),
 * pelo prefixo do `model_id`. Estas funções são a tradução — e se elas errarem,
 * o sintoma volta a ser uma tela que perde a configuração em silêncio.
 */
import { describe, expect, it } from "vitest";

import {
  fabricantesDoCatalogo,
  filtrarPorFabricante,
  type ModelOption,
} from "@/app/app/ai/agents/[id]/_components/ModelPicker";

function modelo(model_id: string): ModelOption {
  return {
    provider: "openrouter",
    model_id,
    display_name: model_id,
    context_window: null,
    is_default_for_provider: false,
  };
}

const CATALOGO = [
  modelo("anthropic/claude-sonnet-5"),
  modelo("anthropic/claude-opus-5"),
  modelo("deepseek/deepseek-v4-pro"),
  modelo("moonshotai/kimi-k3"),
  modelo("z-ai/glm-5.3"),
];

describe("fabricantesDoCatalogo", () => {
  it("extrai os fabricantes sem repetir e em ordem alfabética", () => {
    expect(fabricantesDoCatalogo(CATALOGO)).toEqual([
      "anthropic",
      "deepseek",
      "moonshotai",
      "z-ai",
    ]);
  });

  it("aceita fabricante com hífen — `z-ai` não pode ser partido", () => {
    expect(fabricantesDoCatalogo([modelo("z-ai/glm-5.3")])).toEqual(["z-ai"]);
  });

  it("ignora id SEM barra em vez de criar opção inválida", () => {
    // Ids nus (`claude-sonnet-5`) são dos providers diretos, formato anterior à
    // OpenRouter. Tratá-los como fabricante encheria a caixa "Empresa" de
    // opções que não filtram nada.
    expect(fabricantesDoCatalogo([modelo("claude-sonnet-5"), modelo("gpt-5.5")])).toEqual([]);
  });

  it("catálogo vazio não quebra", () => {
    expect(fabricantesDoCatalogo([])).toEqual([]);
  });
});

describe("filtrarPorFabricante", () => {
  it("devolve só os modelos do fabricante pedido", () => {
    const r = filtrarPorFabricante(CATALOGO, "anthropic");
    expect(r.map((m) => m.model_id)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
    ]);
  });

  it("exige a barra — prefixo parcial não casa", () => {
    // Sem a barra, "deep" casaria com "deepseek/..." e a caixa mostraria
    // modelo de outro fabricante.
    expect(filtrarPorFabricante(CATALOGO, "deep")).toEqual([]);
  });

  it("sem fabricante, devolve tudo — é o comportamento de quem não usa o filtro", () => {
    expect(filtrarPorFabricante(CATALOGO, undefined)).toHaveLength(CATALOGO.length);
    expect(filtrarPorFabricante(CATALOGO, "")).toHaveLength(CATALOGO.length);
  });

  it("fabricante inexistente devolve lista vazia, não o catálogo inteiro", () => {
    // Guarda contra o erro clássico de "filtro vazio = sem filtro": aqui o
    // usuário escolheu uma empresa, e mostrar os modelos das outras seria pior
    // que mostrar nenhum.
    expect(filtrarPorFabricante(CATALOGO, "mistralai")).toEqual([]);
  });
});
