"use client";
import { useState, type ReactNode } from "react";
import { List } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * Hambúrguer + gaveta lateral com o menu, para telas abaixo de `lg` (1024px).
 *
 * Só existe abaixo de `lg` (`lg:hidden` no gatilho); acima disso o trilho fixo
 * do shell mostra o mesmo menu. O conteúdo vem por render prop porque quem
 * fecha a gaveta é o destino tocado — a navegação client-side do Next não
 * desmonta o shell, então sem o `fechar` a gaveta ficaria aberta por cima da
 * página nova.
 *
 * O gatilho tem 44px: é o alvo primário de toda tela no celular.
 */
export function MenuGaveta({ children }: { children: (fechar: () => void) => ReactNode }) {
  const [aberto, setAberto] = useState(false);
  return (
    <Sheet open={aberto} onOpenChange={setAberto}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2 h-11 w-11 shrink-0 lg:hidden"
          aria-label="Abrir menu"
        >
          <List size={22} aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="flex w-72 flex-col gap-0 bg-card p-0"
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        {children(() => setAberto(false))}
      </SheetContent>
    </Sheet>
  );
}
