begin;

create table if not exists public.owners (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('RdA', 'ASN')),
  owner_key text not null check (owner_key = lower(btrim(owner_key)) and owner_key <> ''),
  owner_label text not null check (owner_label = btrim(owner_label) and owner_label <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_owners_pagina_owner_key unique (pagina, owner_key)
);

drop trigger if exists trg_owners_set_updated_at on public.owners;
create trigger trg_owners_set_updated_at
before update on public.owners
for each row execute function public.set_updated_at();

create table if not exists public.owner_aliases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  alias text not null check (alias = btrim(alias) and alias <> ''),
  alias_phone text null check (alias_phone ~ '^\+[1-9][0-9]{7,14}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint uq_owner_aliases_owner_alias unique (owner_id, alias)
);

drop trigger if exists trg_owner_aliases_set_updated_at on public.owner_aliases;
create trigger trg_owner_aliases_set_updated_at
before update on public.owner_aliases
for each row execute function public.set_updated_at();

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('RdA', 'ASN')),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  username text null check (username is null or username = lower(btrim(username))),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_clients_pagina_phone unique (pagina, phone_e164)
);

create unique index if not exists uq_clients_pagina_username
  on public.clients (pagina, username)
  where username is not null;

drop trigger if exists trg_clients_set_updated_at on public.clients;
create trigger trg_clients_set_updated_at
before update on public.clients
for each row execute function public.set_updated_at();

create table if not exists public.owner_client_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  status text not null check (status in ('pending', 'assigned')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  assigned_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_owner_client_links_owner_client unique (owner_id, client_id)
);

drop trigger if exists trg_owner_client_links_set_updated_at on public.owner_client_links;
create trigger trg_owner_client_links_set_updated_at
before update on public.owner_client_links
for each row execute function public.set_updated_at();

