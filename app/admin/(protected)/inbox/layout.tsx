import type { ReactNode } from "react";
import { InboxList } from "./_components/InboxList";
import { InboxColunas } from "./_components/InboxColunas";

/**
 * 3-column layout: list (360px) | thread (flex) | side panel (320px, `xl`+).
 * Thread+side are rendered by child pages via `children`. Abaixo de `md`,
 * lista OU conversa — ver InboxColunas.
 */
export default function AdminInboxLayout({ children }: { children: ReactNode }) {
  return <InboxColunas lista={<InboxList />}>{children}</InboxColunas>;
}
