import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function ServiceUnavailablePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-8">
      <Card className="w-full max-w-md p-6 text-center sm:p-8">
        <h1 className="text-2xl font-semibold">503 — Em manutenção</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Voltamos em alguns minutos.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/">Voltar</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}
