import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { supportEmail } from "@/lib/branding";

export const metadata = {
  title: "Conta suspensa",
};

// O contato vem do .env (SUPPORT_EMAIL) em runtime; renderizada no build, a imagem
// pré-buildada mostraria para sempre o valor (vazio) do momento do build.
export const dynamic = "force-dynamic";

export default function AccountSuspendedPage() {
  const email = supportEmail();
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-8">
      <Card className="w-full max-w-md p-6 text-center sm:p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Conta suspensa</h1>
        <p className="text-sm text-muted-foreground">
          Sua conta está suspensa.{" "}
          {email ? (
            <>
              Entre em contato com{" "}
              <a
                href={`mailto:${email}`}
                className="underline underline-offset-4 hover:text-foreground transition-colors"
              >
                {email}
              </a>{" "}
              para mais informações.
            </>
          ) : (
            "Para mais informações, fale com o responsável pelo sistema."
          )}
        </p>
        <div className="pt-2">
          <Button asChild variant="outline">
            <Link href="/login">Sair</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}
