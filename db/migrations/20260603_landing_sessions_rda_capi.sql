begin;

create extension if not exists pgcrypto;

create table if not exists public.landing_sessions (
  id uuid primary key default gen_random_uuid(),
  landing_session_id text not null,
  contact_event_id text not null,
  message_text text not null,
  message_key text not null,
  status text not null default 'pending',
  pagina text not null default 'RdA',
  owner_key text not null,
  owner_label text not null,
  bot_phone_e164 text not null,
  cashier_phone_e164 text not null,
  fbp text null,
  fbc text null,
  fbclid text null,
  event_source_url text null,
  referrer text null,
  utm_source text null,
  utm_medium text null,
  utm_campaign text null,
  utm_content text null,
  utm_term text null,
  client_ip_address text null,
  client_user_agent text null,
  whatsapp_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz null,
  claimed_phone_e164 text null,
  claimed_message_sid text null,
  constraint ck_landing_sessions_status check (status in ('pending', 'claimed', 'expired')),
  constraint ck_landing_sessions_pagina check (pagina in ('ASN', 'RdA'))
);

create unique index if not exists ux_landing_sessions_pending_message_key
  on public.landing_sessions (message_key)
  where status = 'pending';

create index if not exists ix_landing_sessions_session_id
  on public.landing_sessions (landing_session_id);

create index if not exists ix_landing_sessions_status_created
  on public.landing_sessions (status, created_at desc);

alter table public.landing_sessions enable row level security;

alter table public.meta_conversion_outbox
  drop constraint if exists meta_conversion_outbox_event_stage_check,
  drop constraint if exists meta_conversion_outbox_meta_event_name_check;

alter table public.meta_conversion_outbox
  add constraint meta_conversion_outbox_event_stage_check
    check (event_stage in ('lead', 'landing_lead', 'landing_contact', 'qualified_lead', 'value_signal')),
  add constraint meta_conversion_outbox_meta_event_name_check
    check (meta_event_name in ('Lead', 'Contact', 'CompleteRegistration', 'Purchase'));

drop index if exists public.ux_meta_conversion_outbox_lead_attribution;
create unique index ux_meta_conversion_outbox_lead_attribution
  on public.meta_conversion_outbox (owner_id, client_id, event_stage, attribution_key)
  where event_stage in ('lead', 'landing_lead') and attribution_key is not null;

