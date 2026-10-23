/**
 * O rastreador de `send_message` em andamento (human-handoff.ts): o handoff do mesmo passo
 * espera por ele antes de gravar force_human. Aqui, o contrato isolado — a prova de ponta a
 * ponta é tests/invariants/handoff-envio-corrida.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  criarEnviosEmAndamento,
  ESPERA_MAXIMA_DO_ENVIO_MS,
} from "@/lib/agent-engine/agent/human-handoff";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("criarEnviosEmAndamento", () => {
  it("sem envio em andamento: resolve na hora, sem armar timer", async () => {
    const envios = criarEnviosEmAndamento();
    await expect(envios.aguardar(ESPERA_MAXIMA_DO_ENVIO_MS)).resolves.toBe("sem_envio");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("espera o envio terminar e desarma o timer", async () => {
    const envios = criarEnviosEmAndamento();
    const fim = envios.iniciar();
    const espera = envios.aguardar(ESPERA_MAXIMA_DO_ENVIO_MS);
    let resolveu = false;
    void espera.then(() => {
      resolveu = true;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolveu).toBe(false);
    fim();
    await expect(espera).resolves.toBe("concluido");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("espera TODOS os envios, não só o primeiro", async () => {
    const envios = criarEnviosEmAndamento();
    const fim1 = envios.iniciar();
    const fim2 = envios.iniciar();
    const espera = envios.aguardar(ESPERA_MAXIMA_DO_ENVIO_MS);
    let resolveu = false;
    void espera.then(() => {
      resolveu = true;
    });
    fim1();
    await vi.advanceTimersByTimeAsync(100);
    expect(resolveu).toBe(false);
    fim2();
    await expect(espera).resolves.toBe("concluido");
  });

  it("envio que trava: segue no tempo máximo, e nunca antes", async () => {
    const envios = criarEnviosEmAndamento();
    envios.iniciar();
    const espera = envios.aguardar(ESPERA_MAXIMA_DO_ENVIO_MS);
    let resolveu = false;
    void espera.then(() => {
      resolveu = true;
    });
    await vi.advanceTimersByTimeAsync(ESPERA_MAXIMA_DO_ENVIO_MS - 1);
    expect(resolveu).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(espera).resolves.toBe("tempo_esgotado");
  });

  it("o `fim` é idempotente e um envio já terminado não é esperado", async () => {
    const envios = criarEnviosEmAndamento();
    const fim = envios.iniciar();
    fim();
    fim();
    await expect(envios.aguardar(ESPERA_MAXIMA_DO_ENVIO_MS)).resolves.toBe("sem_envio");
  });

  it("o teto é o que o desenho decidiu: 10 s", () => {
    expect(ESPERA_MAXIMA_DO_ENVIO_MS).toBe(10_000);
  });
});