create table if not exists public.owner_client_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  alias_id uuid null references public.owner_aliases(id) on delete set null,
  actor_alias text null,
  actor_phone text null check (actor_phone is null or actor_phone ~ '^\+[1-9][0-9]{7,14}$'),
  event_type text not null check (event_type in ('intake', 'link_sent', 'create_player', 'assign_username')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_owner_client_events_owner_created_at
  on public.owner_client_events (owner_id, created_at desc);
create index if not exists ix_owner_client_events_client_created_at
  on public.owner_client_events (client_id, created_at desc);
create index if not exists ix_owner_client_events_owner_client
  on public.owner_client_events (owner_id, client_id);

alter table public.owners enable row level security;
alter table public.owner_aliases enable row level security;
alter table public.clients enable row level security;
alter table public.owner_client_links enable row level security;
alter table public.owner_client_events enable row level security;

insert into public.owners (pagina, owner_key, owner_label, created_at, updated_at)
select
  co.pagina,
  lower(btrim(co.owner_key)),
  coalesce(nullif(btrim(co.owner_label), ''), lower(btrim(co.owner_key))),
  co.created_at,
  co.updated_at
from public.cajero_owners co
on conflict (pagina, owner_key) do update
set owner_label = coalesce(nullif(btrim(excluded.owner_label), ''), public.owners.owner_label),
    updated_at = greatest(public.owners.updated_at, excluded.updated_at);

insert into public.owners (pagina, owner_key, owner_label, created_at, updated_at)
select
  c.pagina,
  lower(btrim(c.username)),
  lower(btrim(c.username)),
  c.created_at,
  c.updated_at
from public.cajeros c
where not exists (
  select 1
  from public.owners o
  where o.pagina = c.pagina
    and o.owner_key = lower(btrim(c.username))
);

insert into public.owner_aliases (owner_id, alias, alias_phone, is_active, created_at, updated_at, last_seen_at)
select
  o.id,
  btrim(a.alias),
  a.alias_phone,
  a.is_active,
  a.created_at,
  a.updated_at,
  a.last_seen_at
from public.cajero_aliases a
join public.cajero_owners co on co.id = a.owner_id
join public.owners o
  on o.pagina = co.pagina
 and o.owner_key = lower(btrim(co.owner_key))
where nullif(btrim(a.alias), '') is not null
on conflict (owner_id, alias) do update
set alias_phone = coalesce(excluded.alias_phone, public.owner_aliases.alias_phone),
    is_active = excluded.is_active,
    updated_at = greatest(public.owner_aliases.updated_at, excluded.updated_at),
    last_seen_at = greatest(public.owner_aliases.last_seen_at, excluded.last_seen_at);

with legacy_clients as (
  select distinct on (cj.pagina, cj.telefono)
    cj.pagina,
    cj.telefono as phone_e164,
    case
      when j.username is null then null
      else lower(btrim(j.username))
    end as username,
    coalesce(cj.created_at, now()) as created_at,
    greatest(coalesce(cj.updated_at, cj.created_at, now()), coalesce(j.updated_at, j.created_at, now())) as updated_at
  from public.cajeros_jugadores cj
  left join public.jugadores j on j.id = cj.jugador_id
  where cj.telefono is not null
  order by
    cj.pagina,
    cj.telefono,
    greatest(coalesce(cj.updated_at, cj.created_at, now()), coalesce(j.updated_at, j.created_at, now())) desc,
    coalesce(cj.created_at, now()) desc
)
insert into public.clients (pagina, phone_e164, username, created_at, updated_at)
select
  lc.pagina,
  lc.phone_e164,
  lc.username,
  lc.created_at,
  lc.updated_at
from legacy_clients lc
on conflict (pagina, phone_e164) do update
set username = coalesce(excluded.username, public.clients.username),
    updated_at = greatest(public.clients.updated_at, excluded.updated_at);

insert into public.clients (pagina, phone_e164, username)
select
  e.pagina,
  e.cliente_telefono,
  null
from public.cliente_contact_events e
where not exists (
  select 1
  from public.clients c
  where c.pagina = e.pagina
    and c.phone_e164 = e.cliente_telefono
);

insert into public.owner_client_links (
  owner_id,
  client_id,
  status,
  first_seen_at,
  last_seen_at,
  assigned_at,
  created_at,
  updated_at
)
select
  o.id,
  cl.id,
  case when j.username is null then 'pending' else 'assigned' end,
  coalesce(cj.created_at, now()),
  coalesce(cj.updated_at, cj.created_at, now()),
  case when j.username is null then null else coalesce(j.updated_at, j.created_at, now()) end,
  coalesce(cj.created_at, now()),
  coalesce(cj.updated_at, cj.created_at, now())
from public.cajeros_jugadores cj
join public.cajeros c
  on c.id = cj.cajero_id
 and c.pagina = cj.pagina
join public.owners o
  on o.pagina = c.pagina
 and o.owner_key = lower(btrim(c.username))
join public.clients cl
  on cl.pagina = cj.pagina
 and cl.phone_e164 = cj.telefono
left join public.jugadores j on j.id = cj.jugador_id
where cj.telefono is not null
on conflict (owner_id, client_id) do update
set status = case
      when public.owner_client_links.status = 'assigned' or excluded.status = 'assigned' then 'assigned'
      else 'pending'
    end,
    first_seen_at = least(public.owner_client_links.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.owner_client_links.last_seen_at, excluded.last_seen_at),
    assigned_at = case
      when public.owner_client_links.assigned_at is not null then public.owner_client_links.assigned_at
      when excluded.assigned_at is not null then excluded.assigned_at
      else null
    end,
    updated_at = greatest(public.owner_client_links.updated_at, excluded.updated_at);

insert into public.owner_client_events (
  owner_id,
  client_id,
  alias_id,
  actor_alias,
  actor_phone,
  event_type,
  payload,
  created_at
)
select
  o.id,
  cl.id,
  (
    select oa.id
    from public.owner_aliases oa
    where oa.owner_id = o.id
      and oa.alias = nullif(btrim(coalesce(e.actor_alias, '')), '')
    order by oa.updated_at desc
    limit 1
  ),
  nullif(btrim(coalesce(e.actor_alias, '')), ''),
  e.actor_phone,
  e.event_type,
  e.payload,
  e.created_at
from public.cliente_contact_events e
join public.cajero_owners co on co.id = e.owner_id
join public.owners o
  on o.pagina = co.pagina
 and o.owner_key = lower(btrim(co.owner_key))
join public.clients cl
  on cl.pagina = e.pagina
 and cl.phone_e164 = e.cliente_telefono
where not exists (
  select 1
  from public.owner_client_events oce
  where oce.owner_id = o.id
    and oce.client_id = cl.id
    and oce.event_type = e.event_type
    and oce.created_at = e.created_at
    and oce.payload = e.payload
);

create or replace function public.resolve_owner_identity_v3(
  p_owner_key text,
  p_owner_label text,
  p_pagina text default 'ASN'
)
returns table (
  owner_id uuid,
  pagina text,
  owner_key text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_key text;
  v_owner_label text;
  v_pagina text;
begin
  v_owner_key := lower(btrim(coalesce(p_owner_key, '')));
  if v_owner_key = '' then
    raise exception using
      errcode = '22023',
      message = 'owner_key is required';
  end if;

  v_owner_label := btrim(coalesce(p_owner_label, ''));
  if v_owner_label = '' then
    v_owner_label := v_owner_key;
  end if;

  v_pagina := btrim(coalesce(p_pagina, 'ASN'));
  if v_pagina not in ('RdA', 'ASN') then
    raise exception using
      errcode = '22023',
      message = 'pagina must be RdA or ASN';
  end if;

  insert into public.owners (pagina, owner_key, owner_label)
  values (v_pagina, v_owner_key, v_owner_label)
  on conflict on constraint uq_owners_pagina_owner_key do update
  set owner_label = excluded.owner_label
  returning public.owners.id, public.owners.pagina, public.owners.owner_key
    into owner_id, pagina, owner_key;

  return next;
end;
$$;

create or replace function public.touch_owner_alias_v3(
  p_owner_id uuid,
  p_alias text default null,
  p_alias_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alias text;
  v_phone text;
  v_alias_id uuid;
begin
  if p_owner_id is null then
    return null;
  end if;

  v_alias := nullif(btrim(coalesce(p_alias, '')), '');
  if v_alias is null then
    return null;
  end if;

  if p_alias_phone is null or btrim(p_alias_phone) = '' then
    v_phone := null;
  else
    v_phone := public.normalize_phone_e164(p_alias_phone);
  end if;

  insert into public.owner_aliases (owner_id, alias, alias_phone, is_active, last_seen_at)
  values (p_owner_id, v_alias, v_phone, true, now())
  on conflict (owner_id, alias) do update
  set alias_phone = coalesce(excluded.alias_phone, public.owner_aliases.alias_phone),
      is_active = true,
      last_seen_at = now()
  returning id into v_alias_id;

  return v_alias_id;
end;
$$;

create or replace function public.append_owner_client_event_v3(
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

create or replace function public.intake_pending_cliente_v3(
  p_owner_key text,
  p_cliente_telefono text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  cajero_id uuid,
  jugador_id uuid,
  link_id uuid,
  estado text,
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
  v_client_id uuid;
  v_link_id uuid;
  v_status text;
  v_alias_id uuid;
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

  insert into public.clients (pagina, phone_e164)
  values (v_pagina, v_cliente_telefono)
  on conflict (pagina, phone_e164) do update
  set updated_at = now()
  returning id into v_client_id;

  insert into public.owner_client_links (
    owner_id,
    client_id,
    status,
    first_seen_at,
    last_seen_at
  )
  values (
    v_owner_id,
    v_client_id,
    'pending',
    now(),
    now()
  )
  on conflict on constraint uq_owner_client_links_owner_client do update
  set status = case
      when public.owner_client_links.status = 'assigned' then 'assigned'
      else 'pending'
    end,
    last_seen_at = now(),
    assigned_at = case
      when public.owner_client_links.status = 'assigned' then public.owner_client_links.assigned_at
      else null
    end
  returning id, status into v_link_id, v_status;

  v_alias_id := public.touch_owner_alias_v3(v_owner_id, p_actor_alias, p_actor_phone);

  perform public.append_owner_client_event_v3(
    v_owner_id,
    v_client_id,
    v_alias_id,
    p_actor_alias,
    p_actor_phone,
    'intake',
    jsonb_build_object('owner_key', v_owner_key, 'owner_label', coalesce(p_owner_label, v_owner_key))
  );

  cajero_id := v_owner_id;
  jugador_id := v_client_id;
  link_id := v_link_id;
  estado := v_status;
  owner_id := v_owner_id;
  client_id := v_client_id;
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
  v_owner_id uuid;
  v_owner_key text;
  v_pagina text;
  v_cliente_telefono text;
  v_client_id uuid;
  v_link_id uuid;
  v_previous_username text;
  v_target_username text;
  v_alias_id uuid;
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

  select c.id, c.username
    into v_client_id, v_previous_username
  from public.clients c
  where c.pagina = v_pagina
    and c.phone_e164 = v_cliente_telefono
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'link not found for owner + telefono';
  end if;

  select l.id
    into v_link_id
  from public.owner_client_links l
  where l.owner_id = v_owner_id
    and l.client_id = v_client_id
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'link not found for owner + telefono';
  end if;

  if v_previous_username is not null and v_previous_username <> v_target_username then
    raise exception using
      errcode = 'P0001',
      message = 'jugador is already assigned and username is immutable';
  end if;

  begin
    update public.clients
    set username = coalesce(username, v_target_username),
        updated_at = now()
    where id = v_client_id
      and pagina = v_pagina
    returning public.clients.username into username;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = 'username already exists in this pagina';
  end;

  if username is null then
    username := v_target_username;
  end if;

  update public.owner_client_links
  set status = 'assigned',
      assigned_at = coalesce(assigned_at, now()),
      last_seen_at = now(),
      updated_at = now()
  where id = v_link_id;

  v_alias_id := public.touch_owner_alias_v3(v_owner_id, p_actor_alias, p_actor_phone);

  perform public.append_owner_client_event_v3(
    v_owner_id,
    v_client_id,
    v_alias_id,
    p_actor_alias,
    p_actor_phone,
    'assign_username',
    jsonb_build_object('owner_key', v_owner_key, 'username', username, 'mode', 'pending')
  );

  jugador_id := v_client_id;
  estado := 'assigned';
  owner_id := v_owner_id;
  client_id := v_client_id;
  return next;
end;
$$;

create or replace function public.assign_username_by_phone_v3(
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
  v_client_id uuid;
  v_link_id uuid;
  v_target_username text;
  v_alias_id uuid;
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

  select c.id, c.username
    into v_client_id, previous_username
  from public.clients c
  where c.pagina = v_pagina
    and c.phone_e164 = v_cliente_telefono
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'link not found for owner + telefono';
  end if;

  select l.id
    into v_link_id
  from public.owner_client_links l
  where l.owner_id = v_owner_id
    and l.client_id = v_client_id
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'link not found for owner + telefono';
  end if;

  begin
    update public.clients
    set username = v_target_username,
        updated_at = now()
    where id = v_client_id
      and pagina = v_pagina
    returning public.clients.username into current_username;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = 'username already exists in this pagina';
  end;

  overwritten := previous_username is not null and previous_username <> current_username;

  update public.owner_client_links
  set status = 'assigned',
      assigned_at = coalesce(assigned_at, now()),
      last_seen_at = now(),
      updated_at = now()
  where id = v_link_id;

  v_alias_id := public.touch_owner_alias_v3(v_owner_id, p_actor_alias, p_actor_phone);

  perform public.append_owner_client_event_v3(
    v_owner_id,
    v_client_id,
    v_alias_id,
    p_actor_alias,
    p_actor_phone,
    'assign_username',
    jsonb_build_object(
      'owner_key',
      v_owner_key,
      'username',
      current_username,
      'overwritten',
      overwritten
    )
  );

  owner_id := v_owner_id;
  client_id := v_client_id;
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
  from public.assign_username_by_phone_v3(
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

revoke all on function public.resolve_owner_identity_v3(text, text, text) from public;
revoke all on function public.touch_owner_alias_v3(uuid, text, text) from public;
revoke all on function public.append_owner_client_event_v3(uuid, uuid, uuid, text, text, text, jsonb) from public;
revoke all on function public.intake_pending_cliente_v3(text, text, text, text, text, text) from public;
revoke all on function public.assign_pending_username_v3(text, text, text, text, text, text, text) from public;
revoke all on function public.assign_username_by_phone_v3(text, text, text, text, text, text, text) from public;
revoke all on function public.sync_create_player_link_v3(text, text, text, text, text, text, text) from public;

grant execute on function public.resolve_owner_identity_v3(text, text, text) to service_role;
grant execute on function public.touch_owner_alias_v3(uuid, text, text) to service_role;
grant execute on function public.append_owner_client_event_v3(uuid, uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function public.intake_pending_cliente_v3(text, text, text, text, text, text) to service_role;
grant execute on function public.assign_pending_username_v3(text, text, text, text, text, text, text) to service_role;
grant execute on function public.assign_username_by_phone_v3(text, text, text, text, text, text, text) to service_role;
grant execute on function public.sync_create_player_link_v3(text, text, text, text, text, text, text) to service_role;

do $$
declare
  v_ts text := to_char(now() at time zone 'utc', 'YYYYMMDDHH24MI');
begin
  execute format('create table if not exists public.cajeros_backup_%s as table public.cajeros', v_ts);
  execute format('create table if not exists public.jugadores_backup_%s as table public.jugadores', v_ts);
  execute format('create table if not exists public.cajeros_jugadores_backup_%s as table public.cajeros_jugadores', v_ts);
  execute format('create table if not exists public.cajero_owners_backup_%s as table public.cajero_owners', v_ts);
  execute format('create table if not exists public.cajero_aliases_backup_%s as table public.cajero_aliases', v_ts);
  execute format('create table if not exists public.cliente_contact_events_backup_%s as table public.cliente_contact_events', v_ts);
end
$$;

drop function if exists public.assign_username_by_phone_v2(text, text, text, text, text, text, text) cascade;
drop function if exists public.assign_pending_username_v2(text, text, text, text, text, text, text) cascade;
drop function if exists public.intake_pending_cliente_v2(text, text, text, text, text, text) cascade;
drop function if exists public.append_cliente_contact_event_v2(uuid, text, text, text, text, text, jsonb) cascade;
drop function if exists public.touch_owner_alias_v2(uuid, text, text) cascade;
drop function if exists public.resolve_owner_identity_v2(text, text, text) cascade;
drop function if exists public.assign_username_by_phone(text, text, text, text) cascade;
drop function if exists public.assign_pending_username(text, text, text, text) cascade;
drop function if exists public.intake_pending_cliente(text, text, text) cascade;

drop table if exists public.cajeros_jugadores cascade;
drop table if exists public.jugadores cascade;
drop table if exists public.cajeros cascade;
drop table if exists public.cajero_aliases cascade;
drop table if exists public.cliente_contact_events cascade;
drop table if exists public.cajero_owners cascade;

commit;
