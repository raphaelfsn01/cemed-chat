"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { CommandPalette } from "@/components/shell/CommandPalette";

export function SearchTrigger() {
  const [open, setOpen] = useState(false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  return (
    <>
      {/* No celular o texto some e o botão vira só a lupa: o `aria-label` dá o
          nome que o texto escondido levava junto. A altura de toque (36px; o
          `sm` tem 32) vale até `lg`, e não só até `md`: o tablet já mostra o
          texto, mas continua sendo dedo, não mouse. */}
      <Button
        variant="outline"
        size="sm"
        className="h-9 w-9 gap-2 px-0 text-muted-foreground md:w-auto md:px-3 lg:h-8"
        aria-label="Buscar telas"
        onClick={() => setOpen(true)}
      >
        <MagnifyingGlass size={14} aria-hidden />
        <span className="hidden md:inline">Buscar...</span>
        <kbd className="ml-2 hidden md:inline rounded border bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
