/**
 * Papéis dentro do tenant.
 *
 * `ai_operator` é o papel do AGENTE PUBLICADO, e existe SÓ no escopo do token
 * efêmero — nunca em `user_organizations`. Nenhuma pessoa o recebe, e o CHECK
 * daquela tabela segue com os quatro papéis humanos de propósito: é isso que
 * garante que ninguém ganhe autonomia de máquina por acidente de configuração.
 *
 * Ele senta ENTRE `agent` e `manager` porque descreve exatamente a faixa que
 * faltava: capacidades que um atendente humano não tem (configurar a operação,
 * mexer na régua de retorno) mas que o agente precisa para cumprir o invariante
 * 4 da doutrina — nenhuma demanda sem próximo passo. Abrir essas capacidades
 * para `agent` daria a uma PESSOA um poder que o produto não lhe dá pela tela;
 * fechá-las em `manager` tira do agente o que ele existe para fazer.
 *
 * `fn_role_at_least` no banco NÃO conhece este papel, e está certo assim: ela
 * consulta `fn_user_role_in_org`, que lê `user_organizations`. O agente não é
 * usuário. A RLS segue intacta.
 */
export type Role = "viewer" | "agent" | "ai_operator" | "manager" | "admin";
export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  agent: 2,
  ai_operator: 3,
  manager: 4,
  admin: 5,
};

/** Papéis que uma PESSOA pode ter. Espelha `user_organizations_role_check`. */
export const PAPEIS_HUMANOS: ReadonlyArray<Role> = ["viewer", "agent", "manager", "admin"];

/**
 * Nome do papel em português leigo — a ÚNICA fonte de rótulo da interface
 * (convite, Equipe, transferência, admin, e-mail de convite). O valor gravado
 * no banco não muda; só o que a equipe lê. `ai_operator` nunca aparece em
 * seletor de time.
 */
export const ROTULO_DO_PAPEL: Record<Role, string> = {
  viewer: "Consulta",
  agent: "Atendente",
  ai_operator: "Operador de IA (técnico)",
  manager: "Gerente",
  admin: "Administrador",
};

/** Uma frase do que o papel pode fazer, mostrada ao escolher o papel. */
export const DESCRICAO_DO_PAPEL: Record<Role, string> = {
  viewer: "Só vê as conversas e os dados, não altera nada.",
  agent: "Responde pacientes e trabalha nos contatos e no funil.",
  ai_operator: "Papel do robô de atendimento publicado. Não é para pessoas.",
  manager: "Atendente + distribui o atendimento, configura o robô de atendimento, vê a auditoria.",
  admin: "Controle total (equipe, WhatsApp, LGPD, organização).",
};

/**
 * Rótulo de um papel que chegou como texto livre (token de convite, linha do
 * banco). Papel desconhecido aparece cru em vez de sumir.
 */
export function rotuloDoPapel(papel: string): string {
  return Object.hasOwn(ROTULO_DO_PAPEL, papel) ? ROTULO_DO_PAPEL[papel as Role] : papel;
}

/**
 * Escopo de visualização de conversas por atendente (G4-01, spec 13 §3.5).
 * Só restringe o role `agent`; viewer/manager/admin seguem org-wide.
 */
export type VisibilityMode = "all" | "own_and_unassigned" | "own";
export const DEFAULT_VISIBILITY_MODE: VisibilityMode = "own_and_unassigned"; // G1-06a

export interface UserOrgMembership {
  organization_id: string;
  organization_name: string;
  role: Role;
}

export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  is_platform_admin: boolean;
  organizations: UserOrgMembership[];
  /**
   * Tem fator TOTP verificado? Vem do `getUser()` (validado no GoTrue, não do
   * cookie). `loadAuthUser` sempre preenche; ausente só em dublê de teste — e
   * por isso o gate só barra o `false` explícito (`precisaCadastrarMfa`).
   */
  mfa_verificado?: boolean;
}

export interface ActiveOrg {
  orgId: string;
  name: string;
  role: Role;
  /**
   * Escopo de visualização da org (G4-01). Opcional: só é preenchido no client
   * context (AppLayout) para a UI do inbox decidir visões visíveis. Não é fonte
   * de autorização — a RLS (fn_can_view_conversation) é quem garante o escopo.
   */
  visibility_mode?: VisibilityMode;
}
