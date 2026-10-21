import { redirect } from "next/navigation";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { InboxLayout } from "@/components/inbox/InboxLayout";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Você não tem nenhuma organização ativa. Aceite um convite ou contate o admin.
      </div>
    );
  }
  // A conversa aberta (`?id=`) é lida pelo próprio InboxLayout via
  // `useSearchParams` — é a URL, e não uma prop, a fonte da verdade.
  return <InboxLayout />;
}
