"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";

import { destinoSeguro } from "@/lib/auth/safe-next";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithPassword } from "@/app/actions/auth/signInWithPassword";

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = (values: LoginInput) => {
    setServerError(null);
    startTransition(async () => {
      // Server Action redirects on success — no return value reaches here.
      // On failure, an error discriminator is returned and rendered inline.
      const res = await signInWithPassword(values, next);
      if (!res) {
        // Should be unreachable (redirect throws), but guard anyway.
        router.replace(destinoSeguro(next));
        return;
      }
      if (res.error === "mfa_required") {
        const params = new URLSearchParams();
        if (next) params.set("next", next);
        if (res.challengeId) params.set("factor", res.challengeId);
        router.replace(`/login/mfa${params.toString() ? `?${params}` : ""}`);
        return;
      }
      if (res.error === "invalid_credentials") {
        setServerError("Email ou senha incorretos.");
      } else if (res.error === "rate_limited") {
        setServerError("Muitas tentativas. Aguarde alguns minutos.");
      } else if (res.error === "validation_error") {
        setServerError("Dados inválidos. Confira os campos.");
      } else {
        setServerError("Erro inesperado. Tente novamente.");
      }
    });
  };

  return (
    // `method="post"` não é para o React — o envio de verdade é a server action
    // no onSubmit. É para o intervalo ANTES da hidratação: sem JS ainda, o
    // navegador envia o formulário sozinho, e o padrão é GET — com e-mail e
    // senha na URL (histórico do navegador, logs do proxy). No celular, onde a
    // hidratação demora, um toque rápido em "Entrar" bastava. Medido em
    // tests/e2e/auth-sem-credencial-na-url.spec.ts. Vale para todo <form> de auth.
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          aria-invalid={errors.email ? true : undefined}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{errors.email.message}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Senha</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? true : undefined}
          {...register("password")}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{errors.password.message}</p>
        )}
      </div>
      {serverError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {serverError}
        </div>
      )}
      <Button type="submit" size="touch" className="w-full" disabled={isPending}>
        {isPending ? "Entrando..." : "Entrar"}
      </Button>
    </form>
  );
}
