"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useAdminConversation } from "@/hooks/useAdminConversation";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { TenantBadge } from "@/components/admin/inbox/TenantBadge";
import { AdminSidePanel } from "./AdminSidePanel";
import { ArrowLeft, CircleNotch, Lock } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { Message } from "@/lib/types/messaging";

// ---------------------------------------------------------------------------
// Status badge color
// ---------------------------------------------------------------------------

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "secondary",
  open: "default",
  resolved: "outline",
  closed: "outline",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  conversationId: string;
}

export function AdminThreadClient({ conversationId }: Props) {
  const { data, isLoading, isError } = useAdminConversation(conversationId);
  const [detalhesAberto, setDetalhesAberto] = useState(false);

  // Messages come in desc order from API — reverse for chronological display
  const messages = useMemo<Message[]>(() => {
    const msgs = data?.messages ?? [];
    return [...msgs].reverse() as Message[];
  }, [data?.messages]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <CircleNotch size={24} className="animate-spin" aria-label="Carregando" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-destructive">
        Falha ao carregar conversa.
      </div>
    );
  }

  const { conversation, organization, contact } = data;
  const contactName = contact?.name?.trim() || contact?.phone_number || "Sem nome";
  const statusVariant = STATUS_VARIANT[conversation.status] ?? "outline";

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      {/* ── Thread area ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-2 py-2 md:gap-3 md:px-4 md:py-3">
          {/* Abaixo de `md` a lista some quando há conversa aberta: o caminho
              de volta tem de estar na tela. */}
          <Button asChild variant="ghost" size="icon" className="h-11 w-11 shrink-0 md:hidden">
            <Link href="/admin/inbox" aria-label="Voltar para as conversas">
              <ArrowLeft size={20} aria-hidden />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{contactName}</span>
              <Badge variant={statusVariant} className="h-5 px-2 text-[10px] capitalize">
                {conversation.status}
              </Badge>
            </div>
            {organization && (
              <div className="mt-0.5">
                <TenantBadge
                  name={organization.display_name}
                  slug={organization.slug}
                  size="sm"
                />
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 xl:hidden"
            onClick={() => setDetalhesAberto(true)}
          >
            Detalhes
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto py-2">
          {messages.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              Sem mensagens nesta conversa.
            </p>
          ) : (
            messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
          )}
        </div>

        {/* Composer — disabled (read-only) */}
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-4 py-3">
          <Lock size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground">
            Modo somente-leitura.{" "}
            <span className="font-medium">
              Use &ldquo;Impersonate&rdquo; (em breve, S-11.07) para responder.
            </span>
          </span>
        </div>
      </div>

      {/* ── Side panel: coluna a partir de `xl`, gaveta abaixo ── */}
      <AdminSidePanel data={data} className="hidden xl:flex" />
      <Sheet open={detalhesAberto} onOpenChange={setDetalhesAberto}>
        <SheetContent
          side="right"
          aria-describedby={undefined}
          className="w-full p-0 pt-12 sm:max-w-md xl:hidden"
        >
          <SheetTitle className="sr-only">Detalhes da conversa</SheetTitle>
          <AdminSidePanel data={data} className="w-full border-l-0" />
        </SheetContent>
      </Sheet>
    </div>
  );
}
