/**
 * Shared helpers for onboarding Server Actions: resolve auth + active org +
 * admin client (we use service-role here because we do narrow targeted
 * UPDATEs scoped explicitly by `organization_id` resolved from the validated
 * session — no body-derived ids ever).
 */
import { precisaCadastrarMfa } from "@/lib/auth/mfa-gate";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OnboardingState } from "@/lib/schemas/onboarding";

export class OnboardingError extends Error {
  constructor(
    public readonly code:
      | "auth_required"
      | "no_active_org"
      | "forbidden"
      | "not_found"
      | "db_error",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface OnboardingCtx {
  userId: string;
  orgId: string;
  orgName: string;
  role: string;
  fullName: string | null;
  email: string;
}

/**
 * Contexto das actions de onboarding: SÓ admin da organização ativa.
 *
 * Antes (auditoria de 2026-10-21, C4) bastava estar logado: estas actions usam o
 * service role e fazem coisas de admin — convidar com qualquer papel (o link de
 * aceite volta na resposta quando não há e-mail configurado), renomear a org,
 * criar e publicar agente. Um `viewer` se convidava como admin e virava admin.
 *
 * Antes de concluir o onboarding basta ser admin: é o primeiro acesso do dono,
 * que ainda não cadastrou o autenticador (o cadastro é cobrado ao entrar no app).
 * Depois de concluído, vale o mesmo de qualquer ação de admin: com autenticador.
 */
export async function requireOnboardingCtx(): Promise<OnboardingCtx> {
  const user = await loadAuthUser();
  if (!user) throw new OnboardingError("auth_required", "Auth required.");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) throw new OnboardingError("no_active_org", "Sem organização ativa.");
  if (activeOrg.role !== "admin") {
    throw new OnboardingError("forbidden", "Só o admin da organização configura o início.");
  }
  if (precisaCadastrarMfa(user, activeOrg.role)) {
    const { onboardedAt } = await loadOnboardingState(activeOrg.orgId);
    if (onboardedAt) {
      throw new OnboardingError("forbidden", "Cadastre o autenticador para continuar.");
    }
  }
  return {
    userId: user.id,
    orgId: activeOrg.orgId,
    orgName: activeOrg.name,
    role: activeOrg.role,
    fullName: user.full_name,
    email: user.email,
  };
}

export async function loadOnboardingState(orgId: string): Promise<{
  state: OnboardingState;
  onboardedAt: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("onboarding_state, onboarded_at")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new OnboardingError("db_error", error.message);
  if (!data) throw new OnboardingError("not_found", "Organização não encontrada.");
  return {
    state: (data.onboarding_state as OnboardingState | null) ?? {},
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

export async function patchOnboardingState(
  orgId: string,
  patch: Partial<OnboardingState>,
  extra?: { display_name?: string; timezone?: string },
): Promise<void> {
  const admin = createAdminClient();
  const { state } = await loadOnboardingState(orgId);
  const merged: OnboardingState = { ...state, ...patch };
  const update: Record<string, unknown> = { onboarding_state: merged };
  if (extra?.display_name) update.display_name = extra.display_name;
  if (extra?.timezone) update.timezone = extra.timezone;
  const { error } = await admin.from("organizations").update(update).eq("id", orgId);
  if (error) throw new OnboardingError("db_error", error.message);
}
