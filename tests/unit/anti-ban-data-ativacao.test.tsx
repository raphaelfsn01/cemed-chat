/**
 * Tela "Proteção de envio": a data de ativação do número.
 *
 * A coluna `channel_knobs.number_activated_at` é NOT NULL DEFAULT now(). Salvar qualquer
 * campo desta tela numa conexão sem configuração criava a linha com a data de HOJE, e o
 * número voltava a ser tratado como novo (20 mensagens/dia). Por isso a tela sempre envia
 * uma data, e a preenche de saída com o primeiro envio registrado do número.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import type { PacingKnobsItem } from "@/hooks/channels/usePacingKnobs";

const putMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), put: (...a: unknown[]) => putMock(...a) },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AntiBanSheet } from "@/components/connections/AntiBanSheet";

function item(over: Partial<PacingKnobsItem> = {}): PacingKnobsItem {
  return {
    channel_session: {
      id: "7308883b-ecf5-4323-b5cb-42733c8afd11",
      waha_session_name: "org_x",
      display_name: "Recepção",
      phone_number: null,
      status: "WORKING",
      daily_message_limit: null,
    },
    effective: PACING_DEFAULTS,
    overrides: null,
    defaults: PACING_DEFAULTS,
    bounds: { intervalMaxMs: 600_000, hourLastStart: 23, hourEnd: 24, daily_limit: { min: 1, max: 10_000 } },
    ativo_desde_sugerido: null,
    ...over,
  };
}

function monta(it: PacingKnobsItem) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntiBanSheet item={it} canWrite onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

const campo = () => screen.getByLabelText("Data em que o número começou a enviar") as HTMLInputElement;

afterEach(() => {
  cleanup();
  putMock.mockReset();
});

describe("data de ativação do número", () => {
  it("sem configuração: preenche com a data sugerida pelo servidor e mostra que não há teto de aquecimento", () => {
    monta(item({ ativo_desde_sugerido: "2026-09-09T13:05:00+00:00" }));
    expect(campo().value).toBe("2026-09-09");
    expect(screen.getByTestId("anti-ban-aquecimento").textContent).toMatch(/Número com \d+ dias: sem limite de aquecimento/);
  });

  it("com configuração: mostra a data gravada, não a do 1º envio", () => {
    monta(
      item({
        overrides: {
          throttle_ms: null,
          jitter_max_ms: null,
          window_start_hour: null,
          window_end_hour: null,
          allow_sunday: null,
          timezone: null,
          warmup_daily_caps: null,
          number_activated_at: "2026-10-01T00:00:00+00:00",
        },
        ativo_desde_sugerido: "2026-09-09T13:05:00+00:00",
      }),
    );
    expect(campo().value).toBe("2026-10-01");
  });

  it("salvar SEMPRE envia a data — nunca deixa o banco cair na data de hoje", async () => {
    putMock.mockResolvedValue({ data: {} });
    monta(item({ ativo_desde_sugerido: "2026-09-09T13:05:00+00:00" }));
    fireEvent.click(screen.getByTestId("anti-ban-save"));
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(putMock.mock.calls[0]![1]).toMatchObject({ number_activated_at: "2026-09-09" });
  });

  it("número sem envio nenhum: data de hoje e o aviso do teto de número novo", () => {
    monta(item());
    const hoje = new Date();
    const local = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;
    expect(campo().value).toBe(local);
    // 0 ou 1 dia conforme o fuso da máquina (data local lida como meia-noite UTC).
    expect(screen.getByTestId("anti-ban-aquecimento").textContent).toMatch(/^Número com [01] dias?: até 20 mensagens por dia enquanto aquece\.$/);
  });
});
