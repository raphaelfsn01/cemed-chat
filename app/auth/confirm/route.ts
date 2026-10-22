import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

/**
 * GET /auth/confirm — troca o token do e-mail (token_hash) por uma sessão.
 *
 * É o destino único dos links de e-mail do GoTrue (templates customizados em
 * supabase/templates/): confirmação de signup E redefinição de senha.
 *
 * - type=recovery → sessão de recovery estabelecida; segue para /login/reset
 *                  onde o usuário define a senha nova.
 * - qualquer outro tipo (confirmação de e-mail) → entra SÓ quem já é membro de
 *                  alguma organização. Não existe mais cadastro público: esta
 *                  rota criava uma organização nova para todo e-mail confirmado,
 *                  e com o signup do GoTrue aberto qualquer pessoa da internet
 *                  ganhava um tenant no banco da clínica (auditoria de
 *                  2026-10-21, C3). Equipe nova entra pelo convite.
 *
 * Fluxo canônico do @supabase/ssr: verifyOtp grava os cookies de sessão via
 * cookies() do next/headers; o Next anexa os Set-Cookie ao redirect retornado.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const requestId = request.headers.get("x-request-id");

  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, url.origin));

  if (!tokenHash || !type) {
    return redirectTo("/login?error=link_invalido");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error || !data.user) {
    await audit({
      action: "auth.email_link_rejected",
      metadata: { type, reason: error?.message ?? "no_user" },
      requestId,
    });
    return redirectTo("/login?error=link_invalido");
  }

  if (type === "recovery") {
    return redirectTo("/login/reset");
  }

  // Membership de fonte confiável: o usuário vem do token já verificado pelo
  // GoTrue (nunca do body), e a leitura é por `user_id`.
  const admin = createAdminClient();
  const { data: membro, error: membroErr } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", data.user.id)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  if (membroErr || !membro) {
    await audit({
      action: "auth.email_confirmed_without_access",
      actorUserId: data.user.id,
      metadata: { type, reason: membroErr ? "membership_lookup_failed" : "no_membership" },
      requestId,
    });
    await supabase.auth.signOut();
    return redirectTo("/login?error=sem_acesso");
  }

  return redirectTo("/app/inbox");
}
