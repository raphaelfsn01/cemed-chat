"use client";
import { lazy, Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Smiley } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

// Lazy: o picker (+dados) só carrega quando o usuário abre — zero peso no bundle do inbox.
const Picker = lazy(() => import("@emoji-mart/react"));

interface Props {
  disabled?: boolean;
  onPick: (emoji: string) => void;
  className?: string;
}

export function EmojiButton({ disabled, onPick, className }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn("h-9 w-9 shrink-0", className)}
          aria-label="Emoji"
          disabled={disabled}
        >
          <Smiley size={18} weight="regular" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto border-none p-0 shadow-lg">
        {open && (
          <Suspense fallback={<Skeleton className="h-[420px] w-[352px] max-w-[calc(100vw-2rem)]" />}>
            <EmojiPickerLazy onPick={onPick} />
          </Suspense>
        )}
      </PopoverContent>
    </Popover>
  );
}

function EmojiPickerLazy({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <Picker
      data={async () => (await import("@emoji-mart/data")).default}
      locale="pt"
      previewPosition="none"
      onEmojiSelect={(e: { native: string }) => onPick(e.native)}
    />
  );
}
