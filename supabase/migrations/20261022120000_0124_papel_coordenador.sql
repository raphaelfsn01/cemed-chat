-- 0124 — papel `coordinator` (Coordenador), entre `agent` e `manager`.
--
-- O Coordenador é um Atendente que também distribui o atendimento: vê a fila de
-- todos (para redistribuir) e recebe conversas. Não configura o robô, os funis,
-- os webhooks nem a auditoria — tudo o que pede `manager` continua fora.
--
-- Papel de banco é TEXTO + CHECK (não enum), e cinco lugares listam os papéis à
-- mão. Todos mudam AQUI, na mesma migration, de propósito: se o CHECK aceitasse
-- `coordinator` antes de `fn_role_at_least` conhecê-lo, a função devolveria
-- `false` para ele em TODA a RLS e o Coordenador ficaria sem acesso a nada.
--
--   1. user_organizations_role_check   aceita 'coordinator'.
--   2. fn_role_at_least                viewer 1 < agent 2 < coordinator 3 < manager 4 < admin 5.
--      Os números são internos à função: toda policy compara por NOME, então
--      `fn_role_at_least(org,'agent')` passa a incluir o Coordenador e
--      `fn_role_at_least(org,'manager')` continua a excluí-lo.
--   3. fn_user_role_in                 mesmo mapeamento (manager 3→4, admin 4→5).
--      Nenhum código do app a chama; só o invariante gov-1-rbac.
--   4. fn_can_view_conversation /
--      fn_can_view_lead                o Coordenador entra na lista que vê a org
--      inteira, ignorando `visibility_mode` (decisão do produto: sem ver a fila
--      dos colegas ele não redistribui). Efeito derivado e intencional: a escrita
--      de crm_leads (`manager OR fn_can_view_lead`) passa a valer para todo lead.
--   5. fn_conversation_assign          o Coordenador pode ser DESTINO de conversa.
--
-- E duas policies que pediam `manager` para o que o Coordenador passa a fazer
-- (as rotas escrevem/leem com o client do usuário, então o gate da rota sozinho
-- não basta — o banco recusaria):
--   6. user_orgs_select (0044)         ler o roster da org: manager+ → coordinator+
--      (lista da Equipe, só leitura; escrita segue admin).
--   7. attendant_availability          mudar a disponibilidade de OUTRO atendente:
--      insert/update/delete (0039)     manager+ → coordinator+ (a própria segue livre).
--
-- O papel do agente publicado (`ai_operator`) segue fora do banco: ele só existe
-- no escopo do token efêmero, nunca em user_organizations.
--
-- Corpos de 4 e 5 são cópia exata da última definição (0035/0036 e o forward-fix
-- do G4-01), fora as listas. Idempotente: drop/add da constraint e create or
-- replace. A constraint só ALARGA, então nenhuma linha existente a viola e não
-- há backfill.

-- 1. CHECK ----------------------------------------------------------------
alter table public.user_organizations
  drop constraint if exists user_organizations_role_check;
alter table public.user_organizations
  add constraint user_organizations_role_check
  check (role in ('viewer', 'agent', 'coordinator', 'manager', 'admin'));

-- 2. fn_role_at_least ------------------------------------------------------
create or replace function public.fn_role_at_least(p_org uuid, p_min text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  with levels(role, lvl) as (
    values ('viewer',1),('agent',2),('coordinator',3),('manager',4),('admin',5)
  )
  select coalesce(
    (select user_lvl.lvl >= min_lvl.lvl
     from levels user_lvl
     join levels min_lvl on min_lvl.role = p_min
     where user_lvl.role = public.fn_user_role_in_org(p_org)),
    false
  );
$$;

revoke execute on function public.fn_role_at_least(uuid, text) from public, anon;
grant  execute on function public.fn_role_at_least(uuid, text) to authenticated, service_role;

-- 3. fn_user_role_in -------------------------------------------------------
create or replace function public.fn_user_role_in(p_org uuid)
returns integer
language sql stable security definer
set search_path = public
as $$
  select case public.fn_user_role_in_org(p_org)
    when 'viewer'      then 1
    when 'agent'       then 2
    when 'coordinator' then 3
    when 'manager'     then 4
    when 'admin'       then 5
    else 0
  end;
$$;

revoke execute on function public.fn_user_role_in(uuid) from public, anon;
grant  execute on function public.fn_user_role_in(uuid) to authenticated, service_role;

-- 4. visibilidade org-wide -------------------------------------------------
create or replace function public.fn_can_view_conversation(
  p_org uuid,
  p_assigned_to_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false
    when public.fn_user_role_in_org(p_org) in ('viewer','coordinator','manager','admin') then true
    when p_assigned_to_user_id = auth.uid() then true
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_assigned_to_user_id is null
         else false
       end
  end;
$$;

revoke execute on function public.fn_can_view_conversation(uuid, uuid) from public, anon;
grant  execute on function public.fn_can_view_conversation(uuid, uuid) to authenticated, service_role;

create or replace function public.fn_can_view_lead(
  p_org uuid,
  p_owner_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false
    when public.fn_user_role_in_org(p_org) in ('viewer','coordinator','manager','admin') then true
    when p_owner_user_id = auth.uid() then true
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_owner_user_id is null
         else false
       end
  end;
$$;

revoke execute on function public.fn_can_view_lead(uuid, uuid) from public, anon;
grant  execute on function public.fn_can_view_lead(uuid, uuid) to authenticated, service_role;

-- 5. fn_conversation_assign: Coordenador pode receber conversa -------------
create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','coordinator','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public, anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

-- 6. roster da org ---------------------------------------------------------
drop policy if exists "user_orgs_select" on public.user_organizations;
create policy "user_orgs_select" on public.user_organizations
  for select using (
    (user_id = auth.uid())
    or public.fn_role_at_least(organization_id, 'coordinator')
    or public.fn_is_platform_admin()
  );

-- 7. disponibilidade dos colegas --------------------------------------------
drop policy if exists "attendant_availability_insert" on public.attendant_availability;
create policy "attendant_availability_insert" on public.attendant_availability
  for insert with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'coordinator')))
  );

drop policy if exists "attendant_availability_update" on public.attendant_availability;
create policy "attendant_availability_update" on public.attendant_availability
  for update using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'coordinator')))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'coordinator')))
  );

drop policy if exists "attendant_availability_delete" on public.attendant_availability;
create policy "attendant_availability_delete" on public.attendant_availability
  for delete using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'coordinator')))
  );

notify pgrst, 'reload schema';
