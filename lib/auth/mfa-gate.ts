/**
 * Regra do segundo fator: quem tem autenticador verificado só passa com sessão AAL2.
 *
 * O login com senha já grava a sessão (AAL1) ANTES de mandar o usuário para
 * `/login/mfa`. Sem esta checagem, digitar `/app/inbox` na barra pulava o código —
 * medido em produção em 2026-10-14: o admin entrou no sistema inteiro e a API
 * respondeu 200 sem o código ter sido digitado.
 *
 * `nextLevel === "aal2"` significa "tem fator verificado"; quem não tem fator
 * (atendentes, no uso normal) fica em aal1/aal1 e não é afetado.
 *
 * A mesma regra vale no banco, em `public.fn_mfa_satisfeito()` (migration 0122):
 * esta aqui protege as telas e a API; aquela protege o PostgREST, que qualquer um
 * alcança com a anon key e um token conseguido só com a senha.
 */
import type { AuthUser, Role } from "./types";

export interface NivelDeGarantia {
  currentLevel: string | null;
  nextLevel: string | null;
}

export function precisaSegundoFator(aal: NivelDeGarantia | null | undefined): boolean {
  return aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2";
}

/**
 * O papel exige autenticador e a pessoa ainda não cadastrou um.
 *
 * Antes (auditoria de 2026-10-21) a exigência era só VISUAL: o `/app` mostrava um
 * modal de cadastro por cima das páginas, que continuavam renderizando por trás,
 * e nenhuma rota de API conferia nada — admin sem TOTP usava a API inteira só com
 * a senha. Agora o `requireRole` devolve 403 `mfa_enrollment_required` e o layout
 * não renderiza a página até o cadastro. Mesma política de `requiresMfa`
 * (lib/auth/server.ts): platform admin e `admin` da organização.
 *
 * Só o `false` explícito barra: `loadAuthUser` sempre preenche `mfa_verificado`.
 */
export function precisaCadastrarMfa(user: AuthUser, role: Role | undefined): boolean {
  const papelExige = user.is_platform_admin || role === "admin";
  return papelExige && user.mfa_verificado === false;
}
