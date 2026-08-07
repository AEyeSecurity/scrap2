begin;

create table if not exists public.mastercrm_platform_owner_pairs (
  id uuid primary key default gen_random_uuid(),
  rda_owner_id uuid not null references public.owners(id) on delete restrict,
  asn_owner_id uuid not null references public.owners(id) on delete restrict,
  active_from timestamptz not null default now(),
  active_to timestamptz null,
  edited_by text not null default 'system' check (btrim(edited_by) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_mastercrm_platform_owner_pairs_distinct check (rda_owner_id <> asn_owner_id),
  constraint ck_mastercrm_platform_owner_pairs_window check (active_to is null or active_to > active_from)
);

create unique index if not exists uq_mastercrm_platform_owner_pairs_active_rda
  on public.mastercrm_platform_owner_pairs (rda_owner_id)
  where active_to is null;
create unique index if not exists uq_mastercrm_platform_owner_pairs_active_asn
  on public.mastercrm_platform_owner_pairs (asn_owner_id)
  where active_to is null;
create unique index if not exists uq_mastercrm_platform_owner_pairs_window
  on public.mastercrm_platform_owner_pairs (rda_owner_id, asn_owner_id, active_from);

drop trigger if exists trg_mastercrm_platform_owner_pairs_set_updated_at on public.mastercrm_platform_owner_pairs;
create trigger trg_mastercrm_platform_owner_pairs_set_updated_at
before update on public.mastercrm_platform_owner_pairs
for each row execute function public.set_updated_at();

do $$
declare
  v_pair record;
  v_rda_id uuid;
  v_asn_id uuid;
begin
  for v_pair in
    select * from (values
      ('luqui10:luqui10', 'asnlucas10:lucas10'),
      ('luqui10:vicky', 'asnlucas10:vicky'),
      ('luqui10:lucas1', 'asnlucas10:lucas1'),
      ('luqui10:lear', 'asnlucas10:lear'),
      ('luqui10:leandro', 'asnlucas10:leandro')
    ) as pairs(rda_owner_key, asn_owner_key)
  loop
    select id into v_rda_id from public.owners where pagina = 'RdA' and owner_key = v_pair.rda_owner_key;
    select id into v_asn_id from public.owners where pagina = 'ASN' and owner_key = v_pair.asn_owner_key;
    if v_rda_id is not null and v_asn_id is not null then
      insert into public.mastercrm_platform_owner_pairs (rda_owner_id, asn_owner_id, edited_by)
      values (v_rda_id, v_asn_id, 'migration:20260807124500')
      on conflict do nothing;
    end if;
  end loop;
end;
$$;

create table if not exists public.mastercrm_whatsapp_qr_message_resolutions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.mastercrm_whatsapp_qr_messages(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  pagina text not null check (pagina in ('RdA', 'ASN')),
  resolution text not null check (btrim(resolution) <> ''),
  is_primary boolean not null default false,
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint uq_mastercrm_whatsapp_qr_message_resolution_owner unique (message_id, owner_id)
);

create unique index if not exists uq_mastercrm_whatsapp_qr_message_resolution_primary
  on public.mastercrm_whatsapp_qr_message_resolutions (message_id)
  where is_primary;
create index if not exists ix_mastercrm_whatsapp_qr_message_resolutions_owner
  on public.mastercrm_whatsapp_qr_message_resolutions (owner_id, resolved_at desc);

insert into public.mastercrm_whatsapp_qr_message_resolutions (
  message_id, owner_id, pagina, resolution, is_primary, resolved_at
)
select
  id,
  resolved_owner_id,
  resolved_pagina,
  coalesce(nullif(btrim(route_resolution), ''), 'legacy_single_route'),
  true,
  coalesce(route_resolved_at, event_at, created_at)
from public.mastercrm_whatsapp_qr_messages
where route_status = 'resolved'
  and resolved_owner_id is not null
  and resolved_pagina is not null
on conflict (message_id, owner_id) do nothing;

create or replace function public.set_whatsapp_qr_message_routes_v1(
  p_message_id uuid,
  p_status text,
  p_owner_ids uuid[] default '{}'::uuid[],
  p_resolution text default null
)
returns setof public.mastercrm_whatsapp_qr_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message public.mastercrm_whatsapp_qr_messages%rowtype;
  v_primary_route public.mastercrm_whatsapp_qr_session_routes%rowtype;
  v_owner_ids uuid[];
  v_existing_owner_ids uuid[];
  v_route_count integer;
  v_pair_count integer;
begin
  if p_status not in ('unrouted', 'resolved', 'conflict', 'not_found', 'error') then
    raise exception using errcode = '22023', message = 'invalid QR route status';
  end if;

  select * into v_message
  from public.mastercrm_whatsapp_qr_messages
  where id = p_message_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WhatsApp QR message not found';
  end if;

  select coalesce(array_agg(owner_id order by owner_id), '{}'::uuid[])
    into v_owner_ids
  from (select distinct unnest(coalesce(p_owner_ids, '{}'::uuid[])) owner_id) owners;

  if p_status = 'resolved' then
    if cardinality(v_owner_ids) not between 1 and 2 then
      raise exception using errcode = '22023', message = 'resolved QR route requires one or two owners';
    end if;

    select count(*) into v_route_count
    from public.mastercrm_whatsapp_qr_session_routes routes
    where routes.session_id = v_message.session_id
      and routes.owner_id = any(v_owner_ids)
      and routes.status = 'active';
    if v_route_count <> cardinality(v_owner_ids) then
      raise exception using errcode = '23503', message = 'owner is not an active route for QR session';
    end if;

    if cardinality(v_owner_ids) = 2 then
      select count(*) into v_pair_count
      from public.mastercrm_platform_owner_pairs pairs
      where pairs.rda_owner_id = any(v_owner_ids)
        and pairs.asn_owner_id = any(v_owner_ids)
        and pairs.active_from <= now()
        and (pairs.active_to is null or pairs.active_to > now());
      if v_pair_count <> 1 then
        raise exception using errcode = '23514', message = 'QR_PAIR_NOT_CONFIGURED';
      end if;
    end if;

    select coalesce(array_agg(owner_id order by owner_id), '{}'::uuid[])
      into v_existing_owner_ids
    from public.mastercrm_whatsapp_qr_message_resolutions
    where message_id = p_message_id;
    if cardinality(v_existing_owner_ids) > 0 and v_existing_owner_ids <> v_owner_ids then
      raise exception using errcode = '23505', message = 'QR message already resolved to another route';
    end if;

    select * into v_primary_route
    from public.mastercrm_whatsapp_qr_session_routes routes
    where routes.session_id = v_message.session_id
      and routes.owner_id = any(v_owner_ids)
      and routes.status = 'active'
    order by routes.is_primary desc, routes.created_at, routes.id
    limit 1;

    insert into public.mastercrm_whatsapp_qr_message_resolutions (
      message_id, owner_id, pagina, resolution, is_primary, resolved_at
    )
    select
      p_message_id,
      routes.owner_id,
      routes.pagina,
      coalesce(nullif(btrim(p_resolution), ''), 'automatic_route'),
      routes.owner_id = v_primary_route.owner_id,
      coalesce(v_message.route_resolved_at, now())
    from public.mastercrm_whatsapp_qr_session_routes routes
    where routes.session_id = v_message.session_id
      and routes.owner_id = any(v_owner_ids)
      and routes.status = 'active'
    on conflict (message_id, owner_id) do update
    set resolution = excluded.resolution,
        is_primary = excluded.is_primary;

    update public.mastercrm_whatsapp_qr_messages
    set owner_id = v_primary_route.owner_id,
        route_status = 'resolved',
        resolved_owner_id = v_primary_route.owner_id,
        resolved_pagina = v_primary_route.pagina,
        route_resolution = nullif(btrim(p_resolution), ''),
        route_resolved_at = coalesce(route_resolved_at, now())
    where id = p_message_id
    returning * into v_message;
  else
    if exists (
      select 1 from public.mastercrm_whatsapp_qr_message_resolutions where message_id = p_message_id
    ) then
      raise exception using errcode = '23505', message = 'resolved QR message cannot be moved back to review';
    end if;
    update public.mastercrm_whatsapp_qr_messages
    set route_status = p_status,
        resolved_owner_id = null,
        resolved_pagina = null,
        route_resolution = nullif(btrim(p_resolution), ''),
        route_resolved_at = null
    where id = p_message_id
    returning * into v_message;
  end if;

  return next v_message;
end;
$$;

create or replace function public.set_whatsapp_qr_message_route_v1(
  p_message_id uuid,
  p_status text,
  p_owner_id uuid default null,
  p_resolution text default null
)
returns setof public.mastercrm_whatsapp_qr_messages
language sql
security definer
set search_path = public
as $$
  select * from public.set_whatsapp_qr_message_routes_v1(
    p_message_id,
    p_status,
    case when p_owner_id is null then '{}'::uuid[] else array[p_owner_id] end,
    p_resolution
  );
$$;

create or replace function public.assign_username_to_platform_owner_pair_v1(
  p_pair_id uuid,
  p_cliente_telefono text,
  p_username text,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (owner_id uuid, pagina text, owner_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pair public.mastercrm_platform_owner_pairs%rowtype;
  v_rda public.owners%rowtype;
  v_asn public.owners%rowtype;
begin
  select * into v_pair
  from public.mastercrm_platform_owner_pairs
  where id = p_pair_id
    and active_from <= now()
    and (active_to is null or active_to > now())
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'QR_PAIR_NOT_CONFIGURED';
  end if;

  select owners.* into v_rda
  from public.owners owners
  where owners.id = v_pair.rda_owner_id and owners.pagina = 'RdA';
  select owners.* into v_asn
  from public.owners owners
  where owners.id = v_pair.asn_owner_id and owners.pagina = 'ASN';
  if v_rda.id is null or v_asn.id is null then
    raise exception using errcode = '23514', message = 'invalid platform owner pair';
  end if;

  perform * from public.assign_username_by_phone_v4(
    v_rda.owner_key, p_cliente_telefono, p_username, 'RdA', v_rda.owner_label, p_actor_alias, p_actor_phone
  );
  perform * from public.assign_username_by_phone_v4(
    v_asn.owner_key, p_cliente_telefono, p_username, 'ASN', v_asn.owner_label, p_actor_alias, p_actor_phone
  );

  owner_id := v_rda.id; pagina := 'RdA'; owner_key := v_rda.owner_key; return next;
  owner_id := v_asn.id; pagina := 'ASN'; owner_key := v_asn.owner_key; return next;
end;
$$;

create or replace view public.mastercrm_whatsapp_qr_messages_by_owner as
select
  messages.*,
  coalesce(resolutions.owner_id, messages.owner_id) as scope_owner_id,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'owner_id', all_resolutions.owner_id,
          'pagina', all_resolutions.pagina,
          'resolution', all_resolutions.resolution,
          'is_primary', all_resolutions.is_primary,
          'resolved_at', all_resolutions.resolved_at
        ) order by all_resolutions.is_primary desc, all_resolutions.pagina, all_resolutions.owner_id
      )
      from public.mastercrm_whatsapp_qr_message_resolutions all_resolutions
      where all_resolutions.message_id = messages.id
    ),
    '[]'::jsonb
  ) as resolved_owners
from public.mastercrm_whatsapp_qr_messages messages
left join public.mastercrm_whatsapp_qr_message_resolutions resolutions
  on resolutions.message_id = messages.id;

alter table public.mastercrm_platform_owner_pairs enable row level security;
alter table public.mastercrm_whatsapp_qr_message_resolutions enable row level security;
revoke all on table public.mastercrm_platform_owner_pairs from public;
revoke all on table public.mastercrm_whatsapp_qr_message_resolutions from public;
revoke all on public.mastercrm_whatsapp_qr_messages_by_owner from public;
grant select, insert, update on table public.mastercrm_platform_owner_pairs to service_role;
grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_message_resolutions to service_role;
grant select on public.mastercrm_whatsapp_qr_messages_by_owner to service_role;
revoke all on function public.set_whatsapp_qr_message_routes_v1(uuid, text, uuid[], text) from public;
revoke all on function public.assign_username_to_platform_owner_pair_v1(uuid, text, text, text, text) from public;
grant execute on function public.set_whatsapp_qr_message_routes_v1(uuid, text, uuid[], text) to service_role;
grant execute on function public.assign_username_to_platform_owner_pair_v1(uuid, text, text, text, text) to service_role;

commit;
