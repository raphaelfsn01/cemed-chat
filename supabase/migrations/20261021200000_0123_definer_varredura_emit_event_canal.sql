-- 0123 — RPCs expostas, emit_event sem dono e escrita de canal por qualquer membro
--
-- O QUÊ:
--   1. Varredura AUTO-CURATIVA de toda `security definer` de public: nenhuma fica
--      executável por anon/PUBLIC; as VOLÁTEIS só ficam com authenticated se
--      estiverem na lista de quem tem call site com a sessão do usuário (a mesma
--      de tests/invariants/hardening-definer-varredura.test.ts). Mais
--      `retrieve_top_k_chunks`, estável, que só o service role chama.
--   2. `emit_event` passa a recusar organização de quem chama não ser membro.
--   3. `channel_sessions`: a policy ALL de qualquer membro vira SELECT para
--      membro + escrita só para admin (as rotas que escrevem já exigem admin).
--
-- POR QUÊ (auditoria de 2026-10-21, lida no banco de produção):
--   1. Seis definer tinham EXECUTE para anon em produção, entre elas
--      `fn_lgpd_cascade_redact_contact` — anonimização IRREVERSÍVEL de paciente,
--      sem checar quem chama, alcançável com a anon key que vai para o browser.
--      O baseline já as nascia fechadas (por isso o CI ficava verde): a produção
--      recebeu as funções sob os default privileges do Supabase cloud, que dão
--      EXECUTE a anon e authenticated, e a 0108 revogou uma lista FIXA que não as
--      incluía. Por isso aqui é varredura, não lista: cura qualquer banco, venha
--      de onde vier o grant.
--   2. `emit_event` é chamada com a sessão do usuário e aceitava qualquer
--      `p_organization_id`: um logado gravava evento no bus de outra organização
--      (inclusive `lgpd.redact_received`).
--   3. Um `viewer` alterava ou apagava a linha do canal pelo PostgREST.
--
-- Idempotente: revoke de privilégio ausente é no-op; create or replace; drop
-- policy if exists antes de cada create policy.

-- ---- 1. varredura de security definer ----
do $varredura$
declare
  r record;
  v_auth boolean;
  -- Voláteis que authenticated PRECISA chamar (call site com sessão de usuário).
  permitidas constant text[] := array[
    'emit_event(text,text,uuid,jsonb,jsonb,uuid)',
    'fn_conversation_assign(uuid,uuid,uuid,text,uuid,boolean)',
    'fn_log_event(uuid,text,jsonb)'
  ];
begin
  for r in
    select p.oid,
           format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as alvo,
           p.proname || '(' || regexp_replace(oidvectortypes(p.proargtypes), '\s', '', 'g') || ')' as assinatura,
           p.provolatile
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
  loop
    -- Lido ANTES do revoke: o acesso de authenticated pode vir só de PUBLIC, e
    -- os helpers de RLS (estáveis) quebrariam toda leitura logada sem o regrant.
    v_auth := has_function_privilege('authenticated', r.oid, 'EXECUTE');

    execute format('revoke execute on function %s from public, anon', r.alvo);

    if r.provolatile = 'v' and not (r.assinatura = any (permitidas)) then
      execute format('revoke execute on function %s from authenticated', r.alvo);
    elsif v_auth then
      execute format('grant execute on function %s to authenticated', r.alvo);
    end if;

    execute format('grant execute on function %s to service_role', r.alvo);
  end loop;
end
$varredura$;

-- Estável, mas lê a base de conhecimento de QUALQUER org pelo argumento: só o
-- worker e o MCP (ambos service role) a chamam.
revoke execute on function public.retrieve_top_k_chunks(uuid, uuid, public.vector, integer, real)
  from authenticated;

-- ---- 2. emit_event confere quem chama ----
create or replace function public.emit_event(
  p_event_type text,
  p_entity_kind text,
  p_entity_id uuid,
  p_payload jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_organization_id uuid default null::uuid
) returns uuid
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_org_id uuid;
  v_event_id uuid;
begin
  v_org_id := p_organization_id;
  if v_org_id is null then
    -- Try to resolve from caller's first org (best-effort; trigger callers MUST pass it)
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  -- Com sessão de usuário (auth.uid() presente), só a própria organização.
  -- Service role, worker (conexão direta) e triggers de escrita do service role
  -- não têm uid e seguem como antes.
  if auth.uid() is not null
     and not (v_org_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()) then
    raise exception 'emit_event: organização fora do alcance de quem chama'
      using errcode = '42501';
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $$;

-- ---- 3. channel_sessions: leitura para membro, escrita para admin ----
drop policy if exists "channel_sessions_tenant_isolation_all" on public.channel_sessions;
drop policy if exists "channel_sessions_select" on public.channel_sessions;
drop policy if exists "channel_sessions_insert" on public.channel_sessions;
drop policy if exists "channel_sessions_update" on public.channel_sessions;
drop policy if exists "channel_sessions_delete" on public.channel_sessions;

create policy "channel_sessions_select" on public.channel_sessions
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "channel_sessions_insert" on public.channel_sessions
  for insert with check (
    public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin()
  );
create policy "channel_sessions_update" on public.channel_sessions
  for update using (
    public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin()
  ) with check (
    public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin()
  );
create policy "channel_sessions_delete" on public.channel_sessions
  for delete using (
    public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin()
  );

notify pgrst, 'reload schema';
