/**
 * A busca de mídia no WAHA só alcança ARQUIVO de mídia (auditoria de 2026-10-21, A8).
 *
 * Antes, o host era trocado pela base do WAHA, mas o caminho e a query da
 * `media_url` gravada iam inteiros para a API dele, com a `X-Api-Key` global. Quem
 * envia mensagem escolhe a `media_url`, então lia qualquer endpoint do WAHA — que é
 * compartilhado por todas as organizações.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";

const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));

beforeEach(() => {
  vi.stubEnv("WAHA_API_BASE_URL", "http://waha:3000");
  vi.stubEnv("WAHA_API_KEY", "chave");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchWahaMedia — só /api/files", () => {
  it.each([
    "http://qualquer/api/sessions",
    "http://qualquer/api/default/chats",
    "http://qualquer/api/files/../sessions",
    "http://qualquer/api/files/%2e%2e/sessions",
    "http://qualquer/api/files/x.jpg?session=outra",
    "http://qualquer/api/files/",
  ])("%s → recusado sem chamar o WAHA", async (url) => {
    await expect(fetchWahaMedia(url)).rejects.toThrow(/waha_media_path_not_allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["http://localhost:3000/api/files/abc.jpg", "http://x/api/files/default/true_55@c.us_3EB0.jpg"])(
    "%s → buscado na base do WAHA (probe positivo)",
    async (url) => {
      await fetchWahaMedia(url);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});
