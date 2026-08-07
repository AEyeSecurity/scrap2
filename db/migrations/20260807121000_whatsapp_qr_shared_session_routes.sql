-- One Baileys connection can feed multiple platform/owner routes. Existing
-- sessions remain the physical connection and their owner becomes its primary
-- route, so applying this migration does not reconnect or invalidate auth.
create table if not exists public.mastercrm_whatsapp_qr_session_routes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.mastercrm_whatsapp_qr_sessions(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  pagina text not null check (pagina in ('ASN', 'RdA')),
  owner_key text not null check (owner_key = lower(btrim(owner_key)) and owner_key <> ''),
  owner_label text not null check (owner_label = btrim(owner_label) and owner_label <> ''),
  status text not null default 'active' check (status in ('active', 'inactive')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_whatsapp_qr_session_routes_session_owner unique (session_id, owner_id)
);

create unique index if not exists uq_mastercrm_whatsapp_qr_session_routes_primary
  on public.mastercrm_whatsapp_qr_session_routes (session_id)
  where is_primary;

create unique index if not exists uq_mastercrm_whatsapp_qr_session_routes_active_owner
  on public.mastercrm_whatsapp_qr_session_routes (owner_id)
  where status = 'active';

create index if not exists ix_mastercrm_whatsapp_qr_session_routes_owner
  on public.mastercrm_whatsapp_qr_session_routes (owner_id, status, updated_at desc);

insert into public.mastercrm_whatsapp_qr_session_routes (
  session_id,
  owner_id,
  pagina,
  owner_key,
  owner_label,
  status,
  is_primary
)
select id, owner_id, pagina, owner_key, owner_label, 'active', true
from public.mastercrm_whatsapp_qr_sessions
on conflict (session_id, owner_id) do update
set pagina = excluded.pagina,
    owner_key = excluded.owner_key,
    owner_label = excluded.owner_label,
    status = 'active',
    is_primary = true,
    updated_at = now();

alter table public.mastercrm_whatsapp_qr_messages
  add column if not exists route_status text;
alter table public.mastercrm_whatsapp_qr_messages
  add column if not exists resolved_owner_id uuid references public.owners(id) on delete set null;
alter table public.mastercrm_whatsapp_qr_messages
  add column if not exists resolved_pagina text;
alter table public.mastercrm_whatsapp_qr_messages
  add column if not exists route_resolution text;
alter table public.mastercrm_whatsapp_qr_messages
  add column if not exists route_resolved_at timestamptz;
alter table public.mastercrm_whatsapp_qr_messages
  add column if not exists source_context jsonb;

update public.mastercrm_whatsapp_qr_messages
set route_status = 'resolved',
    resolved_owner_id = owner_id,
    resolved_pagina = coalesce(
      (select sessions.pagina
       from public.mastercrm_whatsapp_qr_sessions sessions
       where sessions.id = mastercrm_whatsapp_qr_messages.session_id),
      'RdA'
    ),
    route_resolution = 'legacy_primary_owner',
    route_resolved_at = coalesce(event_at, created_at)
where route_status is null;

alter table public.mastercrm_whatsapp_qr_messages
  alter column route_status set default 'unrouted',
  alter column route_status set not null;

alter table public.mastercrm_whatsapp_qr_messages
  drop constraint if exists mastercrm_whatsapp_qr_messages_route_status_check;
alter table public.mastercrm_whatsapp_qr_messages
  add constraint mastercrm_whatsapp_qr_messages_route_status_check
    check (route_status in ('unrouted', 'resolved', 'conflict', 'not_found', 'error'));

alter table public.mastercrm_whatsapp_qr_messages
  drop constraint if exists mastercrm_whatsapp_qr_messages_resolved_pagina_check;
alter table public.mastercrm_whatsapp_qr_messages
  add constraint mastercrm_whatsapp_qr_messages_resolved_pagina_check
    check (resolved_pagina is null or resolved_pagina in ('ASN', 'RdA'));

alter table public.mastercrm_whatsapp_qr_messages
  drop constraint if exists mastercrm_whatsapp_qr_messages_route_resolution_check;
alter table public.mastercrm_whatsapp_qr_messages
  add constraint mastercrm_whatsapp_qr_messages_route_resolution_check check (
    (route_status = 'resolved' and resolved_owner_id is not null and resolved_pagina is not null and route_resolved_at is not null)
    or (route_status <> 'resolved' and resolved_owner_id is null and resolved_pagina is null)
  );

create index if not exists ix_mastercrm_whatsapp_qr_messages_route_review
  on public.mastercrm_whatsapp_qr_messages (route_status, event_at desc)
  where route_status <> 'resolved';

-- A physical message may yield one validation attempt per route. The owner is
-- therefore part of idempotency; replaying the same event for the same route
-- remains a no-op.
with duplicates as (
  select id,
    row_number() over (
      partition by message_id, owner_id, username, source
      order by
        case status
          when 'assigned' then 1
          when 'validated' then 2
          when 'conflict' then 3
          when 'not_found' then 4
          when 'candidate' then 5
          else 6
        end,
        updated_at desc,
        id asc
    ) as duplicate_number
  from public.mastercrm_whatsapp_qr_matches
  where message_id is not null
)
delete from public.mastercrm_whatsapp_qr_matches matches
using duplicates
where matches.id = duplicates.id
  and duplicates.duplicate_number > 1;

alter table public.mastercrm_whatsapp_qr_matches
  drop constraint if exists uq_mastercrm_whatsapp_qr_matches_message_username_source;
alter table public.mastercrm_whatsapp_qr_matches
  drop constraint if exists uq_mastercrm_whatsapp_qr_matches_message_owner_username_source;
alter table public.mastercrm_whatsapp_qr_matches
  add constraint uq_mastercrm_whatsapp_qr_matches_message_owner_username_source
    unique (message_id, owner_id, username, source);

create or replace function public.set_whatsapp_qr_message_route_v1(
  p_message_id uuid,
  p_status text,
  p_owner_id uuid default null,
  p_resolution text default null
)
returns setof public.mastercrm_whatsapp_qr_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message public.mastercrm_whatsapp_qr_messages%rowtype;
  v_route public.mastercrm_whatsapp_qr_session_routes%rowtype;
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

  if p_status = 'resolved' then
    if p_owner_id is null then
      raise exception using errcode = '22023', message = 'resolved QR route requires owner';
    end if;
    select * into v_route
    from public.mastercrm_whatsapp_qr_session_routes
    where session_id = v_message.session_id
      and owner_id = p_owner_id
      and status = 'active';
    if not found then
      raise exception using errcode = '23503', message = 'owner is not an active route for QR session';
    end if;
    if v_message.route_status = 'resolved' and v_message.resolved_owner_id <> p_owner_id then
      raise exception using errcode = '23505', message = 'QR message already resolved to another route';
    end if;

    update public.mastercrm_whatsapp_qr_messages
    set owner_id = v_route.owner_id,
        route_status = 'resolved',
        resolved_owner_id = v_route.owner_id,
        resolved_pagina = v_route.pagina,
        route_resolution = nullif(btrim(p_resolution), ''),
        route_resolved_at = coalesce(route_resolved_at, now())
    where id = p_message_id
    returning * into v_message;
  else
    if v_message.route_status = 'resolved' then
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

alter table public.mastercrm_whatsapp_qr_session_routes enable row level security;
revoke all on table public.mastercrm_whatsapp_qr_session_routes from public;
grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_session_routes to service_role;
revoke all on function public.set_whatsapp_qr_message_route_v1(uuid, text, uuid, text) from public;
grant execute on function public.set_whatsapp_qr_message_route_v1(uuid, text, uuid, text) to service_role;
