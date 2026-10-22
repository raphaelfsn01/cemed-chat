import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { destinoSeguro } from "@/lib/auth/safe-next";
import { BRAND_MARK_SRC, branding } from "@/lib/branding";

export const metadata = { title: "Entrar" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string; error?: string }>;
}) {
  const { next: nextBruto, reset, error } = await searchParams;
  // Só caminho local segue adiante: `next` vem da URL e é escolhido por quem montou o link.
  const next = nextBruto ? destinoSeguro(nextBruto) : undefined;
  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BRAND_MARK_SRC} alt="" className="mx-auto mb-3 h-12 w-12" />
        <h1 className="text-2xl font-semibold tracking-tight">Entrar</h1>
        <p className="text-sm text-muted-foreground">{branding().name}</p>
      </div>
      {reset === "success" && (
        <div
          className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm"
          role="status"
        >
          Senha redefinida com sucesso. Entre com a nova senha.
        </div>
      )}
      {error === "link_invalido" && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          Link inválido ou expirado. Peça um novo em Esqueci minha senha.
        </div>
      )}
      {error === "sem_acesso" && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          Este e-mail ainda não tem acesso ao sistema. Peça um convite ao responsável.
        </div>
      )}
      <LoginForm next={next} />
      <div className="space-y-2 text-center text-sm">
        <p>
          <Link
            href="/login/forgot"
            className="text-muted-foreground underline underline-offset-4 hover:text-foreground inline-block py-2 lg:py-0"
          >
            Esqueci minha senha
          </Link>
        </p>
        <p className="text-muted-foreground">
          Ainda não tem acesso? Peça um convite ao responsável pelo sistema.
        </p>
      </div>
    </div>
  );
}
