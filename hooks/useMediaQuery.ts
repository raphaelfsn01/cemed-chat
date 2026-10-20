"use client";
import { useSyncExternalStore } from "react";

/**
 * `true` quando a media query casa. No servidor (e na hidratação) é `false`.
 *
 * Use só onde CSS não resolve — hoje, o construtor de fluxos, que troca um
 * painel docado por uma gaveta modal (um Radix Dialog, que prende o foco e
 * bloqueia o canvas, não pode existir "escondido por CSS" no desktop).
 * Alternar layout com isto causa flash: o servidor sempre renderiza o caso
 * `false`. Por isso a inbox troca lista/conversa só com classes.
 *
 * `useSyncExternalStore` em vez de `useState` + efeito: sem render extra e sem
 * estado derivado fora de sincronia com o `matchMedia`.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (avisar) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", avisar);
      return () => mql.removeEventListener("change", avisar);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
