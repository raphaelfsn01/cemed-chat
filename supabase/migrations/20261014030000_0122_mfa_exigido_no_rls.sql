-- 0122 — MFA exigido no RLS
--
-- O QUÊ: quem tem fator MFA verificado só enxerga dados com sessão AAL2 (código
-- digitado). A regra entra em `fn_mfa_satisfeito()` e é chamada pelos três
-- helpers `security definer` por onde passam as policies tenant-aware:
-- `fn_user_org_ids()`, `fn_user_role_in_org(uuid)` e `fn_is_platform_admin()`.
--
-- POR QUÊ: medido em produção em 2026-10-14 — o login com senha grava uma
-- sessão AAL1 antes de pedir o código, e nada conferia o nível depois. O app
-- passou a barrar no proxy (lib/auth/mfa-gate.ts), mas com a senha qualquer um
-- pega um token AAL1 direto no Supabase Auth e consulta o PostgREST com a anon
-- key. Sem esta migration, o código de verificação não protegia dado nenhum.
--
-- Quem não tem fator verificado (atendentes, service_role, worker) não muda:
-- `fn_mfa_satisfeito()` devolve true para eles.
--
-- Idempotente: só `create or replace` + revoke/grant.

create or replace function public.fn_mfa_satisfeito() returns boolean
  language sql stable security definer
  set search_path = public
  as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors
        where user_id = auth.uid() and status = 'verified'
      );
$$;

create or replace function public.fn_user_org_ids() returns setof uuid
  language sql stable security definer
  set search_path = public
  as $$
  select organization_id from public.user_organizations
  where user_id = auth.uid() and revoked_at is null
    and public.fn_mfa_satisfeito();
$$;

create or replace function public.fn_user_role_in_org(p_org uuid) returns text
  language sql stable security definer
  set search_path = public
  as $$
  select role from public.user_organizations
  where user_id = auth.uid() and organization_id = p_org and revoked_at is null
    and public.fn_mfa_satisfeito()
  limit 1;
$$;

create or replace function public.fn_is_platform_admin() returns boolean
  language sql stable security definer
  set search_path = public
  as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and revoked_at is null
  ) and public.fn_mfa_satisfeito();
$$;

revoke execute on function public.fn_mfa_satisfeito() from public, anon;
grant  execute on function public.fn_mfa_satisfeito() to authenticated, service_role;
