/**
 * O painel de configuração do nó — o que ele OFERECE e o que ele ENVIA.
 *
 * O teste que dá nome a este arquivo é o do valor numérico. O avaliador do motor
 * (`lib/followup/node-handlers.ts`) só compara `gte`/`lte` quando os dois lados
 * são número; a tela mandava sempre string, então toda condição numérica editada
 * por aqui ficava permanentemente falsa — salvando e publicando sem erro nenhum.
 * É o tipo de defeito que não aparece em tela: aparece em fluxo que nunca dispara.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  usePipelines: () => ({ data: { data: [{ id: "pipe-1", name: "Atendimento" }] } }),
  usePipelineStages: (id: string | null) => ({
    data: id ? { data: { stages: [{ id: "stage-1", name: "Qualificado" }] } } : undefined,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [{ id: "tpl-1", title: "Saudação inicial" }] }),
}));

import type { RFNode } from "@/lib/followup/graph-mappers";
import type { FlowNode } from "@/lib/followup/graph-schema";
import { NodeConfigPanel } from "./NodeConfigPanel";

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function noNo(config: FlowNode["config"], type: FlowNode["type"] = "condition"): RFNode {
  return {
    id: `${type}-1`,
    type,
    position: { x: 0, y: 0 },
    data: { label: "Verificar condição", config },
  } as unknown as RFNode;
}

describe("NodeConfigPanel — condição", () => {
  beforeEach(() => vi.clearAllMocks());

  it("envia o valor numérico como NÚMERO, nunca como texto", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <NodeConfigPanel
        node={noNo({ combinator: "and", checks: [{ field: "steps_taken", op: "gte", value: 0 }] })}
        onChange={onChange}
      />,
    );

    const valor = screen.getByLabelText("Valor");
    await user.clear(valor);
    await user.type(valor, "3");

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const ultimo = onChange.mock.calls.at(-1)?.[0];
    const check = ultimo.config.checks[0];
    expect(check.value).toBe(3);
    expect(typeof check.value).toBe("number");
  });

  it("oferece só os operadores que fazem sentido no campo", async () => {
    const user = userEvent.setup();
    render(
      <NodeConfigPanel
        node={noNo({ combinator: "and", checks: [{ field: "tag", op: "eq", value: "vip" }] })}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Operador"));
    const opcoes = await screen.findAllByRole("option");
    const textos = opcoes.map((o) => o.textContent);
    expect(textos).toEqual(["incluem", "não incluem"]);
  });

  it("mostra os campos em português, sem identificador cru", async () => {
    const user = userEvent.setup();
    render(
      <NodeConfigPanel
        node={noNo({ combinator: "and", checks: [{ field: "steps_taken", op: "gte", value: 2 }] })}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("steps_taken")).toBeNull();
    await user.click(screen.getByLabelText("Campo"));
    const textos = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(textos).toContain("Passos que o fluxo já deu");
    expect(textos).toContain("Etapa do funil");
    // Campo sem produtor no motor não é oferecido.
    expect(textos).not.toContain("Resultado da última classificação");
  });

  it("descreve a regra como frase", () => {
    render(
      <NodeConfigPanel
        node={noNo({ combinator: "and", checks: [{ field: "steps_taken", op: "gte", value: 2 }] })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("os passos que o fluxo já deu forem pelo menos 2")).toBeTruthy();
  });

  it("avisa, sem esconder, o nó já salvo num campo que o motor não preenche", () => {
    render(
      <NodeConfigPanel
        node={noNo({ combinator: "and", checks: [{ field: "last_outcome", op: "eq", value: "hot" }] })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/nunca será verdadeira/)).toBeTruthy();
  });

  it("escolhe a etapa pelo nome do funil, não por UUID digitado", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <NodeConfigPanel
        node={noNo({ combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: "" }] })}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByLabelText("Valor"));
    await user.click(await screen.findByRole("option", { name: "Qualificado" }));

    const ultimo = onChange.mock.calls.at(-1)?.[0];
    expect(ultimo.config.checks[0].value).toBe("stage-1");
    expect(screen.getByText("a etapa do funil for Qualificado")).toBeTruthy();
  });
});

describe("NodeConfigPanel — ação", () => {
  it("não deixa escolher o modo que o motor não executa", async () => {
    const user = userEvent.setup();
    render(
      <NodeConfigPanel
        node={noNo({ mode: "ai_message", prompt_hint: "Pergunte se ainda tem interesse." }, "action")}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Modo"));
    const fixo = await screen.findByRole("option", { name: /Template fixo/ });
    expect(fixo.getAttribute("aria-disabled")).toBe("true");
  });

  it("oferece a resposta rápida de reserva por nome, não por UUID", () => {
    render(
      <NodeConfigPanel
        node={noNo({ mode: "ai_message", prompt_hint: "Pergunte se ainda tem interesse." }, "action")}
        onChange={vi.fn()}
      />,
    );
    const campo = screen.getByLabelText("Resposta rápida de reserva (opcional)");
    expect(within(campo).queryByText("Nenhuma")).toBeTruthy();
  });
});
