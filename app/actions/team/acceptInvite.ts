"use server";
/**
 * Server Action: accept a team invite token (quem JÁ tem conta e está logado).
 *
 * Steps:
 *   1. Verify HMAC token (signature + expiry).
 *   2. Get current authenticated user from cookie session.
 *   3. Email mismatch → return error (UI tells user to sign out / use the right account).
 *   4. Aplica o convite pela regra única de `lib/team/aplicar-convite.ts`: membro
 *      ativo não muda de papel; removido só volta com convite emitido depois da
 *      remoção; quem não é membro entra com o papel do token.
 *   5. Redirect to /app/inbox.
 */
import { redirect } from "next/navigation";

import { verifyInviteToken } from "@/lib/auth/invite-token";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { aplicarConvite } from "@/lib/team/aplicar-convite";

export type AcceptInviteResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_or_expired"
        | "email_mismatch"
        | "not_authenticated"
        | "invite_older_than_removal"
        | "internal_error";
      message?: string;
      expectedEmail?: string;
    };

export async function acceptInviteAction(token: string): Promise<AcceptInviteResult> {
  const payload = verifyInviteToken(token);
  if (!payload) return { ok: false, error: "invalid_or_expired" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const userEmail = (user.email ?? "").trim().toLowerCase();
  const inviteEmail = payload.email.trim().toLowerCase();
  if (userEmail !== inviteEmail) {
    return { ok: false, error: "email_mismatch", expectedEmail: payload.email };
  }

  // Autorização: token HMAC verificado + email do usuário autenticado === email
  // do convite. Org e papel vêm do token assinado, nunca do body.
  const r = await aplicarConvite(createAdminClient(), user.id, payload);
  if (!r.ok) {
    return r.erro === "convite_anterior_a_remocao"
      ? { ok: false, error: "invite_older_than_removal" }
      : { ok: false, error: "internal_error", message: r.mensagem };
  }

  redirect("/app/inbox");
}
