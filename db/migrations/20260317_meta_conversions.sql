begin;

create table if not exists public.meta_conversion_outbox (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  event_stage text not null check (event_stage in ('lead', 'qualified_lead')),
  meta_event_name text not null check (meta_event_name in ('Lead', 'CompleteRegistration')),
  event_id text not null check (btrim(event_id) <> ''),
  status text not null check (status in ('pending', 'leased', 'retry_wait', 'sent', 'failed')) default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 5,
  lease_until timestamptz null,
  next_retry_at timestamptz null,
  event_time timestamptz not null,
  phone_e164 text null,
  username text null,
  source_payload jsonb not null default '{}'::jsonb,
  last_error text null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_meta_conversion_outbox_owner_client_stage unique (owner_id, client_id, event_stage)
);

drop trigger if exists trg_meta_conversion_outbox_set_updated_at on public.meta_conversion_outbox;
create trigger trg_meta_conversion_outbox_set_updated_at
before update on public.meta_conversion_outbox
for each row execute function public.set_updated_at();

create index if not exists ix_meta_conversion_outbox_status_retry
  on public.meta_conversion_outbox (status, next_retry_at);
create index if not exists ix_meta_conversion_outbox_status_lease
  on public.meta_conversion_outbox (status, lease_until);
create index if not exists ix_meta_conversion_outbox_event_time
  on public.meta_conversion_outbox (event_time asc, created_at asc);

alter table public.meta_conversion_outbox enable row level security;

create or replace function public.intake_pending_cliente_v4(
  p_owner_key text,
  p_cliente_telefono text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null,
  p_source_context jsonb default null
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
  v_source_context jsonb := coalesce(p_source_context, '{}'::jsonb);
  v_payload jsonb;
begin
  if p_source_context is not null and jsonb_typeof(p_source_context) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'source_context must be a JSON object';
  end if;

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

  v_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'owner_key',
      v_owner_key,
      'owner_label',
      coalesce(p_owner_label, v_owner_key),
      'source_context',
      case when v_source_context = '{}'::jsonb then null else v_source_context end,
      'ReferralCtwaClid',
      nullif(v_source_context ->> 'ctwaClid', ''),
      'ReferralSourceId',
      nullif(v_source_context ->> 'referralSourceId', ''),
      'ReferralSourceUrl',
      nullif(v_source_context ->> 'referralSourceUrl', ''),
      'ReferralHeadline',
      nullif(v_source_context ->> 'referralHeadline', ''),
      'ReferralBody',
      nullif(v_source_context ->> 'referralBody', ''),
      'ReferralSourceType',
      nullif(v_source_context ->> 'referralSourceType', ''),
      'WaId',
      nullif(v_source_context ->> 'waId', ''),
      'MessageSid',
      nullif(v_source_context ->> 'messageSid', ''),
      'AccountSid',
      nullif(v_source_context ->> 'accountSid', ''),
      'ProfileName',
      nullif(v_source_context ->> 'profileName', '')
    )
  );

  perform public.append_owner_client_event_v4(
    v_owner_id,
    v_client_id,
    v_alias_id,
    p_actor_alias,
    p_actor_phone,
    'intake',
    v_payload
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

create or replace function public.enqueue_meta_qualified_leads(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  insert into public.meta_conversion_outbox (
    owner_id,
    client_id,
    event_stage,
    meta_event_name,
    event_id,
    status,
    event_time,
    phone_e164,
    username,
    source_payload
  )
  with attributable_intakes as (
    select distinct on (e.owner_id, e.client_id)
      e.owner_id,
      e.client_id,
      e.payload,
      e.created_at
    from public.owner_client_events e
    where e.event_type = 'intake'
      and lower(coalesce(e.payload ->> 'ReferralSourceType', e.payload -> 'source_context' ->> 'referralSourceType', '')) = 'ad'
      and nullif(coalesce(e.payload ->> 'ReferralCtwaClid', e.payload -> 'source_context' ->> 'ctwaClid', ''), '') is not null
    order by e.owner_id, e.client_id, e.created_at asc
  ),
  qualified_candidates as (
    select
      ai.owner_id,
      ai.client_id,
      c.phone_e164,
      oci.username,
      ai.payload,
      first_snapshot.created_at as event_time
    from attributable_intakes ai
    join public.owner_client_links ocl
      on ocl.owner_id = ai.owner_id
     and ocl.client_id = ai.client_id
     and ocl.status = 'assigned'
    join public.owner_client_identities oci
      on oci.owner_client_link_id = ocl.id
     and oci.is_active = true
    join public.clients c
      on c.id = ai.client_id
    join lateral (
      select rds.created_at
      from public.report_daily_snapshots rds
      where rds.owner_id = ai.owner_id
        and rds.client_id = ai.client_id
        and rds.cargado_mes > 0
      order by rds.report_date asc, rds.created_at asc
      limit 1
    ) as first_snapshot on true
    where not exists (
      select 1
      from public.meta_conversion_outbox mco
      where mco.owner_id = ai.owner_id
        and mco.client_id = ai.client_id
        and mco.event_stage = 'qualified_lead'
    )
    order by first_snapshot.created_at asc
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  )
  select
    qc.owner_id,
    qc.client_id,
    'qualified_lead',
    'CompleteRegistration',
    'qualified_lead:' || md5(qc.owner_id::text || ':' || qc.client_id::text),
    'pending',
    qc.event_time,
    qc.phone_e164,
    qc.username,
    jsonb_strip_nulls(qc.payload || jsonb_build_object('username', qc.username, 'phone_e164', qc.phone_e164))
  from qualified_candidates qc
  on conflict on constraint uq_meta_conversion_outbox_owner_client_stage do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.claim_next_meta_conversion_outbox(
  p_lease_seconds integer default 60,
  p_max_attempts integer default 5
)
returns table (
  id uuid,
  owner_id uuid,
  client_id uuid,
  event_stage text,
  meta_event_name text,
  event_id text,
  event_time timestamptz,
  phone_e164 text,
  username text,
  source_payload jsonb,
  attempts integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select m.id
    from public.meta_conversion_outbox m
    where m.status in ('pending', 'retry_wait')
      and (m.next_retry_at is null or m.next_retry_at <= now())
      and (m.lease_until is null or m.lease_until <= now())
      and m.attempts < least(m.max_attempts, greatest(1, coalesce(p_max_attempts, m.max_attempts)))
    order by m.event_time asc, m.created_at asc
    limit 1
    for update skip locked
  )
  update public.meta_conversion_outbox m
  set status = 'leased',
      attempts = m.attempts + 1,
      lease_until = now() + make_interval(secs => greatest(1, coalesce(p_lease_seconds, 60))),
      last_error = null
  from candidate
  where m.id = candidate.id
  returning
    m.id,
    m.owner_id,
    m.client_id,
    m.event_stage,
    m.meta_event_name,
    m.event_id,
    m.event_time,
    m.phone_e164,
    m.username,
    m.source_payload,
    m.attempts,
    m.max_attempts;
end;
$$;

revoke all on table public.meta_conversion_outbox from public;
grant select, insert, update on table public.meta_conversion_outbox to service_role;

revoke all on function public.intake_pending_cliente_v4(text, text, text, text, text, text, jsonb) from public;
revoke all on function public.enqueue_meta_qualified_leads(integer) from public;
revoke all on function public.claim_next_meta_conversion_outbox(integer, integer) from public;

grant execute on function public.intake_pending_cliente_v4(text, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.enqueue_meta_qualified_leads(integer) to service_role;
grant execute on function public.claim_next_meta_conversion_outbox(integer, integer) to service_role;

commit;
