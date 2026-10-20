"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, ArrowRight, ArrowLeft, DotsThree } from "@/lib/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { DURATIONS, SnoozeButton, isSnoozeActive } from "@/components/inbox/SnoozeButton";
import { useSnoozeConversation } from "@/hooks/inbox/useSnoozeConversation";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

interface Props {
  conversation: ConversationWithContact;
  /** "← Conversas" do celular, onde a lista e a conversa não cabem juntas. */
  onVoltar?: () => void;
  /** Abre os dados do contato, que abaixo de `xl` não têm coluna própria. */
  onDetalhes?: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  open: "Aberta",
  // É EXATAMENTE o estado em que a passagem para humano deixa a conversa
  // (`performHumanHandoff`: 'ai_handling' → 'pending'), e o rótulo faltava — toda
  // conversa escalada mostrava `pending` cru no rosto do atendente. O
  // `conversationStatusSchema` não lista 'pending' porque valida ENTRADA da API;
  // quem escreve este estado é o motor, e a tela precisa saber lê-lo.
  pending: "Aguardando atendente",
  claimed: "Em atendimento",
  ai_handling: "IA atendendo",
  closed: "Fechada",
  archived: "Arquivada",
};

export function ConversationHeader({ conversation, onVoltar, onDetalhes }: Props) {
  const { user } = useAuth();
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  const close = useCloseConversation();
  const retomar = useResumeAiAttendance();
  const { snooze, cancel: cancelarLembrete } = useSnoozeConversation();
  const [reassignOpen, setReassignOpen] = useState(false);

  const c = conversation.contacts ?? null;
  const displayName = c?.display_name?.trim() || c?.name?.trim() || c?.phone_number || "Sem nome";
  const phone = c?.phone_number ?? null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  /**
   * A conversa saiu do atendimento automático? As DUAS travas contam: o silêncio
   * na conversa e o `force_human` no contato. Olhar só o silêncio deixaria de
   * oferecer a volta justamente no caso em que ela mais falta — o contato travado
   * com a conversa já liberada, em que nenhum envio automático sai e nada na tela
   * explica por quê.
   */
  const silenciada =
    conversation.bot_silenced_until !== null && conversation.bot_silenced_until !== undefined;
  const emAtendimentoHumano =
    (silenciada || c?.force_human === true) && status !== "closed" && status !== "archived";
  const ativa = status !== "closed" && status !== "archived";
  const lembreteAtivo = isSnoozeActive(conversation.snooze_until ?? null);
  const fechar = () => {
    if (confirm("Fechar esta conversa?")) {
      close.mutate({ conversation_id: conversation.id });
    }
  };

  return (
    // Abaixo de `lg` a linha de sete botões não cabe (no tablet, a coluna da
    // conversa tem ~450px; no celular, ~360). Ali ficam: voltar, a ação
    // primária (Assumir/Liberar, 44px) e o "⋯" com o resto. A partir de `lg`,
    // a linha de sempre.
    //
    // A partir de `lg`, se as ações não cabem ao lado do nome (com o painel do
    // contato aberto, a coluna da conversa tem ~530px em 1440), elas descem
    // para a linha de baixo em vez de alargar a coluna.
    <div className="flex items-center justify-between gap-2 border-b border-border bg-background px-2 py-2 md:gap-3 md:px-4 md:py-3 lg:flex-wrap">
      {onVoltar && (
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0 md:hidden"
          onClick={onVoltar}
          aria-label="Voltar para as conversas"
        >
          <ArrowLeft size={20} aria-hidden />
        </Button>
      )}
      <div className="min-w-0 flex-1 lg:basis-40">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{displayName}</h2>
          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
            {STATUS_LABEL[status] ?? status}
          </Badge>
          {/* Sem esta marca, a conversa em que o robô está calado tem exatamente
              a mesma cara de uma conversa normal — e ninguém entende por que as
              respostas automáticas pararam. */}
          {emAtendimentoHumano && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]" data-testid="badge-atendimento-humano">
              Automático pausado
            </Badge>
          )}
        </div>
        {phone && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Phone size={11} weight="regular" aria-hidden /> {phone}
          </p>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5 lg:min-w-0 lg:shrink lg:flex-wrap lg:justify-end">
        {isOpen && (
          <Button
            size="sm"
            variant="default"
            className="h-11 lg:h-8"
            disabled={claim.isPending}
            onClick={() =>
              claim.mutate({
                conversation_id: conversation.id,
                expected_assignee: conversation.assigned_to_user_id,
              })
            }
          >
            Assumir
          </Button>
        )}
        {isMineAssigned && (
          <Button
            size="sm"
            variant="outline"
            className="h-11 lg:h-8"
            disabled={release.isPending}
            onClick={() => release.mutate({ conversation_id: conversation.id })}
          >
            Liberar
          </Button>
        )}
        <div className="hidden flex-wrap items-center justify-end gap-1.5 lg:flex">
          {/* A volta. Fica ANTES de transferir/fechar porque é a ação que a pessoa
              procura quando terminou o que tinha para fazer aqui. */}
          {emAtendimentoHumano && (
            <Button
              size="sm"
              variant="outline"
              disabled={retomar.isPending}
              data-testid="devolver-ao-automatico"
              onClick={() => retomar.mutate({ conversation_id: conversation.id })}
            >
              {retomar.isPending ? "Devolvendo..." : "Devolver ao automático"}
            </Button>
          )}
          {status !== "closed" && status !== "archived" && (
            <Button size="sm" variant="outline" onClick={() => setReassignOpen(true)}>
              Transferir
            </Button>
          )}
          {status !== "closed" && status !== "archived" && (
            <SnoozeButton
              conversationId={conversation.id}
              snoozeUntil={conversation.snooze_until ?? null}
            />
          )}
          {status !== "closed" && status !== "archived" && (
            <Button
              size="sm"
              variant="outline"
              disabled={close.isPending}
              onClick={fechar}
            >
              Fechar
            </Button>
          )}
          {c?.id && (
            <Button asChild size="sm" variant="ghost">
              <Link href={`/app/contacts/${c.id}`} className="flex items-center gap-1">
                Ver contato
                <ArrowRight size={12} weight="regular" aria-hidden />
              </Link>
            </Button>
          )}
          {/* Entre `lg` e `xl` a coluna do contato ainda não aparece. */}
          {onDetalhes && (
            <Button size="sm" variant="ghost" className="xl:hidden" onClick={onDetalhes}>
              Detalhes
            </Button>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 lg:hidden"
              aria-label="Mais ações da conversa"
            >
              <DotsThree size={22} weight="bold" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px] max-w-[calc(100vw-2rem)]">
            {onDetalhes && (
              <DropdownMenuItem className="min-h-10" onClick={onDetalhes}>
                Detalhes do contato
              </DropdownMenuItem>
            )}
            {c?.id && (
              <DropdownMenuItem asChild className="min-h-10">
                <Link href={`/app/contacts/${c.id}`}>Ver contato</Link>
              </DropdownMenuItem>
            )}
            {ativa && <DropdownMenuSeparator />}
            {emAtendimentoHumano && (
              <DropdownMenuItem
                className="min-h-10"
                disabled={retomar.isPending}
                onClick={() => retomar.mutate({ conversation_id: conversation.id })}
              >
                Devolver ao automático
              </DropdownMenuItem>
            )}
            {ativa && (
              <DropdownMenuItem className="min-h-10" onClick={() => setReassignOpen(true)}>
                Transferir
              </DropdownMenuItem>
            )}
            {ativa &&
              (lembreteAtivo ? (
                <DropdownMenuItem
                  className="min-h-10"
                  disabled={cancelarLembrete.isPending}
                  onClick={() => cancelarLembrete.mutate({ conversation_id: conversation.id })}
                >
                  Cancelar lembrete
                </DropdownMenuItem>
              ) : (
                DURATIONS.map((d) => (
                  <DropdownMenuItem
                    key={d.hours}
                    className="min-h-10"
                    disabled={snooze.isPending}
                    onClick={() =>
                      snooze.mutate({ conversation_id: conversation.id, duration_hours: d.hours })
                    }
                  >
                    Lembrar {d.label.toLowerCase()}
                  </DropdownMenuItem>
                ))
              ))}
            {ativa && (
              <DropdownMenuItem
                className="min-h-10 text-error"
                disabled={close.isPending}
                onClick={fechar}
              >
                Fechar conversa
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ReassignDialog
        conversationId={conversation.id}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
      />
    </div>
  );
}
