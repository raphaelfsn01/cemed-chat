"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { useConversation, isNotFound } from "@/hooks/inbox/useConversation";
import { ConversationList } from "./ConversationList";
import { InboxFilters, type InboxFiltersValue, type InboxTab } from "./InboxFilters";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { RetentionNotice } from "./RetentionNotice";
import { CRMSidePanel } from "./CRMSidePanel";
import { InboxKeyboardShortcuts } from "./InboxKeyboardShortcuts";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

function tabToFilter(tab: InboxFiltersValue["tab"]): Partial<ConversationsFilters> {
  switch (tab) {
    case "unassigned":
      return { assigned_to: "unassigned", status: "open" };
    case "mine":
      return { assigned_to: "me" };
    case "closed":
      return { status: "closed" };
    case "ai":
      return { status: "ai_handling" };
    case "all":
    default:
      return {};
  }
}

const FILTER_TABS: InboxTab[] = ["unassigned", "mine", "all", "closed", "ai"];

/**
 * Lê ?filter= (G4-02, deep-link). ?filter=all é HONRADO mesmo para agent — a
 * lista volta RLS-scoped (a tab só some cosmeticamente); default: fila.
 */
function parseFilterParam(v: string | null): InboxTab {
  return v && FILTER_TABS.includes(v as InboxTab) ? (v as InboxTab) : "unassigned";
}

