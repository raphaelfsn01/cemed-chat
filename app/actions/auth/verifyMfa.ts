"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { destinoSeguro } from "@/lib/auth/safe-next";
import {
  AUTH_LIMITS,
  authRateLimited,
  bloqueadoPorFalhas,
  registrarFalha,
} from "@/lib/auth/rate-limit";

export type VerifyMfaResult =
  | { ok: false; error: "mfa_invalid" }
  | { ok: false; error: "mfa_locked"; retry_in_seconds: number };

/**
 * Verifies a TOTP code against the user's verified factor and (on success)
 * elevates the session to AAL2.
 *
 * Teto de tentativas no SERVIDOR (auditoria de 2026-10-21, M15): 5 códigos
 * errados por conta em 15 min trancam a verificação, inclusive contra quem
 * distribui as tentativas por IPs; mais o teto por IP. Antes o contador morava
 * num cookie `mfa_attempts` — o cliente o apagava e tentava de novo, sem fim.
 */
export async function verifyMfa(code: string, next?: string): Promise<VerifyMfaResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Sanity-check: must have a verified TOTP factor.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const totp = factorsData?.totp?.find((f) => f.status === "verified");
  if (!totp) redirect("/app/inbox");

  // Lockout check: antes do provedor, para barrar a tentativa antes de acontecer.
  if (
    (await bloqueadoPorFalhas("mfa", user.id, AUTH_LIMITS.mfa)) ||
    (await authRateLimited("mfa", null, AUTH_LIMITS.mfa))
  ) {
    return { ok: false, error: "mfa_locked", retry_in_seconds: AUTH_LIMITS.mfa.windowSec };
  }

  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "mfa_invalid" };
  }

  // Issue challenge + verify.
  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: "mfa_invalid" };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code,
  });

  if (verifyErr) {
    await registrarFalha("mfa", user.id, AUTH_LIMITS.mfa);
    const locked = await bloqueadoPorFalhas("mfa", user.id, AUTH_LIMITS.mfa);
    await audit({
      action: "auth.mfa_failed",
      actorUserId: user.id,
      metadata: { locked },
      requestId,
      ip,
      userAgent,
    });
    if (locked) {
      return { ok: false, error: "mfa_locked", retry_in_seconds: AUTH_LIMITS.mfa.windowSec };
    }
    return { ok: false, error: "mfa_invalid" };
  }

  await audit({
    action: "auth.mfa_success",
    actorUserId: user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  redirect(destinoSeguro(next));
}
