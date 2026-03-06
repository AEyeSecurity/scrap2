begin;

create table if not exists public.cajero_owners (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('RdA', 'ASN')),
  owner_key text not null check (owner_key = btrim(owner_key)),
  owner_label text not null check (owner_label = btrim(owner_label) and owner_label <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_cajero_owners_owner_key unique (owner_key)
);

drop trigger if exists trg_cajero_owners_set_updated_at on public.cajero_owners;
create trigger trg_cajero_owners_set_updated_at
before update on public.cajero_owners
for each row execute function public.set_updated_at();

create table if not exists public.cajero_aliases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.cajero_owners(id) on delete cascade,
  alias text not null check (alias = btrim(alias) and alias <> ''),
  alias_phone text null check (alias_phone ~ '^\+[1-9][0-9]{7,14}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint uq_cajero_aliases_owner_alias unique (owner_id, alias)
);

drop trigger if exists trg_cajero_aliases_set_updated_at on public.cajero_aliases;
create trigger trg_cajero_aliases_set_updated_at
before update on public.cajero_aliases
for each row execute function public.set_updated_at();

create table if not exists public.cliente_contact_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.cajero_owners(id) on delete cascade,
  pagina text not null check (pagina in ('RdA', 'ASN')),
  cliente_telefono text not null check (cliente_telefono ~ '^\+[1-9][0-9]{7,14}$'),
  actor_alias text null,
  actor_phone text null check (actor_phone is null or actor_phone ~ '^\+[1-9][0-9]{7,14}$'),
  event_type text not null check (event_type in ('intake', 'link_sent', 'create_player', 'assign_username')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_cliente_contact_events_owner_created_at
  on public.cliente_contact_events (owner_id, created_at desc);
create index if not exists ix_cliente_contact_events_owner_phone
  on public.cliente_contact_events (owner_id, cliente_telefono);
create index if not exists ix_cliente_contact_events_phone_created_at
  on public.cliente_contact_events (cliente_telefono, created_at desc);

alter table public.cajero_owners enable row level security;
alter table public.cajero_aliases enable row level security;
alter table public.cliente_contact_events enable row level security;

create or replace function public.resolve_owner_identity_v2(
  p_owner_key text,
  p_owner_label text,
  p_pagina text default 'ASN'
)
returns table (
  owner_id uuid,
  cajero_id uuid,
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
  v_owner_id uuid;
  v_owner_pagina text;
  v_cajero_id uuid;
  v_cajero_pagina text;
begin
  v_owner_key := btrim(coalesce(p_owner_key, ''));
  if v_owner_key = '' then
    raise exception using
      errcode = '22023',
      message = 'owner_key is required';
  end if;

  v_owner_label := btrim(coalesce(p_owner_label, ''));
  if v_owner_label = '' then
    raise exception using
      errcode = '22023',
      message = 'owner_label is required';
  end if;

  v_pagina := btrim(coalesce(p_pagina, 'ASN'));
  if v_pagina not in ('RdA', 'ASN') then
    raise exception using
      errcode = '22023',
      message = 'pagina must be RdA or ASN';
  end if;

  select o.id, o.pagina
    into v_owner_id, v_owner_pagina
  from public.cajero_owners o
  where o.owner_key = v_owner_key
  limit 1;

  if found then
    if v_owner_pagina <> v_pagina then
      raise exception using
        errcode = 'P0001',
        message = 'owner_key already exists in another pagina';
    end if;

    update public.cajero_owners
    set owner_label = v_owner_label
    where id = v_owner_id
      and owner_label <> v_owner_label;
  else
    insert into public.cajero_owners (pagina, owner_key, owner_label)
    values (v_pagina, v_owner_key, v_owner_label)
    returning id into v_owner_id;
  end if;

  select c.id, c.pagina
    into v_cajero_id, v_cajero_pagina
  from public.cajeros c
  where c.username = v_owner_key
  limit 1;

  if found then
    if v_cajero_pagina <> v_pagina then
      raise exception using
        errcode = 'P0001',
        message = 'owner_key already exists in another pagina';
    end if;
  else
    insert into public.cajeros (pagina, username)
    values (v_pagina, v_owner_key)
    on conflict (username) do nothing;

    select c.id, c.pagina
      into v_cajero_id, v_cajero_pagina
    from public.cajeros c
    where c.username = v_owner_key
    limit 1;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'could not resolve owner cajero';
    end if;

    if v_cajero_pagina <> v_pagina then
      raise exception using
        errcode = 'P0001',
        message = 'owner_key already exists in another pagina';
    end if;
  end if;

  return query
  select v_owner_id, v_cajero_id, v_pagina, v_owner_key;
end;
$$;

create or replace function public.touch_owner_alias_v2(
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

  insert into public.cajero_aliases (owner_id, alias, alias_phone, is_active, last_seen_at)
  values (p_owner_id, v_alias, v_phone, true, now())
  on conflict (owner_id, alias) do update
  set alias_phone = coalesce(excluded.alias_phone, public.cajero_aliases.alias_phone),
      is_active = true,
      last_seen_at = now()
  returning id into v_alias_id;

  return v_alias_id;
end;
$$;

create or replace function public.append_cliente_contact_event_v2(
  p_owner_id uuid,
  p_pagina text,
  p_cliente_telefono text,
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
  v_pagina text;
  v_cliente_telefono text;
  v_actor_alias text;
  v_actor_phone text;
begin
  if p_owner_id is null then
    raise exception using
      errcode = '22023',
      message = 'owner_id is required';
  end if;

  v_pagina := btrim(coalesce(p_pagina, 'ASN'));
  if v_pagina not in ('RdA', 'ASN') then
    raise exception using
      errcode = '22023',
      message = 'pagina must be RdA or ASN';
  end if;

  v_cliente_telefono := public.normalize_phone_e164(p_cliente_telefono);
  v_actor_alias := nullif(btrim(coalesce(p_actor_alias, '')), '');
  if p_actor_phone is null or btrim(p_actor_phone) = '' then
    v_actor_phone := null;
  else
    v_actor_phone := public.normalize_phone_e164(p_actor_phone);
  end if;

  insert into public.cliente_contact_events (
    owner_id,
    pagina,
    cliente_telefono,
    actor_alias,
    actor_phone,
    event_type,
    payload
  )
  values (
    p_owner_id,
    v_pagina,
    v_cliente_telefono,
    v_actor_alias,
    v_actor_phone,
    p_event_type,
    coalesce(p_payload, '{}'::jsonb)
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

create or replace function public.intake_pending_cliente_v2(
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
  owner_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_cajero_id uuid;
  v_pagina text;
  v_owner_key text;
  v_cliente_telefono text;
begin
  select r.owner_id, r.cajero_id, r.pagina, r.owner_key
    into v_owner_id, v_cajero_id, v_pagina, v_owner_key
  from public.resolve_owner_identity_v2(
    p_owner_key,
    coalesce(nullif(btrim(coalesce(p_owner_label, '')), ''), btrim(coalesce(p_owner_key, ''))),
    p_pagina
  ) as r
  limit 1;

  v_cliente_telefono := public.normalize_phone_e164(p_cliente_telefono);

  perform public.touch_owner_alias_v2(v_owner_id, p_actor_alias, p_actor_phone);

  begin
    select i.cajero_id, i.jugador_id, i.link_id, i.estado
      into cajero_id, jugador_id, link_id, estado
    from public.intake_pending_cliente(v_owner_key, v_cliente_telefono, v_pagina) as i
    limit 1;
  exception
    when others then
      if sqlstate = 'P0001' and position('telefono already assigned' in lower(sqlerrm)) > 0 then
        select cj.id, cj.jugador_id, j.estado
          into link_id, jugador_id, estado
        from public.cajeros_jugadores cj
        join public.jugadores j on j.id = cj.jugador_id
        where cj.cajero_id = v_cajero_id
          and cj.telefono = v_cliente_telefono
        limit 1;

        if not found then
          raise;
        end if;

        cajero_id := v_cajero_id;
      else
        raise;
      end if;
  end;

  perform public.append_cliente_contact_event_v2(
    v_owner_id,
    v_pagina,
    v_cliente_telefono,
    p_actor_alias,
    p_actor_phone,
    'intake',
    jsonb_build_object('owner_key', v_owner_key, 'owner_label', coalesce(p_owner_label, ''))
  );

  owner_id := v_owner_id;
  return next;
end;
$$;

create or replace function public.assign_pending_username_v2(
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
  owner_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_cajero_id uuid;
  v_pagina text;
  v_owner_key text;
  v_cliente_telefono text;
begin
  select r.owner_id, r.cajero_id, r.pagina, r.owner_key
    into v_owner_id, v_cajero_id, v_pagina, v_owner_key
  from public.resolve_owner_identity_v2(
    p_owner_key,
    coalesce(nullif(btrim(coalesce(p_owner_label, '')), ''), btrim(coalesce(p_owner_key, ''))),
    p_pagina
  ) as r
  limit 1;

  v_cliente_telefono := public.normalize_phone_e164(p_cliente_telefono);

  perform public.touch_owner_alias_v2(v_owner_id, p_actor_alias, p_actor_phone);

  select a.jugador_id, a.username, a.estado
    into jugador_id, username, estado
  from public.assign_pending_username(v_owner_key, v_cliente_telefono, p_username, v_pagina) as a
  limit 1;

  perform public.append_cliente_contact_event_v2(
    v_owner_id,
    v_pagina,
    v_cliente_telefono,
    p_actor_alias,
    p_actor_phone,
    'assign_username',
    jsonb_build_object('owner_key', v_owner_key, 'username', username)
  );

  owner_id := v_owner_id;
  return next;
end;
$$;

create or replace function public.assign_username_by_phone_v2(
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
  owner_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_cajero_id uuid;
  v_pagina text;
  v_owner_key text;
  v_cliente_telefono text;
begin
  select r.owner_id, r.cajero_id, r.pagina, r.owner_key
    into v_owner_id, v_cajero_id, v_pagina, v_owner_key
  from public.resolve_owner_identity_v2(
    p_owner_key,
    coalesce(nullif(btrim(coalesce(p_owner_label, '')), ''), btrim(coalesce(p_owner_key, ''))),
    p_pagina
  ) as r
  limit 1;

  v_cliente_telefono := public.normalize_phone_e164(p_cliente_telefono);

  perform public.touch_owner_alias_v2(v_owner_id, p_actor_alias, p_actor_phone);

  select a.previous_username, a.current_username, a.overwritten
    into previous_username, current_username, overwritten
  from public.assign_username_by_phone(v_owner_key, v_cliente_telefono, p_username, v_pagina) as a
  limit 1;

  perform public.append_cliente_contact_event_v2(
    v_owner_id,
    v_pagina,
    v_cliente_telefono,
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
  return next;
end;
$$;

revoke all on function public.resolve_owner_identity_v2(text, text, text) from public;
grant execute on function public.resolve_owner_identity_v2(text, text, text) to service_role;

revoke all on function public.touch_owner_alias_v2(uuid, text, text) from public;
grant execute on function public.touch_owner_alias_v2(uuid, text, text) to service_role;

revoke all on function public.append_cliente_contact_event_v2(uuid, text, text, text, text, text, jsonb) from public;
grant execute on function public.append_cliente_contact_event_v2(uuid, text, text, text, text, text, jsonb) to service_role;

revoke all on function public.intake_pending_cliente_v2(text, text, text, text, text, text) from public;
revoke all on function public.assign_pending_username_v2(text, text, text, text, text, text, text) from public;
revoke all on function public.assign_username_by_phone_v2(text, text, text, text, text, text, text) from public;
grant execute on function public.intake_pending_cliente_v2(text, text, text, text, text, text) to service_role;
grant execute on function public.assign_pending_username_v2(text, text, text, text, text, text, text) to service_role;
grant execute on function public.assign_username_by_phone_v2(text, text, text, text, text, text, text) to service_role;

commit;
