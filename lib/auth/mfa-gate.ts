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
export interface NivelDeGarantia {
  currentLevel: string | null;
  nextLevel: string | null;
}

export function precisaSegundoFator(aal: NivelDeGarantia | null | undefined): boolean {
  return aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2";
}
