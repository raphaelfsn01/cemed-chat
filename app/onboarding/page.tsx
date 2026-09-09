import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";

export const dynamic = "force-dynamic";

export default async function OnboardingIndex() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  const { state, onboardedAt } = await loadOnboardingState(activeOrg.orgId);
  if (onboardedAt) redirect("/app/inbox");

  if (!state.welcome) redirect("/onboarding/welcome");
  if (!state.whatsapp) redirect("/onboarding/connect-whatsapp");
  if (!state.ai) redirect("/onboarding/setup-ai");
  if (!state.team) redirect("/onboarding/invite-team");
  redirect("/onboarding/done");
}