export function InboxLayout() {
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseFilterParam(searchParams.get("filter"));

  // tab vive na URL (?filter=); os demais filtros são estado local de sessão.
  const [aux, setAux] = useState<Omit<InboxFiltersValue, "tab">>({
    search: "",
    onlyUnread: false,
  });
  const filterValue: InboxFiltersValue = { tab, ...aux };
  const setFilterValue = useCallback(
    (next: InboxFiltersValue) => {
      if (next.tab !== tab) {
        const params = new URLSearchParams(searchParams);
        params.set("filter", next.tab);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }
      const { tab: _t, ...rest } = next;
      setAux(rest);
    },
    [tab, searchParams, router, pathname],
  );

  // A conversa aberta vive na URL (`?id=`), não em estado local. No celular a
  // lista e a conversa não cabem juntas — uma substitui a outra —, e o "voltar"
  // do aparelho tem de sair da conversa para a lista, não do inbox. Com estado
  // local, voltar levava para a tela anterior ao inbox inteiro.
  //
  // A troca é por `history.pushState`/`replaceState`, que o Next sincroniza com
  // `useSearchParams` SEM ida ao servidor (um `router.push` re-renderizaria a
  // página dinâmica a cada clique na lista). E como o servidor já renderiza
  // com o `?id=`, o painel certo nasce no HTML — não há flash de layout.
  const selectedId = searchParams.get("id");
  const veioDaLista = useRef(false);
  const irPara = useCallback(
    (id: string | null, modo: "push" | "replace") => {
      const params = new URLSearchParams(searchParams);
      if (id) params.set("id", id);
      else params.delete("id");
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (modo === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [searchParams, pathname],
  );
  const [detalhesAberto, setDetalhesAberto] = useState(false);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const composerRef = useRef<ComposerHandle | null>(null);

  const filters: ConversationsFilters = useMemo(
    () => ({
      ...tabToFilter(filterValue.tab),
      search: filterValue.search || undefined,
      channel_session_id: filterValue.channel_session_id,
      tag: filterValue.tag,
    }),
    [filterValue.tab, filterValue.search, filterValue.channel_session_id, filterValue.tag],
  );

  const clientFilter = useMemo(
    () =>
      filterValue.onlyUnread
        ? (c: ConversationWithContact) => (c.unread_count_for_assignee ?? 0) > 0
        : undefined,
    [filterValue.onlyUnread],
  );

  // We need the selected conversation object for header / composer / side panel.
  // Source it from the same query the list uses to avoid an extra request.
  const listQ = useConversationsRealtime(filters, orgId);
  const inList = useMemo(() => {
    const all = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    return all.find((c) => c.id === selectedId) ?? null;
  }, [listQ.data, selectedId]);

  // Deep-link para conversa fora do filtro atual (ou fora do escopo do agent):
  // busca única RLS-scoped. 404/vazio ⇒ inacessível ⇒ estado vazio claro (GAP D),
  // nunca stack trace. A RLS (G4-01) é quem garante o não-vazamento.
  const needsFetch = !!selectedId && !inList && !listQ.isLoading;
  const single = useConversation(selectedId, needsFetch);
  const selectedConversation: ConversationWithContact | null = inList ?? single.data ?? null;
  const selectionNotFound =
    needsFetch && !single.isPending && !single.data && isNotFound(single.error);

  const claim = useClaimConversation();
  const close = useCloseConversation();

  const handleSelect = useCallback(
    (id: string) => {
      if (id === selectedId) return;
      // Da lista para uma conversa: entrada NOVA no histórico, para o voltar do
      // celular voltar à lista. De uma conversa para outra (clique na lista no
      // desktop, atalho j/k): substitui — senão o voltar percorreria todas.
      if (selectedId) {
        irPara(id, "replace");
      } else {
        veioDaLista.current = true;
        irPara(id, "push");
      }
    },
    [selectedId, irPara],
  );
  // O "← Conversas" do celular. Se a conversa foi aberta pela lista, desfaz a
  // entrada que ela criou; se veio por link direto, não há para onde voltar
  // dentro do inbox, então só tira o `?id=`.
  const handleVoltar = useCallback(() => {
    if (veioDaLista.current) {
      veioDaLista.current = false;
      window.history.back();
    } else {
      irPara(null, "replace");
    }
  }, [irPara]);
  const abrirDetalhes = useCallback(() => setDetalhesAberto(true), []);
  const handleVisibleChange = useCallback((ids: string[]) => setVisibleIds(ids), []);
  const handleFocusReply = useCallback(() => composerRef.current?.focus(), []);
  const handleClaim = useCallback(() => {
    if (!selectedConversation) return;
    claim.mutate({
      conversation_id: selectedConversation.id,
      expected_assignee: selectedConversation.assigned_to_user_id,
    });
  }, [claim, selectedConversation]);
  const handleClose = useCallback(() => {
    if (!selectedConversation) return;
    close.mutate({ conversation_id: selectedConversation.id });
  }, [close, selectedConversation]);

  const blockedReason = selectedConversation?.contacts?.is_blocked
    ? "Contato bloqueado — envio de mensagens desabilitado."
    : selectedConversation?.contacts?.is_anonymized
      ? "Contato anonimizado — não é possível enviar mensagens."
      : null;

  // Altura da grade: a conta desconta TUDO que fica acima e abaixo dela.
  //   3.5rem            TopBar (`h-14`, em components/shell/TopBar.tsx)
  //   2 * --space-N     padding do <main> do AppShell, em cima e embaixo — `p-4`
  //                     abaixo de `lg` e `p-6` a partir dele; por isso a altura
  //                     tem as duas versões, cada uma com o seu token
  //
  // Com `100vh-3.5rem` o padding ficava de fora e a grade media 48px a MAIS que a
  // tela. Quem pagava a diferença era o composer, que fica no rodapé: nascia
  // parcialmente abaixo da borda, atrapalhando justo na hora de escrever.
  //
  // As duas parcelas NÃO estão na mesma unidade, e por isso o padding entra pelo
  // token e não como `3rem`: o `tailwind.config.ts` remapeia a escala de spacing
  // para `var(--space-N)` — `--space-6` é `24px` LITERAL (app/globals.css) —, mas
  // não remapeia o `14`, que segue sendo `3.5rem` de verdade. Escrever a soma como
  // `6.5rem` só acerta enquanto a raiz for 16px; com acessibilidade de fonte maior
  // ou menor o composer sai da tela de novo. Pelo token, a conta se auto-corrige
  // se a escala de espaçamento mudar.
  //
  // `dvh` em vez de `vh` porque no celular a `vh` ignora a barra do navegador — o
  // mesmo corte, só que pior e mudando conforme se rola a página.
  //
  // `minmax(0,1fr)`, não `1fr`: o `1fr` não encolhe abaixo do conteúdo, e o
  // cabeçalho da conversa (645px de botões) alargava a coluna — em 1440 o
  // painel do contato saía 89px da tela. Medido também na main: é anterior.
  //
  // Abaixo de `md` cabe UM painel: sem conversa aberta, a lista; com conversa, a
  // conversa. A troca é só CSS (`hidden md:flex`), decidida pelo `?id=` que o
  // servidor também enxerga.
  return (
    <div className="grid h-[calc(100dvh-3.5rem-2*var(--space-4))] w-full lg:h-[calc(100dvh-3.5rem-2*var(--space-6))] grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_320px]">
      <div
        className={cn(
          "h-full min-h-0 flex-col border-border md:border-r",
          selectedId ? "hidden md:flex" : "flex",
        )}
        data-painel="lista"
      >
        <InboxFilters value={filterValue} onChange={setFilterValue} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConversationList
            filters={filters}
            orgId={orgId}
            selectedId={selectedId}
            onSelect={handleSelect}
            clientFilter={clientFilter}
            onVisibleChange={handleVisibleChange}
          />
        </div>
      </div>

      <div
        className={cn("h-full min-h-0 flex-col", selectedId ? "flex" : "hidden md:flex")}
        data-painel="conversa"
      >
        {selectedConversation ? (
          <>
            <ConversationHeader
              conversation={selectedConversation}
              onVoltar={handleVoltar}
              onDetalhes={abrirDetalhes}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatThread conversationId={selectedConversation.id} />
            </div>
            <RetentionNotice conversationId={selectedConversation.id} />
            <Composer
              ref={composerRef}
              conversationId={selectedConversation.id}
              blockedReason={blockedReason}
              disabled={selectedConversation.status === "closed"}
              contactName={selectedConversation.contacts?.name ?? null}
            />
          </>
        ) : selectionNotFound ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            Conversa não encontrada ou fora do seu acesso.
            <Button variant="outline" size="touch" className="md:hidden" onClick={handleVoltar}>
              Voltar para as conversas
            </Button>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Selecione uma conversa
          </div>
        )}
      </div>

      <div className="hidden h-full min-h-0 xl:block">
        <CRMSidePanel conversation={selectedConversation} />
      </div>
      {/* Abaixo de `xl` a coluna do contato não cabe; antes ela simplesmente
          sumia, sem caminho para os dados do contato. Agora abre em gaveta
          pelo "Detalhes" do cabeçalho da conversa. */}
      <Sheet open={detalhesAberto} onOpenChange={setDetalhesAberto}>
        <SheetContent
          side="right"
          aria-describedby={undefined}
          className="w-full p-0 pt-12 sm:max-w-md xl:hidden"
        >
          <SheetTitle className="sr-only">Detalhes do contato</SheetTitle>
          <CRMSidePanel conversation={selectedConversation} />
        </SheetContent>
      </Sheet>

      <InboxKeyboardShortcuts
        visibleIds={visibleIds}
        selectedId={selectedId}
        onSelect={handleSelect}
        onFocusReply={handleFocusReply}
        onClaim={handleClaim}
        onClose={handleClose}
        onToggleHelp={() => setHelpOpen((v) => !v)}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
