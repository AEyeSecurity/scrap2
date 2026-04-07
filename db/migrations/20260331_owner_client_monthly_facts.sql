alter table public.owner_client_events
  add column if not exists occurred_at timestamptz null;

update public.owner_client_events
set occurred_at = created_at
where occurred_at is null;

alter table public.owner_client_events
  alter column occurred_at set not null;

alter table public.owner_client_events
  drop constraint if exists owner_client_events_event_type_check;

alter table public.owner_client_events
  drop constraint if exists ck_owner_client_events_event_type;

alter table public.owner_client_events
  add constraint ck_owner_client_events_event_type check (
    event_type in ('intake', 'link_sent', 'create_player', 'assign_username', 'unassign_username')
  );

create index if not exists ix_owner_client_events_owner_occurred_at
  on public.owner_client_events (owner_id, occurred_at desc);

create index if not exists ix_owner_client_events_client_occurred_at
  on public.owner_client_events (client_id, occurred_at desc);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'report_daily_snapshots'
      and column_name = 'identity_id'
      and is_nullable = 'YES'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'report_daily_snapshots.identity_id must be non-null before monthly facts migration';
  end if;
end;
$$;

delete from public.report_daily_snapshots s
using (
  select id
  from (
    select
      id,
      row_number() over (
        partition by report_date, identity_id
        order by created_at desc, id desc
      ) as row_rank
    from public.report_daily_snapshots
  ) ranked
  where ranked.row_rank > 1
) duplicated
where s.id = duplicated.id;

alter table public.report_daily_snapshots
  drop constraint if exists uq_report_daily_snapshots_date_username;

alter table public.report_daily_snapshots
  drop constraint if exists uq_report_daily_snapshots_date_pagina_username;

alter table public.report_daily_snapshots
  drop constraint if exists uq_report_daily_snapshots_date_identity;

alter table public.report_daily_snapshots
  add constraint uq_report_daily_snapshots_date_identity unique (report_date, identity_id);

