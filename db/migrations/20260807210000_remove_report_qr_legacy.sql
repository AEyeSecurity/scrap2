begin;

-- Report runs are idempotent by caller request, while preserving every
-- historical/manual execution for the same platform, principal and date.
alter table public.report_runs add column if not exists request_key text;
update public.report_runs
set request_key = 'historical:' || id::text
where nullif(btrim(request_key), '') is null;
alter table public.report_runs alter column request_key set not null;
alter table public.report_runs drop constraint if exists uq_report_runs_pagina_principal_date;
create unique index if not exists uq_report_runs_request
  on public.report_runs (pagina, principal_key, report_date, request_key);

drop function if exists public.claim_next_report_run_item(integer, integer);

-- Secrets are resolved only from the exact owner/platform credential when an
-- item is leased. Runs contain no credential copy, placeholder or fallback.
alter table public.report_runs drop column if exists credential_id;
alter table public.report_runs drop column if exists agente;
alter table public.report_runs drop column if exists contrasena_agente;
drop table if exists public.mastercrm_report_credentials;
drop table if exists public.mastercrm_rda_credentials;

create function public.claim_next_report_run_item(
  p_lease_seconds integer default 600,
  p_max_attempts integer default 3
)
returns table (
  item_id uuid,
  run_id uuid,
  pagina text,
  principal_key text,
  report_date date,
  login_username text,
  login_password text,
  owner_id uuid,
  identity_id uuid,
  client_id uuid,
  link_id uuid,
  username text,
  owner_key text,
  owner_label text,
  attempts integer,
  max_attempts integer,
  lease_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_lease_token uuid := gen_random_uuid();
begin
  update public.report_run_items ri
  set status = 'failed', lease_until = null, lease_token = null,
      next_retry_at = null, finished_at = now(),
      last_error = 'PLATFORM_CREDENTIAL_MISSING', updated_at = now()
  from public.report_runs rr
  where rr.id = ri.run_id
    and rr.status in ('queued', 'running')
    and ri.status in ('pending', 'retry_wait', 'leased')
    and not exists (
      select 1
      from public.mastercrm_platform_credentials credentials
      where credentials.owner_id = ri.owner_id
        and credentials.pagina = rr.pagina
        and credentials.owner_key = ri.owner_key
        and nullif(btrim(credentials.login_username), '') is not null
        and nullif(credentials.login_password, '') is not null
    );

  with stats as (
    select rr.id,
      count(*) filter (where ri.status = 'done')::integer done_items,
      count(*) filter (where ri.status = 'failed')::integer failed_items,
      count(*) filter (where ri.status in ('pending', 'retry_wait', 'leased'))::integer active_items
    from public.report_runs rr
    join public.report_run_items ri on ri.run_id = rr.id
    where rr.status in ('queued', 'running')
    group by rr.id
  )
  update public.report_runs rr
  set done_items = stats.done_items,
      failed_items = stats.failed_items,
      status = case
        when stats.active_items > 0 then rr.status
        when stats.failed_items = 0 then 'completed'
        when stats.done_items = 0 then 'failed'
        else 'completed_with_errors'
      end,
      finished_at = case when stats.active_items = 0 then now() else rr.finished_at end
  from stats where rr.id = stats.id;

  select ri.id, ri.run_id, rr.pagina, rr.principal_key, rr.report_date,
    credentials.login_username, credentials.login_password,
    ri.owner_id, ri.identity_id, ri.client_id, ri.link_id, ri.username,
    ri.owner_key, ri.owner_label, ri.attempts + 1 next_attempts, ri.max_attempts
  into v_item
  from public.report_run_items ri
  join public.report_runs rr on rr.id = ri.run_id
  join public.mastercrm_platform_credentials credentials
    on credentials.owner_id = ri.owner_id
   and credentials.pagina = rr.pagina
   and credentials.owner_key = ri.owner_key
   and nullif(btrim(credentials.login_username), '') is not null
   and nullif(credentials.login_password, '') is not null
  where rr.status in ('queued', 'running')
    and ri.attempts < least(coalesce(p_max_attempts, 3), ri.max_attempts)
    and (
      ri.status = 'pending'
      or (ri.status = 'retry_wait' and coalesce(ri.next_retry_at, now()) <= now())
      or (ri.status = 'leased' and coalesce(ri.lease_until, now()) <= now())
    )
  order by case ri.status when 'leased' then 0 when 'retry_wait' then 1 else 2 end,
    ri.created_at, ri.id
  limit 1
  for update of ri skip locked;

  if not found then return; end if;

  update public.report_run_items
  set status = 'leased', attempts = v_item.next_attempts,
      lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 1)),
      lease_token = v_lease_token, next_retry_at = null,
      started_at = coalesce(started_at, now()), updated_at = now()
  where id = v_item.id;

  update public.report_runs
  set status = case when status = 'queued' then 'running' else status end,
      started_at = coalesce(started_at, now())
  where id = v_item.run_id;

  item_id := v_item.id; run_id := v_item.run_id; pagina := v_item.pagina;
  principal_key := v_item.principal_key; report_date := v_item.report_date;
  login_username := v_item.login_username; login_password := v_item.login_password;
  owner_id := v_item.owner_id; identity_id := v_item.identity_id;
  client_id := v_item.client_id; link_id := v_item.link_id; username := v_item.username;
  owner_key := v_item.owner_key; owner_label := v_item.owner_label;
  attempts := v_item.next_attempts; max_attempts := v_item.max_attempts;
  lease_token := v_lease_token;
  return next;
