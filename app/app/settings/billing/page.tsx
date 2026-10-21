import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportEmail } from "@/lib/branding";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  // spec 13 §4: billing é admin-only (viewer/agent/manager = none).
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const email = supportEmail();
  return (
    <div className="flex h-full flex-col gap-6 lg:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">Planos, faturas e cobrança.</p>
      </header>
      <Card className="max-w-xl p-6">
        <h2 className="text-sm font-semibold">Em breve — Fase 2</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Billing entra na Fase 2 do roadmap.{" "}
          {email ? (
            <>
              Para questões de pagamento, contate{" "}
              <a className="underline" href={`mailto:${email}`}>
                {email}
              </a>
              .
            </>
          ) : (
            "Para questões de pagamento, fale com o responsável pelo sistema."
          )}
        </p>
      </Card>
    </div>
  );
}
