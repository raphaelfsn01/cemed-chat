"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";

import { contaPeloConviteSchema, type ContaPeloConviteInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { criarContaPeloConvite } from "@/app/actions/team/criarContaPeloConvite";

/**
 * Primeiro acesso pelo convite: a pessoa define a senha e entra. O e-mail vem do
 * convite e aparece só para leitura — não é campo, para não haver como trocar.
 */
export function CriarContaPeloConviteForm({ token, email }: { token: string; email: string }) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ContaPeloConviteInput>({
    resolver: zodResolver(contaPeloConviteSchema),
    defaultValues: { password: "", password_confirm: "" },
  });

  const onSubmit = (values: ContaPeloConviteInput) => {
    setServerError(null);
    startTransition(async () => {
      // Sucesso redireciona no servidor; só a falha volta para cá.
      const res = await criarContaPeloConvite(token, values);
      if (!res) return;
      if (res.error === "account_exists") {
        setServerError("Este e-mail já tem conta. Use \"Fazer login\" acima.");
      } else if (res.error === "invalid_or_expired") {
        setServerError("Convite inválido ou expirado. Peça um novo ao responsável.");
      } else if (res.error === "invite_older_than_removal") {
        setServerError("Este convite é anterior à sua remoção da equipe. Peça um novo.");
      } else if (res.error === "rate_limited") {
        setServerError("Muitas tentativas. Aguarde alguns minutos.");
      } else if (res.error === "validation_error") {
        setServerError("Confira a senha e a confirmação.");
      } else {
        setServerError("Erro inesperado. Tente novamente.");
      }
    });
  };

  return (
    // `method="post"`: sem JS (antes da hidratação) o navegador envia o form
    // sozinho, e o padrão GET poria a senha na URL. Ver LoginForm.
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="convite-email">Email</Label>
        <Input id="convite-email" type="email" value={email} readOnly autoComplete="username" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Crie sua senha</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password ? true : undefined}
          {...register("password")}
        />
        {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password_confirm">Repita a senha</Label>
        <Input
          id="password_confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password_confirm ? true : undefined}
          {...register("password_confirm")}
        />
        {errors.password_confirm && (
          <p className="text-xs text-destructive">{errors.password_confirm.message}</p>
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
        {isPending ? "Criando acesso..." : "Criar senha e entrar"}
      </Button>
    </form>
  );
}
