import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { BRAND_MARK_SRC, branding } from "@/lib/branding";

export const metadata = { title: "Entrar" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string; error?: string }>;
}) {
  const { next, reset, error } = await searchParams;
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
          Link inválido ou expirado. Peça um novo em Recuperar senha ou refaça o
          cadastro.
        </div>
      )}
      {error === "provisionamento" && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          Sua conta foi confirmada, mas houve um erro ao preparar seu ambiente.
          Tente entrar novamente em instantes.
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
          Não tem conta?{" "}
          <Link
            href="/signup"
            className="font-medium text-foreground underline underline-offset-4 inline-block py-2 lg:py-0"
          >
            Criar conta
          </Link>
        </p>
      </div>
    </div>
  );
}
