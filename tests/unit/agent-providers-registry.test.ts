import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";

describe("createDefaultRegistry", () => {
  it("registra os providers suportados pelo runtime do turno", () => {
    // A lista é cobrada por igualdade, não por `toContain`: provider que entra
    // no registro sem entrar no CHECK de `ai_agent_versions.provider` (e vice-versa)
    // é uma opção que existe no código e o banco recusa — ou o contrário.
    // `openrouter` entrou na migration 0119.
    const reg = createDefaultRegistry();
    expect(Object.keys(reg).sort()).toEqual(["anthropic", "google", "openai", "openrouter"]);
  });
  it("cada factory produz um LanguageModel (não lança ao instanciar)", () => {
    const reg = createDefaultRegistry();
    expect(() => reg.anthropic!("k", "claude-sonnet-4-6")).not.toThrow();
    expect(() => reg.openai!("k", "gpt-5")).not.toThrow();
    expect(() => reg.google!("k", "gemini-2.5-pro")).not.toThrow();
    // Id qualificado por vendor é o formato da OpenRouter — o mesmo id que vai
    // para `ai_models.model_id` sob provider `openrouter`.
    expect(() => reg.openrouter!("k", "anthropic/claude-sonnet-5")).not.toThrow();
  });
});
