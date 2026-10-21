"use client";
import type { ReactNode } from "react";
import { useSelectedLayoutSegment } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Lista | conversa do inbox de plataforma.
 *
 * A partir de `md`, as duas lado a lado (lista de 360px), como sempre. Abaixo,
 * uma só: a lista no índice, a conversa em `/admin/inbox/[conversationId]`. A
 * troca é só CSS e sai do segmento de rota, que o servidor também conhece — o
 * painel certo já vem no HTML, sem flash.
 */
export function InboxColunas({ lista, children }: { lista: ReactNode; children: ReactNode }) {
  const conversaAberta = useSelectedLayoutSegment() !== null;
  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside
        className={cn(
          "h-full w-full shrink-0 flex-col border-border md:w-[360px] md:border-r",
          conversaAberta ? "hidden md:flex" : "flex",
        )}
      >
        {lista}
      </aside>
      <div className={cn("min-w-0 flex-1 overflow-hidden", conversaAberta ? "flex" : "hidden md:flex")}>
        {children}
      </div>
    </div>
  );
}