create table if not exists public.owner_client_monthly_facts (
  owner_id uuid not null references public.owners(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  link_id uuid not null references public.owner_client_links(id) on delete cascade,
  month_start date not null,
  status_at_month_end text not null check (status_at_month_end in ('assigned', 'pending')),
  identity_id_at_month_end uuid null references public.owner_client_identities(id) on delete set null,
  username_at_month_end text null,
  in_portfolio_at_month_end boolean not null default true,
  had_intake_in_month boolean not null default false,
  is_new_intake_in_month boolean not null default false,
  is_reentry_in_month boolean not null default false,
  had_assignment_in_month boolean not null default false,
  assigned_from_backlog_in_month boolean not null default false,
  first_intake_at timestamptz null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint pk_owner_client_monthly_facts primary key (owner_id, client_id, month_start),
  constraint ck_owner_client_monthly_facts_month_start check (
    month_start = date_trunc('month', month_start::timestamp)::date
  )
);

create index if not exists ix_owner_client_monthly_facts_owner_month
  on public.owner_client_monthly_facts (owner_id, month_start);

create index if not exists ix_owner_client_monthly_facts_link_month
  on public.owner_client_monthly_facts (link_id, month_start);

alter table public.owner_client_monthly_facts enable row level security;

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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_occurred_at timestamptz := now();
  v_received_at text;
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

  v_received_at := nullif(
    coalesce(
      v_payload ->> 'occurred_at',
      v_payload ->> 'OccurredAt',
      v_payload ->> 'ReceivedAt',
      v_payload -> 'source_context' ->> 'receivedAt',
      v_payload -> 'source_context' ->> 'ReceivedAt'
    ),
    ''
  );

  if v_received_at is not null then
    begin
      v_occurred_at := v_received_at::timestamptz;
    exception
      when others then
        v_occurred_at := now();
    end;
  end if;

  insert into public.owner_client_events (
    owner_id,
    client_id,
    alias_id,
    actor_alias,
    actor_phone,
    event_type,
    payload,
    occurred_at
  )
  values (
    p_owner_id,
    p_client_id,
    p_alias_id,
    v_actor_alias,
    v_actor_phone,
    p_event_type,
    v_payload,
    v_occurred_at
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

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
      nullif(v_source_context ->> 'profileName', ''),
      'ClientIpAddress',
      nullif(v_source_context ->> 'clientIpAddress', ''),
      'ClientUserAgent',
      nullif(v_source_context ->> 'clientUserAgent', ''),
      'ReceivedAt',
      nullif(v_source_context ->> 'receivedAt', '')
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

create or replace function public.refresh_owner_client_monthly_facts_v1(
  p_owner_id uuid,
  p_month_start date default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start date;
  v_current_month_start date := date_trunc('month', timezone('America/Argentina/Buenos_Aires', now()))::date;
begin
  if p_owner_id is null then
    raise exception using
      errcode = '22023',
      message = 'owner_id is required';
  end if;

  if p_month_start is not null then
    v_month_start := date_trunc('month', p_month_start::timestamp)::date;
    if v_month_start <> p_month_start then
      raise exception using
        errcode = '22023',
        message = 'month_start must be the first day of the month';
    end if;
  else
    v_month_start := null;
  end if;

  delete from public.owner_client_monthly_facts
  where owner_id = p_owner_id
    and (v_month_start is null or month_start = v_month_start);

  insert into public.owner_client_monthly_facts (
    owner_id,
    client_id,
    link_id,
    month_start,
    status_at_month_end,
    identity_id_at_month_end,
    username_at_month_end,
    in_portfolio_at_month_end,
    had_intake_in_month,
    is_new_intake_in_month,
    is_reentry_in_month,
    had_assignment_in_month,
    assigned_from_backlog_in_month,
    first_intake_at,
    first_seen_at,
    last_seen_at,
    updated_at
  )
  with link_scope as (
    select
      l.id as link_id,
      l.owner_id,
      l.client_id,
      l.first_seen_at,
      l.last_seen_at
    from public.owner_client_links l
    where l.owner_id = p_owner_id
  ),
  generated_months as (
    select
      ls.owner_id,
      ls.client_id,
      ls.link_id,
      ls.first_seen_at,
      ls.last_seen_at,
      generated.month_start::date as month_start
    from link_scope ls
    cross join lateral generate_series(
      date_trunc('month', timezone('America/Argentina/Buenos_Aires', ls.first_seen_at))::timestamp,
      v_current_month_start::timestamp,
      interval '1 month'
    ) as generated(month_start)
    where v_month_start is null or generated.month_start::date = v_month_start
  ),
  fact_months as (
    select
      gm.owner_id,
      gm.client_id,
      gm.link_id,
      gm.first_seen_at,
      gm.last_seen_at,
      gm.month_start,
      (gm.month_start::timestamp at time zone 'America/Argentina/Buenos_Aires') as month_start_ts,
      ((gm.month_start + interval '1 month')::timestamp at time zone 'America/Argentina/Buenos_Aires') as next_month_start_ts,
      case
        when gm.month_start = v_current_month_start then now()
        else (((gm.month_start + interval '1 month')::timestamp at time zone 'America/Argentina/Buenos_Aires') - interval '1 microsecond')
      end as as_of_ts
    from generated_months gm
  ),
  first_intakes as (
    select
      e.owner_id,
      e.client_id,
      min(e.occurred_at) as first_intake_at
    from public.owner_client_events e
    where e.owner_id = p_owner_id
      and e.event_type = 'intake'
    group by e.owner_id, e.client_id
  ),
  event_months as (
    select
      e.owner_id,
      e.client_id,
      date_trunc('month', timezone('America/Argentina/Buenos_Aires', e.occurred_at))::date as month_start,
      bool_or(e.event_type = 'intake') as had_intake_in_month,
      bool_or(e.event_type = 'assign_username') as had_assignment_in_month
    from public.owner_client_events e
    where e.owner_id = p_owner_id
      and e.event_type in ('intake', 'assign_username')
    group by
      e.owner_id,
      e.client_id,
      date_trunc('month', timezone('America/Argentina/Buenos_Aires', e.occurred_at))::date
  )
  select
    fm.owner_id,
    fm.client_id,
    fm.link_id,
    fm.month_start,
    case when active_identity.identity_id is null then 'pending' else 'assigned' end as status_at_month_end,
    active_identity.identity_id as identity_id_at_month_end,
    active_identity.username as username_at_month_end,
    true as in_portfolio_at_month_end,
    coalesce(em.had_intake_in_month, false) as had_intake_in_month,
    coalesce(
      fi.first_intake_at is not null
      and fi.first_intake_at >= fm.month_start_ts
      and fi.first_intake_at < fm.next_month_start_ts,
      false
    ) as is_new_intake_in_month,
    coalesce(em.had_intake_in_month, false)
      and fi.first_intake_at is not null
      and fi.first_intake_at < fm.month_start_ts as is_reentry_in_month,
    coalesce(em.had_assignment_in_month, false) as had_assignment_in_month,
    coalesce(em.had_assignment_in_month, false)
      and fi.first_intake_at is not null
      and fi.first_intake_at < fm.month_start_ts as assigned_from_backlog_in_month,
    fi.first_intake_at,
    fm.first_seen_at,
    fm.last_seen_at,
    now() as updated_at
  from fact_months fm
  left join first_intakes fi
    on fi.owner_id = fm.owner_id
   and fi.client_id = fm.client_id
  left join event_months em
    on em.owner_id = fm.owner_id
   and em.client_id = fm.client_id
   and em.month_start = fm.month_start
  left join lateral (
    select
      i.id as identity_id,
      i.username
    from public.owner_client_identities i
    where i.owner_client_link_id = fm.link_id
      and i.valid_from <= fm.as_of_ts
      and coalesce(i.valid_to, 'infinity'::timestamptz) > fm.as_of_ts
    order by i.valid_from desc, i.created_at desc, i.id desc
    limit 1
  ) active_identity on true;
end;
$$;

do $$
declare
  owner_row record;
begin
  for owner_row in
    select id
    from public.owners
  loop
    perform public.refresh_owner_client_monthly_facts_v1(owner_row.id, null);
  end loop;
end;
$$;

revoke all on function public.append_owner_client_event_v4(uuid, uuid, uuid, text, text, text, jsonb) from public;
grant execute on function public.append_owner_client_event_v4(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

revoke all on function public.intake_pending_cliente_v4(text, text, text, text, text, text, jsonb) from public;
grant execute on function public.intake_pending_cliente_v4(text, text, text, text, text, text, jsonb) to service_role;

revoke all on function public.refresh_owner_client_monthly_facts_v1(uuid, date) from public;
grant execute on function public.refresh_owner_client_monthly_facts_v1(uuid, date) to service_role;