end;
$$;

revoke all on function public.claim_next_report_run_item(integer, integer) from public;
grant execute on function public.claim_next_report_run_item(integer, integer) to service_role;

-- Multi-owner resolutions are canonical. Remove the single-owner message and
-- RdA validation aliases after verifying their canonical backfills.
insert into public.mastercrm_whatsapp_qr_message_resolutions (
  message_id,
  owner_id,
  pagina,
  resolution,
  is_primary,
  resolved_at
)
select
  messages.id,
  messages.resolved_owner_id,
  messages.resolved_pagina,
  coalesce(nullif(btrim(messages.route_resolution), ''), 'legacy_single_route_backfill'),
  true,
  coalesce(messages.route_resolved_at, messages.event_at, messages.created_at)
from public.mastercrm_whatsapp_qr_messages messages
where messages.route_status = 'resolved'
  and messages.resolved_owner_id is not null
  and messages.resolved_pagina in ('ASN', 'RdA')
  and not exists (
    select 1
    from public.mastercrm_whatsapp_qr_message_resolutions resolutions
    where resolutions.message_id = messages.id
      and resolutions.owner_id = messages.resolved_owner_id
  )
on conflict (message_id, owner_id) do nothing;

do $$
begin
  if exists (
    select 1 from public.mastercrm_whatsapp_qr_messages messages
    where messages.route_status = 'resolved'
      and not exists (
        select 1 from public.mastercrm_whatsapp_qr_message_resolutions resolutions
        where resolutions.message_id = messages.id
      )
  ) then
    raise exception using message = 'cannot remove QR legacy columns: unresolved canonical backfill';
  end if;
end;
$$;

drop view if exists public.mastercrm_whatsapp_qr_messages_by_owner;
drop function if exists public.set_whatsapp_qr_message_route_v1(uuid, text, uuid, text);
drop function if exists public.set_whatsapp_qr_message_routes_v1(uuid, text, uuid[], text);
alter table public.mastercrm_whatsapp_qr_messages
  drop constraint if exists mastercrm_whatsapp_qr_messages_route_resolution_check;
alter table public.mastercrm_whatsapp_qr_messages
  drop constraint if exists mastercrm_whatsapp_qr_messages_resolved_pagina_check;
alter table public.mastercrm_whatsapp_qr_messages drop column if exists resolved_owner_id;
alter table public.mastercrm_whatsapp_qr_messages drop column if exists resolved_pagina;
alter table public.mastercrm_whatsapp_qr_matches drop column if exists rda_validated_at;

