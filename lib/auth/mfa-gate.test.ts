import { describe, it, expect } from "vitest";

import { precisaSegundoFator } from "@/lib/auth/mfa-gate";

describe("precisaSegundoFator", () => {
  it("trava quem tem autenticador e ainda não digitou o código (o pulo de 2026-10-14)", () => {
    expect(precisaSegundoFator({ currentLevel: "aal1", nextLevel: "aal2" })).toBe(true);
  });

  it("libera quem já digitou o código", () => {
    expect(precisaSegundoFator({ currentLevel: "aal2", nextLevel: "aal2" })).toBe(false);
  });

  it("libera quem não tem autenticador — a atendente não vê código", () => {
    expect(precisaSegundoFator({ currentLevel: "aal1", nextLevel: "aal1" })).toBe(false);
  });

  it("sem informação de nível não inventa trava (o proxy já barrou quem não tem sessão)", () => {
    expect(precisaSegundoFator(null)).toBe(false);
    expect(precisaSegundoFator({ currentLevel: null, nextLevel: null })).toBe(false);
  });
});
