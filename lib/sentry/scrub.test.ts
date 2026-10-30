import { describe, expect, it } from "vitest";

import { scrubMessage, scrubUrl, sentryScrubHooks } from "./scrub";

// Issue #100. O que estes testes travam: com `tracesSampleRate: 1` e sem
// `beforeSendTransaction`/`beforeSendSpan`/`beforeBreadcrumb`, a URL crua saía do
// servidor do self-hoster em 6 campos (transaction, request.url, url.full,
// http.url, url.path, http.target). As rotas de webhook por tenant têm CREDENCIAL
// no path, e na instalação padrão esse token é a credencial inteira da rota,
// porque a exigência de assinatura nasce desligada.

const TOKEN = "wht_9f3a1c8b2e4d6a0f";

describe("scrubUrl", () => {
  it("redige o token das rotas em que ele é credencial, inclusive canal novo", () => {
    for (const path of [
      `/api/v1/webhooks/in/${TOKEN}`,
      `/api/v1/webhooks/canal-qualquer/${TOKEN}`,
      `/team/accept-invite/${TOKEN}`,
    ]) {
      const out = scrubUrl(`https://crm.exemplo.com${path}`);
      expect(out).not.toContain(TOKEN);
      expect(out).toContain("[TOKEN]");
    }
  });

  it("NÃO redige os segmentos [id], que são UUID e servem pra depurar", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const out = scrubUrl(`https://crm.exemplo.com/api/v1/ai/agents/${uuid}/runs`);
    // Redigir tudo cegamente tornaria o Sentry inútil — o oposto do objetivo.
    expect(out).toContain(uuid);
  });

  it("apaga o VALOR da query preservando a CHAVE", () => {
    const out = scrubUrl("https://crm.exemplo.com/api/v1/leads?cursor=abc123&limit=50");
    expect(out).toContain("cursor=[REDACTED]");
    expect(out).toContain("limit=[REDACTED]");
    expect(out).not.toContain("abc123");
  });

  it("redige query CRUA, sem `?` na frente — é assim que vem em request.query_string", () => {
    // Regressão: a primeira versão exigia `?` ou `&` antes da chave, e a assinatura
    // sobrevivia neste campo. Só apareceu ao rodar o envelope inteiro.
    expect(scrubUrl("sig=ASSINATURA123&t=9")).toBe("sig=[REDACTED]&t=[REDACTED]");
  });

  it("não estraga texto que não é query", () => {
    expect(scrubUrl("GET https://crm.exemplo.com/api/v1/leads")).toBe(
      "GET https://crm.exemplo.com/api/v1/leads",
    );
  });

  it("pega o token mesmo com query junto", () => {
    const out = scrubUrl(`https://crm.exemplo.com/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("deadbeef");
  });
});

describe("scrubMessage", () => {
  it("substitui CPF, telefone e e-mail", () => {
    const out = scrubMessage("falha para 123.456.789-01, +55 11 98765-4321, joao@exemplo.com");
    expect(out).toContain("[CPF]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[EMAIL]");
    expect(out).not.toContain("123.456.789-01");
    expect(out).not.toContain("joao@exemplo.com");
  });
});

describe("sentryScrubHooks", () => {
  const urlComToken = `https://crm.exemplo.com/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`;

  it("limpa header sensível por padrão, inclusive de integração que ainda não existe", () => {
    const event = sentryScrubHooks.beforeSend({
      request: {
        url: urlComToken,
        headers: {
          authorization: "Bearer segredo",
          "x-canal-novo-api-key": "chave-de-integracao-futura",
          "x-algum-token": "outro-segredo",
          "content-type": "application/json",
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(event.request?.headers).not.toHaveProperty("authorization");
    // O ponto do padrão: header de integração nova já nasce coberto.
    expect(event.request?.headers).not.toHaveProperty("x-canal-novo-api-key");
    expect(event.request?.headers).not.toHaveProperty("x-algum-token");
    expect(event.request?.headers).toHaveProperty("content-type");
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("beforeSendTransaction limpa os atributos de trace — o canal que não tinha guarda", () => {
    const event = sentryScrubHooks.beforeSendTransaction({
      transaction: `GET /api/v1/webhooks/in/${TOKEN}`,
      request: { url: urlComToken },
      contexts: {
        trace: {
          data: {
            "url.full": urlComToken,
            "http.url": urlComToken,
            "url.path": `/api/v1/webhooks/in/${TOKEN}`,
            "http.target": `/api/v1/webhooks/in/${TOKEN}?sig=deadbeef`,
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // O teste que importa: o token não sobrevive em NENHUM campo do envelope.
    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(JSON.stringify(event)).not.toContain("deadbeef");
  });

  it("beforeSendSpan limpa description e data", () => {
    const span = sentryScrubHooks.beforeSendSpan({
      description: `GET ${urlComToken}`,
      data: { "url.full": urlComToken },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(JSON.stringify(span)).not.toContain(TOKEN);
  });

  it("beforeBreadcrumb limpa a URL — o README prometia isso sem mecanismo", () => {
    const crumb = sentryScrubHooks.beforeBreadcrumb({
      message: `fetch ${urlComToken}`,
      data: { url: urlComToken },
    });
    expect(JSON.stringify(crumb)).not.toContain(TOKEN);
  });
});

// A3 da auditoria: o Sentry fica fora do país e o CRM é clínico. O corpo da
// requisição é texto livre — nome, telefone, e-mail e mensagem de paciente — então
// a garantia é remoção do CAMPO, não redação por regex.
describe("sentryScrubHooks — dado de paciente", () => {
  const NOME = "Maria Aparecida dos Santos";
  const TELEFONE = "+55 22 99876-5432";
  const EMAIL = "maria.santos@exemplo.com";
  const MENSAGEM = "Bom dia, estou com dor no peito há três dias e queria remarcar a consulta";
  const IP = "203.0.113.42";
  const COOKIE = "sb-access-token=eyJhbGciOiJIUzI1NiJ9.segredo";
  const BEARER = "Bearer tok_segredo_do_servidor";
  const INTERNO = "segredo-interno-do-cron";

  function eventoDePaciente() {
    return {
      message: "falha ao gravar mensagem",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id')",
            stacktrace: { frames: [{ filename: "app/api/v1/messages/route.ts", lineno: 42 }] },
          },
        ],
      },
      request: {
        url: "https://crm.exemplo.com/api/v1/messages",
        method: "POST",
        query_string: `telefone=${encodeURIComponent(TELEFONE)}`,
        data: { contact_name: NOME, phone: TELEFONE, email: EMAIL, body: MENSAGEM },
        cookies: { "sb-access-token": "eyJhbGciOiJIUzI1NiJ9.segredo" },
        headers: {
          authorization: BEARER,
          cookie: COOKIE,
          "set-cookie": COOKIE,
          "x-internal-secret": INTERNO,
          "content-type": "application/json",
          "user-agent": "vitest",
        },
      },
      user: {
        id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        email: EMAIL,
        ip_address: IP,
        username: NOME,
      },
    };
  }

  const hooks = [
    ["beforeSend", sentryScrubHooks.beforeSend],
    ["beforeSendTransaction", sentryScrubHooks.beforeSendTransaction],
  ] as const;

  for (const [nome, hook] of hooks) {
    it(`${nome}: nenhum valor de paciente ou credencial sobra no evento`, () => {
      const serializado = JSON.stringify(hook(eventoDePaciente()));
      for (const valor of [NOME, TELEFONE, EMAIL, MENSAGEM, IP, COOKIE, BEARER, INTERNO]) {
        expect(serializado).not.toContain(valor);
      }
      // O telefone também não sobra codificado na query.
      expect(serializado).not.toContain(encodeURIComponent(TELEFONE));
    });

    it(`${nome}: remove os campos nomeados, e só eles`, () => {
      const evento = hook(eventoDePaciente());
      expect(evento.request).not.toHaveProperty("data");
      expect(evento.request).not.toHaveProperty("cookies");
      expect(evento.request).not.toHaveProperty("query_string");
      expect(evento.request?.headers).not.toHaveProperty("authorization");
      expect(evento.request?.headers).not.toHaveProperty("cookie");
      expect(evento.request?.headers).not.toHaveProperty("set-cookie");
      expect(evento.request?.headers).not.toHaveProperty("x-internal-secret");
      expect(evento.user).not.toHaveProperty("email");
      expect(evento.user).not.toHaveProperty("ip_address");
      expect(evento.user).not.toHaveProperty("username");
      // O que serve para depurar fica: rota, método, headers inofensivos e o id da conta.
      expect(evento.request?.url).toBe("https://crm.exemplo.com/api/v1/messages");
      expect(evento.request?.headers).toMatchObject({ "content-type": "application/json" });
      expect(evento.user).toMatchObject({ id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" });
    });
  }

  it("beforeSend: o erro (mensagem, tipo e stack) continua intacto", () => {
    const antes = eventoDePaciente();
    const stackAntes = JSON.stringify(antes.exception.values[0]!.stacktrace);
    const depois = sentryScrubHooks.beforeSend(antes);
    expect(depois.message).toBe("falha ao gravar mensagem");
    expect(depois.exception.values[0]!.type).toBe("TypeError");
    expect(depois.exception.values[0]!.value).toBe(
      "Cannot read properties of undefined (reading 'id')",
    );
    expect(JSON.stringify(depois.exception.values[0]!.stacktrace)).toBe(stackAntes);
  });

  it("não quebra em evento sem request nem user", () => {
    expect(sentryScrubHooks.beforeSend({ message: "só texto" })).toEqual({ message: "só texto" });
    expect(sentryScrubHooks.beforeSendTransaction({ transaction: "GET /health" })).toEqual({
      transaction: "GET /health",
    });
  });
});
