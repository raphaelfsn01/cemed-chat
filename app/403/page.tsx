import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-8">
      <Card className="w-full max-w-md p-6 text-center sm:p-8">
        <h1 className="text-2xl font-semibold">403 — Sem permissão</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Você não tem acesso a essa área.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/">Voltar</Link>
          </Button>
          <Button asChild>
            <Link href="/app/inbox">Voltar pra Inbox</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}
