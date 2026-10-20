"use client";
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { PaperPlaneTilt } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { AttachmentPreviewDialog } from "@/components/inbox/composer/AttachmentPreviewDialog";
import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";
import { DraftReplyButton } from "@/components/inbox/composer/DraftReplyButton";
import { EmojiButton } from "@/components/inbox/composer/EmojiButton";
import { resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { useCreateNote } from "@/hooks/inbox/useCreateNote";
import { useMessageTemplates, type MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia } from "@/hooks/inbox/useUploadMedia";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import { cn } from "@/lib/utils";

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  conversationId: string;
  disabled?: boolean;
  /** Set true when contact is blocked / anonymized — explanation shown. */
  blockedReason?: string | null;
  /** Nome do contato da conversa, para interpolar {{nome}}/{{primeiro_nome}} do template escolhido. */
  contactName?: string | null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { conversationId, disabled, blockedReason, contactName },
  ref,
) {
  const [text, setText] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const createNote = useCreateNote();
  const templates = useMessageTemplates();
  const slash = resolveSlash(text);
  const menuOpen = mode === "reply" && slash.open && !menuDismissed;

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  const isDisabled =
    disabled || !!blockedReason || send.isPending || upload.isPending || createNote.isPending;

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function handleSubmit() {
    const body = text.trim();
    if (!body || isDisabled) return;
    if (mode === "note") {
      createNote.mutate(
        { conversation_id: conversationId, body },
        {
          onSuccess: () => {
            setText("");
            requestAnimationFrame(() => autoresize());
          },
        },
      );
      return;
    }
    send.mutate(
      { conversation_id: conversationId, body, type: "text" },
      {
        onSuccess: () => {
          setText("");
          requestAnimationFrame(() => autoresize());
        },
      },
    );
  }

  function applyTemplate(t: MessageTemplate) {
    const filled = interpolateTemplate(t.body, { name: contactName ?? null });
    setText(filled);
    setMenuDismissed(true);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = filled.length;
      autoresize();
    });
  }

  function applyDraft(draft: string) {
    // O rascunho é uma resposta COMPLETA sugerida — substitui o conteúdo, nunca
    // concatena (inserir no cursor grudaria dois textos completos, gerando uma
    // mensagem sem sentido). O vendedor edita/envia a partir daqui.
    setText(draft);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoresize();
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && menuOpen) {
      setMenuDismissed(true);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (menuOpen) return; // deixa o Enter pro menu; não envia /query como mensagem
      handleSubmit();
    }
  }

  if (blockedReason) {
    return (
      <div className="border-t border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
        {blockedReason}
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          // Fundo: no iPhone sem botão home, a barra de gestos cobre os últimos
          // ~34px; `env(safe-area-inset-bottom)` (com o `viewport-fit=cover` do
          // layout raiz) empurra o composer para cima dela. No desktop o env
          // vale 0 e sobra o `py-2` de sempre.
          "relative border-t border-border bg-background px-3 pt-2 pb-[max(var(--space-2),env(safe-area-inset-bottom))]",
          mode === "note" && "border-warning/40 bg-warning-bg",
        )}
      >
        <TemplateMenu
          open={menuOpen}
          query={slash.query}
          templates={templates.data ?? []}
          onPick={applyTemplate}
          onClose={() => setMenuDismissed(true)}
        />
        <div className="mb-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "inline-flex min-h-9 items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors lg:min-h-0",
              mode === "reply"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            Responder
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            className={cn(
              "inline-flex min-h-9 items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors lg:min-h-0",
              mode === "note"
                ? "bg-warning text-warning-fg"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            Nota interna
          </button>
          {/* As dicas saíram do placeholder: lá elas não cabiam (cortadas no
              celular e no desktop com a coluna do contato aberta) e faziam o
              campo crescer para várias linhas. Atalho de teclado só interessa
              a quem tem teclado; "só o time vê" interessa a todos. */}
          <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
            {mode === "note" ? (
              "Só o time vê"
            ) : (
              <span className="hidden lg:inline">Enter envia · Shift+Enter quebra linha</span>
            )}
          </span>
        </div>
        <div className="flex items-end gap-2">
          {mode === "reply" && <AttachMenu disabled={isDisabled} onPick={setPendingFile} />}
          {mode === "reply" && (
            <DraftReplyButton conversationId={conversationId} disabled={isDisabled} onDraft={applyDraft} />
          )}
          {/* Celular já tem emoji no teclado — e cada botão a menos é largura
              devolvida ao campo de texto. */}
          <EmojiButton
            className="hidden md:inline-flex"
            disabled={isDisabled}
            onPick={(emoji) => {
              const ta = taRef.current;
              if (!ta) {
                setText((t) => t + emoji);
                return;
              }
              const start = ta.selectionStart ?? text.length;
              const end = ta.selectionEnd ?? text.length;
              const next = text.slice(0, start) + emoji + text.slice(end);
              setText(next);
              requestAnimationFrame(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = start + emoji.length;
                autoresize();
              });
            }}
          />
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (!resolveSlash(e.target.value).open) setMenuDismissed(false);
              autoresize();
            }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={mode === "note" ? "Escreva uma nota interna…" : "Escreva uma mensagem…"}
            className={cn(
              "min-h-9 max-h-40 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
              // Vazio, o placeholder fica em UMA linha (com reticências): no
              // celular o campo tem ~170px e ele quebrava, cortado ao meio.
              // Ao digitar, a quebra de linha normal volta.
              "placeholder-shown:overflow-hidden placeholder-shown:text-ellipsis placeholder-shown:whitespace-nowrap",
            )}
            disabled={isDisabled}
            aria-label="Mensagem"
          />
          {text.trim() || mode === "note" ? (
            <Button
              type="button"
              size="icon"
              className="h-11 w-11 shrink-0 lg:h-9 lg:w-9"
              onClick={handleSubmit}
              disabled={isDisabled || !text.trim()}
              aria-label="Enviar"
            >
              <PaperPlaneTilt size={16} weight="fill" aria-hidden />
            </Button>
          ) : (
            <AudioRecorder conversationId={conversationId} disabled={isDisabled} />
          )}
        </div>
      </div>
      <AttachmentPreviewDialog
        file={pendingFile}
        sending={upload.isPending || send.isPending}
        onCancel={() => setPendingFile(null)}
        onSend={async (caption) => {
          if (!pendingFile) return;
          try {
            const uploaded = await upload.mutateAsync({ conversationId, file: pendingFile });
            send.mutate(
              {
                conversation_id: conversationId,
                type: uploaded.kind,
                body: caption || undefined,
                media_storage_path: uploaded.storage_path,
                media_mime: uploaded.media_mime,
                media_size_bytes: uploaded.media_size_bytes,
              },
              { onSuccess: () => setPendingFile(null) },
            );
          } catch {
            // toast já disparado pelo onError de useUploadMedia; dialog fica aberto p/ retry
            return;
          }
        }}
      />
    </>
  );
});
