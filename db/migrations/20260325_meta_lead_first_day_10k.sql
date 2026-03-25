begin;

create extension if not exists pgcrypto;

delete from public.meta_conversion_outbox
where event_stage in ('lead', 'qualified_lead')
  and status in ('pending', 'leased', 'retry_wait', 'failed');

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
    attribution_key,
    status,
    event_time,
    phone_e164,
    username,
    source_payload
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
          nullif(e.payload -> 'source_context' ->> 'ctwaClid', '')
        )
      ) as attribution_key
    from public.owner_client_events e
    where e.event_type = 'intake'
      and lower(coalesce(e.payload ->> 'ReferralSourceType', e.payload -> 'source_context' ->> 'referralSourceType', '')) = 'ad'
      and nullif(coalesce(e.payload ->> 'ReferralCtwaClid', e.payload -> 'source_context' ->> 'ctwaClid', ''), '') is not null
  ),
  first_observed_snapshot as (
    select distinct on (rds.owner_id, rds.client_id)
      rds.owner_id,
      rds.client_id,
      rds.created_at,
      rds.report_date,
      rds.cargado_hoy,
      rds.username
    from public.report_daily_snapshots rds
    where exists (
      select 1
      from attributable_intakes ai
      where ai.owner_id = rds.owner_id
        and ai.client_id = rds.client_id
        and ai.created_at <= rds.created_at
    )
    order by rds.owner_id, rds.client_id, rds.report_date asc, rds.created_at asc
  ),
  qualifying_first_day as (
    select
      fos.owner_id,
      fos.client_id,
      fos.created_at,
      fos.report_date,
      fos.cargado_hoy,
      fos.username
    from first_observed_snapshot fos
    where fos.cargado_hoy >= 10000
  ),
  latest_attributable_before_first_day as (
    select distinct on (qfd.owner_id, qfd.client_id)
      qfd.owner_id,
      qfd.client_id,
      qfd.created_at as qualification_time,
      qfd.report_date,
      qfd.cargado_hoy,
      qfd.username,
      ai.payload
    from qualifying_first_day qfd
    join attributable_intakes ai
      on ai.owner_id = qfd.owner_id
     and ai.client_id = qfd.client_id
     and ai.created_at <= qfd.created_at
    order by qfd.owner_id, qfd.client_id, ai.created_at desc
  ),
  qualified_candidates as (
    select
      la.owner_id,
      la.client_id,
      c.phone_e164,
      la.username,
      la.report_date,
      la.cargado_hoy,
      la.payload,
      la.qualification_time as event_time
    from latest_attributable_before_first_day la
    join public.clients c
      on c.id = la.client_id
    where not exists (
      select 1
      from public.meta_conversion_outbox mco
      where mco.owner_id = la.owner_id
        and mco.client_id = la.client_id
        and mco.event_stage = 'qualified_lead'
    )
    order by la.qualification_time asc
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  )
  select
    qc.owner_id,
    qc.client_id,
    'qualified_lead',
    'Lead',
    'qualified_lead:' || encode(extensions.digest(convert_to(lower(qc.owner_id::text || ':' || qc.client_id::text), 'UTF8'), 'sha256'::text), 'hex'),
    null,
    'pending',
    qc.event_time,
    qc.phone_e164,
    qc.username,
    jsonb_strip_nulls(
      qc.payload || jsonb_build_object(
        'username',
        qc.username,
        'phone_e164',
        qc.phone_e164,
        'first_day_report_date',
        qc.report_date,
        'first_day_cargado_hoy',
        qc.cargado_hoy
      )
    )
  from qualified_candidates qc
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

commit;