create function public.set_whatsapp_qr_message_routes_v1(
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
  select * into v_message from public.mastercrm_whatsapp_qr_messages
  where id = p_message_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'WhatsApp QR message not found'; end if;

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
      and routes.owner_id = any(v_owner_ids) and routes.status = 'active';
    if v_route_count <> cardinality(v_owner_ids) then
      raise exception using errcode = '23503', message = 'owner is not an active route for QR session';
    end if;
    if cardinality(v_owner_ids) = 2 then
      select count(*) into v_pair_count
      from public.mastercrm_platform_owner_pairs pairs
      where pairs.rda_owner_id = any(v_owner_ids)
        and pairs.asn_owner_id = any(v_owner_ids)
        and pairs.active_from <= now() and (pairs.active_to is null or pairs.active_to > now());
      if v_pair_count <> 1 then raise exception using errcode = '23514', message = 'QR_PAIR_NOT_CONFIGURED'; end if;
    end if;
    select coalesce(array_agg(owner_id order by owner_id), '{}'::uuid[])
    into v_existing_owner_ids
    from public.mastercrm_whatsapp_qr_message_resolutions where message_id = p_message_id;
    if cardinality(v_existing_owner_ids) > 0 and v_existing_owner_ids <> v_owner_ids then
      raise exception using errcode = '23505', message = 'QR message already resolved to another route';
    end if;
    select * into v_primary_route
    from public.mastercrm_whatsapp_qr_session_routes routes
    where routes.session_id = v_message.session_id
      and routes.owner_id = any(v_owner_ids) and routes.status = 'active'
    order by routes.is_primary desc, routes.created_at, routes.id limit 1;

    insert into public.mastercrm_whatsapp_qr_message_resolutions
      (message_id, owner_id, pagina, resolution, is_primary, resolved_at)
    select p_message_id, routes.owner_id, routes.pagina,
      coalesce(nullif(btrim(p_resolution), ''), 'automatic_route'),
      routes.owner_id = v_primary_route.owner_id, coalesce(v_message.route_resolved_at, now())
    from public.mastercrm_whatsapp_qr_session_routes routes
    where routes.session_id = v_message.session_id
      and routes.owner_id = any(v_owner_ids) and routes.status = 'active'
    on conflict (message_id, owner_id) do update
      set resolution = excluded.resolution, is_primary = excluded.is_primary;

    update public.mastercrm_whatsapp_qr_messages
    set owner_id = v_primary_route.owner_id, route_status = 'resolved',
        route_resolution = nullif(btrim(p_resolution), ''),
        route_resolved_at = coalesce(route_resolved_at, now())
    where id = p_message_id returning * into v_message;
  else
    if exists (select 1 from public.mastercrm_whatsapp_qr_message_resolutions where message_id = p_message_id) then
      raise exception using errcode = '23505', message = 'resolved QR message cannot be moved back to review';
    end if;
    update public.mastercrm_whatsapp_qr_messages
    set route_status = p_status, route_resolution = nullif(btrim(p_resolution), ''), route_resolved_at = null
    where id = p_message_id returning * into v_message;
  end if;
  return next v_message;
end;
$$;

create view public.mastercrm_whatsapp_qr_messages_by_owner as
select messages.*,
  coalesce(resolutions.owner_id, messages.owner_id) scope_owner_id,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'owner_id', all_resolutions.owner_id,
      'pagina', all_resolutions.pagina,
      'resolution', all_resolutions.resolution,
      'is_primary', all_resolutions.is_primary,
      'resolved_at', all_resolutions.resolved_at
    ) order by all_resolutions.is_primary desc, all_resolutions.pagina, all_resolutions.owner_id)
    from public.mastercrm_whatsapp_qr_message_resolutions all_resolutions
    where all_resolutions.message_id = messages.id
  ), '[]'::jsonb) resolved_owners
from public.mastercrm_whatsapp_qr_messages messages
left join public.mastercrm_whatsapp_qr_message_resolutions resolutions
  on resolutions.message_id = messages.id;

revoke all on public.mastercrm_whatsapp_qr_messages_by_owner from public;
grant select on public.mastercrm_whatsapp_qr_messages_by_owner to service_role;
revoke all on function public.set_whatsapp_qr_message_routes_v1(uuid, text, uuid[], text) from public;
grant execute on function public.set_whatsapp_qr_message_routes_v1(uuid, text, uuid[], text) to service_role;

commit;
