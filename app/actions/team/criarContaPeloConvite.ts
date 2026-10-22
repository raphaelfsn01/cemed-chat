"use server";
/**
 * Server Action: primeiro acesso de quem foi convidado e ainda não tem conta.
 *
 * Substitui o cadastro público (`/signup`), removido na auditoria de 2026-10-21
 * (C3): ele deixava qualquer pessoa da internet criar conta E organização no
 * banco da clínica. Conta nova agora só nasce de um convite válido:
 *
 *   1. Teto por IP e por e-mail do convite (a rota é pública).
 *   2. Token HMAC verificado (assinatura + validade de 24 h).
 *   3. Conta criada pelo service role com o e-mail DO TOKEN, já confirmado: o link
 *      assinado chegou a quem controla o e-mail (ou foi entregue pelo admin), e é
 *      essa a prova. Não depende do SMTP do Supabase, que hoje não entrega para a
 *      equipe (auditoria, M4).
 *   4. E-mail que já tem conta → recusa e manda fazer login (nunca troca a senha
 *      de uma conta existente).
 *   5. Membership pela regra única de `lib/team/aplicar-convite.ts`.
 *   6. Login com a senha recém-definida e redirect para o app.
 */
import { redirect } from "next/navigation";

import { audit } from "@/lib/audit";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { contaPeloConviteSchema } from "@/lib/auth/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { aplicarConvite } from "@/lib/team/aplicar-convite";

export type CriarContaPeloConviteResult = {
  ok: false;
  error:
    | "rate_limited"
    | "validation_error"
    | "invalid_or_expired"
    | "account_exists"
    | "invite_older_than_removal"
    | "internal_error";
  details?: Record<string, string[] | undefined>;
};

export async function criarContaPeloConvite(
  token: string,
  input: { password: string; password_confirm: string },
): Promise<CriarContaPeloConviteResult | void> {
  const payload = verifyInviteToken(token);

  // O teto vem antes de qualquer resposta que diferencie token válido de inválido.
  if (await authRateLimited("invite_account", payload?.email ?? null, AUTH_LIMITS.invite_account)) {
    return { ok: false, error: "rate_limited" };
  }
  if (!payload) return { ok: false, error: "invalid_or_expired" };

  const parsed = contaPeloConviteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_error", details: parsed.error.flatten().fieldErrors };
  }

  const email = payload.email.trim().toLowerCase();
  const admin = createAdminClient();
  const { data: criado, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: parsed.data.password,
    email_confirm: true,
  });

  if (createErr || !criado.user) {
    const jaExiste =
      createErr &&
      ((createErr as { code?: string }).code === "email_exists" ||
        /already (been )?registered|already exists/i.test(createErr.message));
    if (jaExiste) return { ok: false, error: "account_exists" };
    return { ok: false, error: "internal_error" };
  }

  const r = await aplicarConvite(admin, criado.user.id, payload);
  if (!r.ok) {
    // Conta sem membership não fica para trás: sem ela, o e-mail ficaria "já
    // registrado" e o próximo convite válido não conseguiria criar a conta.
    await admin.auth.admin.deleteUser(criado.user.id);
    return r.erro === "convite_anterior_a_remocao"
      ? { ok: false, error: "invite_older_than_removal" }
      : { ok: false, error: "internal_error" };
  }

  await audit({
    action: "member.account_created_from_invite",
    actorUserId: criado.user.id,
    organizationId: payload.organization_id,
    resourceType: "membership",
    metadata: { invite_id: payload.invite_id, role: payload.role },
  });

  const supabase = await createClient();
  const { error: loginErr } = await supabase.auth.signInWithPassword({
    email,
    password: parsed.data.password,
  });
  if (loginErr) redirect("/login");

  redirect("/app/inbox");
}
