/**
 * Capacidades de PRIVACIDADE — quem pediu para exportar ou apagar os próprios
 * dados, e qual o prazo.
 *
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4 para o contrato dos campos.
 */
import { declararTools } from "./tipos";

export const TOOLS_PRIVACIDADE = declararTools([
  {
    name: "crm_list_privacy_requests",
    category: "read",
    description:
      "Lista pedidos de privacidade (LGPD) da organização, com tipo, situação, chegada e prazo. " +
      "NÃO executa nada: é leitura.",
    rotulo: "Ver pedidos de privacidade",
    explicacao:
      "Mostra quem pediu para exportar ou apagar os próprios dados e qual o prazo, para o assistente parar de insistir com quem pediu para sair.",
    oQueToca: "Privacidade e dados do cliente",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },
]);