create or replace function public.enqueue_meta_value_signals(
  p_limit integer default 100,
  p_threshold numeric default 10000,
  p_timezone text default 'America/Argentina/Buenos_Aires',
  p_window_mode text default 'intake_local_day'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  if lower(coalesce(p_window_mode, '')) <> 'intake_local_day' then
    raise exception using
      errcode = '22023',
      message = 'Unsupported META_VALUE_SIGNAL_WINDOW_MODE';
  end if;

  insert into public.meta_conversion_outbox (
    owner_id,
    client_id,
    event_stage,
    meta_event_name,
    event_id,
    attribution_key,
    status,
    event_time,
    phone_e164,
    username,
    source_payload,
    qualification_reason,
    qualified_at,
    qualification_report_date,
    qualification_value
  )
  with attributable_intakes as (
    select
      e.owner_id,
      e.client_id,
      e.payload,
      e.created_at,
      lower(
        coalesce(
          nullif(e.payload ->> 'ReferralCtwaClid', ''),
          nullif(e.payload -> 'source_context' ->> 'ctwaClid', ''),
          case
            when nullif(coalesce(e.payload ->> 'LandingSessionId', e.payload -> 'source_context' ->> 'landingSessionId', ''), '') is not null
              then 'landing:' || coalesce(e.payload ->> 'LandingSessionId', e.payload -> 'source_context' ->> 'landingSessionId')
            else null
          end
        )
      ) as attribution_key,
      ((e.created_at at time zone p_timezone))::date as intake_local_date
    from public.owner_client_events e
    where e.event_type = 'intake'
      and (
        (
          lower(coalesce(e.payload ->> 'ReferralSourceType', e.payload -> 'source_context' ->> 'referralSourceType', '')) = 'ad'
          and nullif(coalesce(e.payload ->> 'ReferralCtwaClid', e.payload -> 'source_context' ->> 'ctwaClid', ''), '') is not null
        )
        or nullif(coalesce(e.payload ->> 'LandingSessionId', e.payload -> 'source_context' ->> 'landingSessionId', ''), '') is not null
      )
  ),
  attributable_days as (
    select distinct
      ai.owner_id,
      ai.client_id,
      ai.intake_local_date
    from attributable_intakes ai
  ),
  best_snapshot_per_day as (
    select distinct on (ad.owner_id, ad.client_id, ad.intake_local_date)
      ad.owner_id,
      ad.client_id,
      ad.intake_local_date,
      rds.report_date,
      rds.created_at as qualification_time,
      rds.cargado_hoy,
      rds.username
    from attributable_days ad
    join public.report_daily_snapshots rds
      on rds.owner_id = ad.owner_id
     and rds.client_id = ad.client_id
     and rds.report_date = ad.intake_local_date
    where exists (
      select 1
      from attributable_intakes ai
      where ai.owner_id = ad.owner_id
        and ai.client_id = ad.client_id
        and ai.intake_local_date = ad.intake_local_date
        and ai.created_at <= rds.created_at
    )
    order by ad.owner_id, ad.client_id, ad.intake_local_date, rds.cargado_hoy desc, rds.created_at desc
  ),
  first_qualifying_day as (
    select distinct on (bspd.owner_id, bspd.client_id)
      bspd.owner_id,
      bspd.client_id,
      bspd.intake_local_date,
      bspd.report_date,
      bspd.qualification_time,
      bspd.cargado_hoy,
      bspd.username
    from best_snapshot_per_day bspd
    where bspd.cargado_hoy >= p_threshold
      and not exists (
        select 1
        from public.meta_conversion_outbox mco
        where mco.owner_id = bspd.owner_id
          and mco.client_id = bspd.client_id
          and mco.event_stage = 'value_signal'
      )
    order by bspd.owner_id, bspd.client_id, bspd.intake_local_date asc, bspd.qualification_time asc
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  ),
  latest_attributable_before_qualification as (
    select distinct on (fqd.owner_id, fqd.client_id)
      fqd.owner_id,
      fqd.client_id,
      fqd.report_date,
      fqd.qualification_time,
      fqd.cargado_hoy,
      fqd.username,
      ai.attribution_key,
      ai.payload
    from first_qualifying_day fqd
    join attributable_intakes ai
      on ai.owner_id = fqd.owner_id
     and ai.client_id = fqd.client_id
     and ai.created_at <= fqd.qualification_time
    order by fqd.owner_id, fqd.client_id, ai.created_at desc
  ),
  qualified_candidates as (
    select
      la.owner_id,
      la.client_id,
      c.phone_e164,
      la.username,
      la.report_date,
      la.qualification_time,
      la.cargado_hoy,
      la.attribution_key,
      jsonb_strip_nulls(
        la.payload || jsonb_build_object(
          'username', la.username,
          'phone_e164', c.phone_e164,
          'first_day_report_date', la.report_date,
          'first_day_cargado_hoy', la.cargado_hoy
        )
      ) as source_payload
    from latest_attributable_before_qualification la
    join public.clients c
      on c.id = la.client_id
  )
  select
    qc.owner_id,
    qc.client_id,
    'value_signal',
    'Purchase',
    'value_signal:' || encode(extensions.digest(convert_to(lower(qc.owner_id::text || ':' || qc.client_id::text), 'UTF8'), 'sha256'::text), 'hex'),
    qc.attribution_key,
    'pending',
    qc.qualification_time,
    qc.phone_e164,
    qc.username,
    qc.source_payload,
    'intake_local_day_threshold',
    qc.qualification_time,
    qc.report_date,
    qc.cargado_hoy
  from qualified_candidates qc
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on table public.landing_sessions from public;
grant select, insert, update on table public.landing_sessions to service_role;

revoke all on function public.enqueue_meta_value_signals(integer, numeric, text, text) from public;
grant execute on function public.enqueue_meta_value_signals(integer, numeric, text, text) to service_role;

commit;
