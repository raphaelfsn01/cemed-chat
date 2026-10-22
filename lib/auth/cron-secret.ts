/**
 * Quem pode chamar `/api/v1/cron/*` e o heartbeat do agente do host
 * (`/api/v1/system/agent`): um segredo, comparado em tempo constante.
 *
 * Antes (auditoria de 2026-10-21, M5/B6) cada rota aceitava `INTERNAL_CRON_SECRET`
 * OU `INTERNAL_SECRET`, comparados com `Array.includes`. Com o `scheduler`
 * mandando `INTERNAL_SECRET`, o segredo do cron era o mesmo que assina convite e
 * abre `/api/internal/*` — vazar um vazava os três.
 *
 * Agora:
 *   - `INTERNAL_CRON_SECRET` definido → os crons aceitam SÓ ele;
 *   - vazio → caem no `INTERNAL_SECRET` (o comportamento de antes), para não
 *     derrubar os crons de quem atualiza um clone cujo `.env` não o tem.
 */
import { timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

export function segredosDeCron(): string[] {
  if (env.INTERNAL_CRON_SECRET) return [env.INTERNAL_CRON_SECRET];
  return env.INTERNAL_SECRET ? [env.INTERNAL_SECRET] : [];
}

/** O segredo que veio na requisição: `Authorization: Bearer …` ou `x-cron-secret`. */
export function segredoInformado(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  return bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
}

function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual LANÇA com tamanhos diferentes; o tamanho do segredo não é segredo.
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Falha fechada: sem segredo configurado, ninguém entra. */
export function cronAutorizado(req: Request): boolean {
  const informado = segredoInformado(req);
  if (!informado) return false;
  return segredosDeCron().some((s) => iguais(informado, s));
}
