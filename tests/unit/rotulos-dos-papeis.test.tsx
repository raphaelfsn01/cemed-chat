/**
 * Papéis com nome leigo (PR 1 do plano do Coordenador).
 *
 * A equipe da clínica via `viewer/agent/manager/admin` crus no convite, na
 * Equipe e no e-mail de convite. O valor do banco não muda; o que a tela e o
 * e-mail mostram vem de `ROTULO_DO_PAPEL`/`DESCRICAO_DO_PAPEL`, fonte única.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { NextRequest } from "next/server";

import { SeletorDePapel } from "@/components/team/SeletorDePapel";
import {
  DESCRICAO_DO_PAPEL,
  PAPEIS_HUMANOS,
  ROTULO_DO_PAPEL,
  rotuloDoPapel,
  type Role,
} from "@/lib/auth/types";
import { ROLES } from "@/lib/schemas/team";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u-admin", email: "admin@clinica.test", full_name: "Dra. Ana" },
    org: { orgId: "org-1", name: "CEMED Saúde", role: "admin" },
  })),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://chat.clinica.test" },
}));
vi.mock("@/lib/auth/invite-token", () => ({
  signInviteToken: () => "token-de-teste-com-mais-de-vinte-caracteres",
  INVITE_TTL_SECONDS: 86400,
}));
const sendEmail = vi.fn(async (_msg: { text: string; html: string }) => ({ ok: true }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: (m: { text: string; html: string }) => sendEmail(m) }));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => vi.clearAllMocks());

describe("nome e frase de cada papel", () => {
  it("usa os nomes leigos combinados com a clínica", () => {
    expect(ROTULO_DO_PAPEL).toEqual({
      viewer: "Consulta",
      agent: "Atendente",
      coordinator: "Coordenador",
      ai_operator: "Operador de IA (técnico)",
      manager: "Gerente",
      admin: "Administrador",
    });
  });

  it("todo papel que uma pessoa pode ter tem frase explicativa", () => {
    for (const papel of PAPEIS_HUMANOS) {
      expect(DESCRICAO_DO_PAPEL[papel]?.trim(), papel).toBeTruthy();
    }
    expect(DESCRICAO_DO_PAPEL.viewer).toBe("Só vê as conversas e os dados, não altera nada.");
    expect(DESCRICAO_DO_PAPEL.agent).toBe("Responde pacientes e trabalha nos contatos e no funil.");
    expect(DESCRICAO_DO_PAPEL.coordinator).toBe("Atendente + distribui o atendimento.");
    expect(DESCRICAO_DO_PAPEL.manager).toBe("Coordenador + configura o robô de atendimento, vê a auditoria.");
    expect(DESCRICAO_DO_PAPEL.admin).toBe("Controle total (equipe, WhatsApp, LGPD, organização).");
  });

  it("todo papel oferecido no convite tem nome e frase", () => {
    for (const papel of ROLES) {
      expect(ROTULO_DO_PAPEL[papel], papel).not.toBe(papel);
      expect(DESCRICAO_DO_PAPEL[papel], papel).toBeTruthy();
    }
  });

  it("papel desconhecido (token antigo, linha estranha) aparece cru em vez de sumir", () => {
    expect(rotuloDoPapel("agent")).toBe("Atendente");
    expect(rotuloDoPapel("papel_que_nao_existe")).toBe("papel_que_nao_existe");
    expect(rotuloDoPapel("constructor")).toBe("constructor");
  });
});

function SeletorControlado() {
  const [papel, setPapel] = useState<(typeof ROLES)[number]>("agent");
  return <SeletorDePapel id="role" papeis={ROLES} value={papel} onChange={setPapel} mostrarDescricao />;
}

describe("SeletorDePapel", () => {
  it("mostra o nome no campo e a frase do papel escolhido abaixo dele", async () => {
    const user = userEvent.setup();
    render(<SeletorControlado />);

    const campo = screen.getByRole("combobox");
    expect(campo).toHaveTextContent("Atendente");
    expect(campo).not.toHaveTextContent("agent");
    expect(campo).toHaveAccessibleDescription(DESCRICAO_DO_PAPEL.agent);

    await user.click(campo);
    // Cada opção traz o nome e a frase do que o papel pode fazer.
    for (const papel of ROLES) {
      const opcao = await screen.findByRole("option", { name: new RegExp(`^${ROTULO_DO_PAPEL[papel]}`) });
      expect(opcao).toHaveTextContent(DESCRICAO_DO_PAPEL[papel]);
    }
    await user.click(screen.getByRole("option", { name: /^Consulta/ }));

    expect(campo).toHaveTextContent("Consulta");
    expect(campo).not.toHaveTextContent(DESCRICAO_DO_PAPEL.viewer);
    expect(campo).toHaveAccessibleDescription(DESCRICAO_DO_PAPEL.viewer);
  });
});

describe("e-mail de convite", () => {
  it.each<[Role, string]>([
    ["agent", "Atendente"],
    ["viewer", "Consulta"],
  ])("convite de %s diz que a pessoa entra como %s", async (role, rotulo) => {
    const { POST } = await import("@/app/api/v1/team/invite/route");
    const req = new NextRequest("https://chat.clinica.test/api/v1/team/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitations: [{ email: "nova@clinica.test", role }] }),
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const { text, html } = sendEmail.mock.calls[0]![0];
    expect(text).toContain(`como ${rotulo}.`);
    expect(html).toContain(`<strong>${rotulo}</strong>`);
    expect(text).not.toContain(`como ${role}.`);
  });
});
