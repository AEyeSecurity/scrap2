begin;

create table if not exists public.owner_client_identities (
  id uuid primary key default gen_random_uuid(),
  owner_client_link_id uuid not null references public.owner_client_links(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  pagina text not null check (pagina in ('RdA', 'ASN')),
  username text not null check (username = lower(btrim(username)) and username <> ''),
  is_active boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_to timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_owner_client_identities_active_window check (
    (is_active = true and valid_to is null) or (is_active = false and valid_to is not null)
  )
);

drop trigger if exists trg_owner_client_identities_set_updated_at on public.owner_client_identities;
create trigger trg_owner_client_identities_set_updated_at
before update on public.owner_client_identities
for each row execute function public.set_updated_at();

create unique index if not exists uq_owner_client_identities_active_link
  on public.owner_client_identities (owner_client_link_id)
  where is_active = true;

create unique index if not exists uq_owner_client_identities_active_username
  on public.owner_client_identities (pagina, username)
  where is_active = true;

create index if not exists ix_owner_client_identities_owner_active
  on public.owner_client_identities (owner_id, is_active, updated_at desc);

create index if not exists ix_owner_client_identities_client
  on public.owner_client_identities (client_id);

alter table public.owner_client_identities enable row level security;

do $$
declare
  v_conflicts text;
begin
  select string_agg(format('%s/%s x%s', pagina, username, usage_count), ', ' order by pagina, username)
    into v_conflicts
  from (
    select c.pagina, c.username, count(*) as usage_count
    from public.owner_client_links l
    join public.clients c on c.id = l.client_id
    where l.status = 'assigned'
      and c.username is not null
    group by c.pagina, c.username
    having count(*) > 1
  ) conflicts;

  if v_conflicts is not null then
    raise exception using
      errcode = 'P0001',
      message = 'owner_client_identities backfill collision detected',
      detail = v_conflicts;
  end if;
end;
$$;

insert into public.owner_client_identities (
  owner_client_link_id,
  owner_id,
  client_id,
  pagina,
  username,
  is_active,
  valid_from,
  created_at,
  updated_at
)
select
  l.id,
  l.owner_id,
  l.client_id,
  c.pagina,
  c.username,
  true,
  coalesce(l.assigned_at, l.updated_at, l.created_at, now()),
  coalesce(l.created_at, now()),
  greatest(coalesce(l.updated_at, l.created_at, now()), coalesce(c.updated_at, c.created_at, now()))
from public.owner_client_links l
join public.clients c on c.id = l.client_id
where l.status = 'assigned'
  and c.username is not null
  and not exists (
    select 1
    from public.owner_client_identities i
    where i.owner_client_link_id = l.id
      and i.is_active = true
  );

alter table public.report_run_items
  add column if not exists identity_id uuid null references public.owner_client_identities(id) on delete cascade;

alter table public.report_daily_snapshots
  add column if not exists identity_id uuid null references public.owner_client_identities(id) on delete cascade;

update public.report_run_items ri
set identity_id = i.id
from public.owner_client_identities i
where ri.identity_id is null
  and i.owner_id = ri.owner_id
  and i.client_id = ri.client_id
  and i.pagina = 'ASN'
  and i.username = ri.username;

update public.report_daily_snapshots s
set identity_id = i.id
from public.owner_client_identities i
where s.identity_id is null
  and i.owner_id = s.owner_id
  and i.client_id = s.client_id
  and i.pagina = s.pagina
  and i.username = s.username;

do $$
begin
  if exists (
    select 1
    from public.report_run_items
    where identity_id is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'report_run_items backfill identity_id failed';
  end if;

  if exists (
    select 1
    from public.report_daily_snapshots
    where identity_id is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'report_daily_snapshots backfill identity_id failed';
  end if;
end;
$$;

create unique index if not exists uq_report_run_items_run_identity
  on public.report_run_items (run_id, identity_id);

create index if not exists ix_report_run_items_identity_id
  on public.report_run_items (identity_id);

alter table public.report_daily_snapshots
  drop constraint if exists uq_report_daily_snapshots_date_username;

alter table public.report_daily_snapshots
  add constraint uq_report_daily_snapshots_date_pagina_username unique (report_date, pagina, username);

create index if not exists ix_report_daily_snapshots_identity_id
  on public.report_daily_snapshots (identity_id);

alter table public.report_run_items
  alter column identity_id set not null;

alter table public.report_daily_snapshots
  alter column identity_id set not null;

update public.owner_client_links l
set status = case
      when exists (
        select 1
        from public.owner_client_identities i
        where i.owner_client_link_id = l.id
          and i.is_active = true
      ) then 'assigned'
      else 'pending'
    end,
    assigned_at = case
      when exists (
        select 1
        from public.owner_client_identities i
        where i.owner_client_link_id = l.id
          and i.is_active = true
      ) then coalesce(
        l.assigned_at,
        (
          select min(i.valid_from)
          from public.owner_client_identities i
          where i.owner_client_link_id = l.id
            and i.is_active = true
        )
      )
      else null
    end,
    updated_at = now();

create or replace function public.refresh_owner_client_link_status_v1(
  p_link_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_active_identity boolean;
  v_first_valid_from timestamptz;
begin
  if p_link_id is null then
    raise exception using
      errcode = '22023',
      message = 'link_id is required';
  end if;

  select exists (
           select 1
           from public.owner_client_identities i
           where i.owner_client_link_id = p_link_id
             and i.is_active = true
         ),
         (
           select min(i.valid_from)
           from public.owner_client_identities i
           where i.owner_client_link_id = p_link_id
             and i.is_active = true
         )
    into v_has_active_identity, v_first_valid_from;

  update public.owner_client_links
  set status = case when v_has_active_identity then 'assigned' else 'pending' end,
      assigned_at = case when v_has_active_identity then coalesce(assigned_at, v_first_valid_from, now()) else null end,
      updated_at = now(),
      last_seen_at = now()
  where id = p_link_id;
end;
$$;

create or replace function public.append_owner_client_event_v4(
  p_owner_id uuid,
  p_client_id uuid,
  p_alias_id uuid default null,
  p_actor_alias text default null,
  p_actor_phone text default null,
  p_event_type text default 'intake',
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_actor_alias text;
  v_actor_phone text;
begin
  if p_owner_id is null then
    raise exception using
      errcode = '22023',
      message = 'owner_id is required';
  end if;

  if p_client_id is null then
    raise exception using
      errcode = '22023',
      message = 'client_id is required';
  end if;

  v_actor_alias := nullif(btrim(coalesce(p_actor_alias, '')), '');
  if p_actor_phone is null or btrim(p_actor_phone) = '' then
    v_actor_phone := null;
  else
    v_actor_phone := public.normalize_phone_e164(p_actor_phone);
  end if;

  insert into public.owner_client_events (
    owner_id,
    client_id,
    alias_id,
    actor_alias,
    actor_phone,
    event_type,
    payload
  )
  values (
    p_owner_id,
    p_client_id,
    p_alias_id,
    v_actor_alias,
    v_actor_phone,
    p_event_type,
    coalesce(p_payload, '{}'::jsonb)
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

create or replace function public.assign_username_by_phone_v4(
  p_owner_key text,
  p_cliente_telefono text,
  p_username text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  previous_username text,
  current_username text,
  overwritten boolean,
  created_client boolean,
  created_link boolean,
  moved_from_phone text,
  deleted_old_phone boolean,
  owner_id uuid,
  client_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_owner_key text;
  v_pagina text;
  v_cliente_telefono text;
  v_target_username text;
  v_alias_id uuid;
  v_target_client_id uuid;
  v_target_link_id uuid;
  v_target_identity_id uuid;
  v_existing_identity_id uuid;
  v_existing_link_id uuid;
  v_existing_owner_id uuid;
  v_existing_phone text;
  v_event_id uuid;
begin
  select r.owner_id, r.owner_key, r.pagina
    into v_owner_id, v_owner_key, v_pagina
  from public.resolve_owner_identity_v3(
    p_owner_key,
    coalesce(nullif(btrim(coalesce(p_owner_label, '')), ''), btrim(coalesce(p_owner_key, ''))),
    p_pagina
  ) as r
  limit 1;

  v_cliente_telefono := public.normalize_phone_e164(p_cliente_telefono);
  v_target_username := public.normalize_username(p_username, 'username');

  created_client := false;
  created_link := false;
  overwritten := false;
  moved_from_phone := null;
  deleted_old_phone := false;
  previous_username := null;
  current_username := null;

  select c.id
    into v_target_client_id
  from public.clients c
  where c.pagina = v_pagina
    and c.phone_e164 = v_cliente_telefono
  limit 1;

  if not found then
    insert into public.clients (pagina, phone_e164)
    values (v_pagina, v_cliente_telefono)
    returning id into v_target_client_id;

    created_client := true;
  else
    update public.clients
    set updated_at = now()
    where id = v_target_client_id;
  end if;

  select l.id
    into v_target_link_id
  from public.owner_client_links l
  where l.owner_id = v_owner_id
    and l.client_id = v_target_client_id
  limit 1;

  if not found then
    insert into public.owner_client_links (
      owner_id,
      client_id,
      status,
      first_seen_at,
      last_seen_at
    )
    values (
      v_owner_id,
      v_target_client_id,
      'pending',
      now(),
      now()
    )
    returning id into v_target_link_id;

    created_link := true;
  else
    update public.owner_client_links
    set last_seen_at = now(),
        updated_at = now()
    where id = v_target_link_id;
  end if;

  select i.id, i.owner_client_link_id, i.owner_id, c.phone_e164
    into v_existing_identity_id, v_existing_link_id, v_existing_owner_id, v_existing_phone
  from public.owner_client_identities i
  join public.clients c on c.id = i.client_id
  where i.pagina = v_pagina
    and i.username = v_target_username
    and i.is_active = true
  limit 1;

  if found then
    if v_existing_link_id = v_target_link_id then
      v_target_identity_id := v_existing_identity_id;
      current_username := v_target_username;
    elsif v_existing_owner_id <> v_owner_id then
      raise exception using
        errcode = 'P0001',
        message = 'username assigned to other owner';
    else
      moved_from_phone := v_existing_phone;

      update public.owner_client_identities
      set is_active = false,
          valid_to = now(),
          updated_at = now()
      where id = v_existing_identity_id;

      perform public.refresh_owner_client_link_status_v1(v_existing_link_id);
    end if;
  end if;

  select i.id, i.username
    into v_target_identity_id, previous_username
  from public.owner_client_identities i
  where i.owner_client_link_id = v_target_link_id
    and i.is_active = true
  limit 1;

  if found then
    if previous_username = v_target_username then
      current_username := v_target_username;
    else
      update public.owner_client_identities
      set is_active = false,
          valid_to = now(),
          updated_at = now()
      where id = v_target_identity_id;

      v_target_identity_id := null;
      overwritten := true;
      current_username := null;
    end if;
  end if;

  if v_target_identity_id is null then
    insert into public.owner_client_identities (
      owner_client_link_id,
      owner_id,
      client_id,
      pagina,
      username,
      is_active,
      valid_from
    )
    values (
      v_target_link_id,
      v_owner_id,
      v_target_client_id,
      v_pagina,
      v_target_username,
      true,
      now()
    )
    returning id into v_target_identity_id;

    current_username := v_target_username;
  end if;

  update public.owner_client_links
  set status = 'assigned',
      assigned_at = coalesce(assigned_at, now()),
      last_seen_at = now(),
      updated_at = now()
  where id = v_target_link_id;

  v_alias_id := public.touch_owner_alias_v3(v_owner_id, p_actor_alias, p_actor_phone);

  v_event_id := public.append_owner_client_event_v4(
    v_owner_id,
    v_target_client_id,
    v_alias_id,
    p_actor_alias,
    p_actor_phone,
    'assign_username',
    jsonb_build_object(
      'owner_key',
      v_owner_key,
      'username',
      current_username,
      'identity_id',
      v_target_identity_id,
      'overwritten',
      overwritten,
      'created_client',
      created_client,
      'created_link',
      created_link,
      'moved_from_phone',
      moved_from_phone,
      'deleted_old_phone',
      deleted_old_phone
    )
  );

  update public.owner_client_identities
  set updated_at = now()
  where id = v_target_identity_id;

  owner_id := v_owner_id;
  client_id := v_target_client_id;
  return next;
end;
$$;

create or replace function public.assign_pending_username_v3(
  p_owner_key text,
  p_cliente_telefono text,
  p_username text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  jugador_id uuid,
  username text,
  estado text,
  owner_id uuid,
  client_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assign record;
begin
  select *
    into v_assign
  from public.assign_username_by_phone_v4(
    p_owner_key,
    p_cliente_telefono,
    p_username,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone
  ) a
  limit 1;

  jugador_id := v_assign.client_id;
  username := v_assign.current_username;
  estado := 'assigned';
  owner_id := v_assign.owner_id;
  client_id := v_assign.client_id;
  return next;
end;
$$;

create or replace function public.sync_create_player_link_v3(
  p_owner_key text,
  p_username text,
  p_cliente_telefono text default null,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  owner_id uuid,
  client_id uuid,
  link_id uuid,
  estado text,
  previous_username text,
  current_username text,
  overwritten boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intake record;
  v_assign record;
begin
  if p_cliente_telefono is null or btrim(p_cliente_telefono) = '' then
    return;
  end if;

  select *
    into v_intake
  from public.intake_pending_cliente_v3(
    p_owner_key,
    p_cliente_telefono,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone
  ) i
  limit 1;

  select *
    into v_assign
  from public.assign_username_by_phone_v4(
    p_owner_key,
    p_cliente_telefono,
    p_username,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone
  ) a
  limit 1;

  owner_id := v_intake.owner_id;
  client_id := v_intake.client_id;
  link_id := v_intake.link_id;
  estado := 'assigned';
  previous_username := v_assign.previous_username;
  current_username := v_assign.current_username;
  overwritten := v_assign.overwritten;
  return next;
end;
$$;

create or replace function public.enqueue_report_run_items(
  p_run_id uuid,
  p_principal_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'run_id is required';
  end if;

  if nullif(lower(btrim(coalesce(p_principal_key, ''))), '') is null then
    raise exception using
      errcode = '22023',
      message = 'principal_key is required';
  end if;

  insert into public.report_run_items (
    run_id,
    owner_id,
    identity_id,
    client_id,
    link_id,
    username,
    owner_key,
    owner_label,
    status,
    max_attempts
  )
  select
    p_run_id,
    o.id,
    i.id,
    c.id,
    l.id,
    i.username,
    o.owner_key,
    o.owner_label,
    'pending',
    3
  from public.owners o
  join public.owner_client_links l on l.owner_id = o.id
  join public.clients c on c.id = l.client_id
  join public.owner_client_identities i
    on i.owner_client_link_id = l.id
   and i.is_active = true
  where o.pagina = 'ASN'
    and c.pagina = 'ASN'
    and l.status = 'assigned'
    and o.owner_key like lower(btrim(p_principal_key)) || ':%'
  on conflict (run_id, identity_id) do nothing;

  get diagnostics v_inserted = row_count;

  update public.report_runs
  set total_items = (
        select count(*)
        from public.report_run_items ri
        where ri.run_id = p_run_id
      )
  where id = p_run_id;

  if v_inserted = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'no report users found for principal';
  end if;

  return v_inserted;
end;
$$;

drop function if exists public.claim_next_report_run_item(integer, integer);

create function public.claim_next_report_run_item(
  p_lease_seconds integer default 60,
  p_max_attempts integer default 3
)
returns table (
  item_id uuid,
  run_id uuid,
  pagina text,
  principal_key text,
  report_date date,
  agente text,
  contrasena_agente text,
  owner_id uuid,
  identity_id uuid,
  client_id uuid,
  link_id uuid,
  username text,
  owner_key text,
  owner_label text,
  attempts integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
begin
  select
    ri.id,
    ri.run_id,
    rr.pagina,
    rr.principal_key,
    rr.report_date,
    rr.agente,
    rr.contrasena_agente,
    ri.owner_id,
    ri.identity_id,
    ri.client_id,
    ri.link_id,
    ri.username,
    ri.owner_key,
    ri.owner_label,
    ri.attempts + 1 as next_attempts,
    ri.max_attempts
  into v_item
  from public.report_run_items ri
  join public.report_runs rr on rr.id = ri.run_id
  where rr.status in ('queued', 'running')
    and ri.attempts < least(coalesce(p_max_attempts, 3), ri.max_attempts)
    and (
      ri.status = 'pending'
      or (ri.status = 'retry_wait' and coalesce(ri.next_retry_at, now()) <= now())
      or (ri.status = 'leased' and coalesce(ri.lease_until, now()) <= now())
    )
  order by
    case ri.status
      when 'leased' then 0
      when 'retry_wait' then 1
      else 2
    end,
    ri.created_at,
    ri.id
  limit 1
  for update of ri skip locked;

  if not found then
    return;
  end if;

  update public.report_run_items
  set status = 'leased',
      attempts = v_item.next_attempts,
      lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 60), 1)),
      next_retry_at = null,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = v_item.id;

  update public.report_runs
  set status = case when status = 'queued' then 'running' else status end,
      started_at = coalesce(started_at, now())
  where id = v_item.run_id;

  item_id := v_item.id;
  run_id := v_item.run_id;
  pagina := v_item.pagina;
  principal_key := v_item.principal_key;
  report_date := v_item.report_date;
  agente := v_item.agente;
  contrasena_agente := v_item.contrasena_agente;
  owner_id := v_item.owner_id;
  identity_id := v_item.identity_id;
  client_id := v_item.client_id;
  link_id := v_item.link_id;
  username := v_item.username;
  owner_key := v_item.owner_key;
  owner_label := v_item.owner_label;
  attempts := v_item.next_attempts;
  max_attempts := v_item.max_attempts;
  return next;
end;
$$;

revoke all on table public.owner_client_identities from public;
grant all on table public.owner_client_identities to service_role;

revoke all on function public.refresh_owner_client_link_status_v1(uuid) from public;
grant execute on function public.refresh_owner_client_link_status_v1(uuid) to service_role;

revoke all on function public.append_owner_client_event_v4(uuid, uuid, uuid, text, text, text, jsonb) from public;
grant execute on function public.append_owner_client_event_v4(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

revoke all on function public.assign_pending_username_v3(text, text, text, text, text, text, text) from public;
revoke all on function public.assign_username_by_phone_v4(text, text, text, text, text, text, text) from public;
revoke all on function public.sync_create_player_link_v3(text, text, text, text, text, text, text) from public;
revoke all on function public.enqueue_report_run_items(uuid, text) from public;
revoke all on function public.claim_next_report_run_item(integer, integer) from public;

grant execute on function public.assign_pending_username_v3(text, text, text, text, text, text, text) to service_role;
grant execute on function public.assign_username_by_phone_v4(text, text, text, text, text, text, text) to service_role;
grant execute on function public.sync_create_player_link_v3(text, text, text, text, text, text, text) to service_role;
grant execute on function public.enqueue_report_run_items(uuid, text) to service_role;
grant execute on function public.claim_next_report_run_item(integer, integer) to service_role;

drop index if exists public.uq_clients_pagina_username;
alter table public.clients drop column if exists username;

commit;
