/**
 * Destino de `?next=` depois do login/código: só caminho DESTA aplicação.
 *
 * O parâmetro vem da URL, então é escolhido por quem montou o link. Antes, ele ia
 * direto para `redirect()`, e `/login?next=https://site-falso` levava a pessoa,
 * logo depois de um login legítimo com a marca da clínica, para fora do sistema
 * (redirect aberto; auditoria de 2026-10-21, M3).
 *
 * Aceita só caminho absoluto local: começa com uma `/` e não com `//` nem `/\`,
 * que o navegador lê como outro host. Qualquer outra coisa vira o destino padrão.
 */
export const DESTINO_PADRAO = "/app/inbox";

export function destinoSeguro(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length === 0) return DESTINO_PADRAO;
  if (!next.startsWith("/")) return DESTINO_PADRAO;
  if (next.startsWith("//") || next.startsWith("/\\")) return DESTINO_PADRAO;
  // Caractere de controle (tab, quebra de linha) some no parser do navegador e
  // pode transformar `/\t/site` em `//site`.
  if (/[\u0000-\u001f\u007f]/.test(next)) return DESTINO_PADRAO;
  try {
    const base = "https://destino.invalid";
    const url = new URL(next, base);
    if (url.origin !== base) return DESTINO_PADRAO;
    return url.pathname + url.search + url.hash;
  } catch {
    return DESTINO_PADRAO;
  }
}
