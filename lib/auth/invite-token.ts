/**
 * Stateless HMAC-SHA256 invite token. Self-contained payload, signed and
 * base64url-encoded — no DB row required to issue. Verified at accept time.
 *
 * Format: `<body>.<sig>` where
 *   - body = base64url(JSON({invite_id, email, organization_id, role, exp, iat}))
 *   - sig  = base64url(HMAC_SHA256(secret, body))
 *
 * Segredo PRÓPRIO (auditoria de 2026-10-21, M5). Antes era
 * `INVITE_TOKEN_SECRET ?? INTERNAL_SECRET ?? "dev-fallback"`: sem a primeira, o
 * convite era assinado com o mesmo segredo que os crons recebem como Bearer — quem
 * lesse o env do `scheduler` emitia convite de admin para qualquer organização — e,
 * sem nenhuma das duas, com um literal que está no repositório público.
 *
 *   1. `INVITE_TOKEN_SECRET` (≥ 32 caracteres) — o caminho de produção.
 *   2. Sem ele, uma chave DERIVADA de `INTERNAL_SECRET` por HMAC com rótulo de
 *      domínio. Não é o segredo do cron em si (um Bearer vazado não assina convite
 *      direto), mas quem tem o `INTERNAL_SECRET` deriva a chave — por isso o boot
 *      avisa (lib/env.ts) e o kit gera `INVITE_TOKEN_SECRET` em toda instalação nova.
 *      Existe para não derrubar o convite de quem atualiza um clone antigo, cujo
 *      `.env` o `update.sh` não completa.
 *   3. Nenhum dos dois → lança. Nunca um valor conhecido.
 *
 * Verification uses `timingSafeEqual` to avoid timing oracles.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { PAPEIS_HUMANOS, type Role } from "@/lib/auth/types";

const ROTULO_DERIVACAO = "cemed-chat/invite-token/v1";

function segredo(): string {
  const proprio = process.env.INVITE_TOKEN_SECRET?.trim();
  if (proprio && proprio.length >= 32) return proprio;
  const interno = process.env.INTERNAL_SECRET?.trim();
  if (interno) return createHmac("sha256", interno).update(ROTULO_DERIVACAO).digest("hex");
  throw new Error("invite_token_secret_missing: defina INVITE_TOKEN_SECRET (openssl rand -hex 32)");
}

export interface InvitePayload {
  invite_id: string;
  email: string;
  organization_id: string;
  role: string;
  exp: number; // epoch seconds
  /** Emissão (epoch s). Ausente em token anterior a 2026-10: deriva de exp − TTL. */
  iat?: number;
}

export const INVITE_TTL_SECONDS = 60 * 60 * 24; // 24h

/** Quando o convite foi emitido — decide se ele é anterior a uma remoção. */
export function emitidoEm(payload: InvitePayload): number {
  return payload.iat ?? payload.exp - INVITE_TTL_SECONDS;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signInviteToken(payload: InvitePayload): string {
  const comEmissao: InvitePayload = { ...payload, iat: payload.iat ?? Math.floor(Date.now() / 1000) };
  const json = JSON.stringify(comEmissao);
  const body = b64url(Buffer.from(json, "utf8"));
  const sig = b64url(createHmac("sha256", segredo()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", segredo()).update(body).digest());
  if (sig.length !== expected.length) return null;

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: InvitePayload;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json) as InvitePayload;
  } catch {
    return null;
  }

  if (
    typeof payload.invite_id !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.organization_id !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.exp !== "number" ||
    (payload.iat !== undefined && typeof payload.iat !== "number")
  ) {
    return null;
  }

  // Convite é para PESSOA: papel fora de PAPEIS_HUMANOS (ex.: `ai_operator`, papel
  // de máquina) é recusado aqui, antes de qualquer escrita, em vez de depender só
  // do CHECK de user_organizations.role.
  if (!PAPEIS_HUMANOS.includes(payload.role as Role)) return null;

  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}
