"use client";

import { useTransition, useState } from "react";

import { Button } from "@/components/ui/button";
import { acceptInviteAction } from "@/app/actions/team/acceptInvite";

/**
 * Aceite de quem já está logado com o e-mail do convite. Antes era uma action
 * inline que descartava o resultado: um aceite recusado não dizia nada na tela.
 */
export function AceitarConviteForm({ token }: { token: string }) {
  const [isPending, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);

  const aceitar = () => {
    setErro(null);
    startTransition(async () => {
      const res = await acceptInviteAction(token);
      if (!res || res.ok) return;
      if (res.error === "invite_older_than_removal") {
        setErro("Este convite é anterior à sua remoção da equipe. Peça um novo ao responsável.");
      } else if (res.error === "invalid_or_expired") {
        setErro("Convite inválido ou expirado. Peça um novo ao responsável.");
      } else {
        setErro("Não foi possível aceitar agora. Tente novamente.");
      }
    });
  };

  return (
    <div className="mt-4 space-y-3">
      <Button type="button" size="touch" onClick={aceitar} disabled={isPending}>
        {isPending ? "Aceitando..." : "Aceitar convite"}
      </Button>
      {erro && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {erro}
        </div>
      )}
    </div>
  );
}
