begin;

create extension if not exists pgcrypto;

alter table public.meta_conversion_outbox
  add column if not exists attribution_key text null;

update public.meta_conversion_outbox
set attribution_key = lower(
  coalesce(
    nullif(source_payload ->> 'ReferralCtwaClid', ''),
    nullif(source_payload -> 'source_context' ->> 'ctwaClid', '')
  )
)
where event_stage = 'lead'
  and attribution_key is null;

alter table public.meta_conversion_outbox
  drop constraint if exists uq_meta_conversion_outbox_owner_client_stage;

drop index if exists public.ux_meta_conversion_outbox_lead_attribution;
create unique index ux_meta_conversion_outbox_lead_attribution
  on public.meta_conversion_outbox (owner_id, client_id, event_stage, attribution_key)
  where event_stage = 'lead' and attribution_key is not null;

drop index if exists public.ux_meta_conversion_outbox_qualified_lead;
create unique index ux_meta_conversion_outbox_qualified_lead
  on public.meta_conversion_outbox (owner_id, client_id, event_stage)
  where event_stage = 'qualified_lead';

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
  with first_qualifying_snapshot as (
    select distinct on (rds.owner_id, rds.client_id)
      rds.owner_id,
      rds.client_id,
      rds.created_at,
      rds.report_date
    from public.report_daily_snapshots rds
    where rds.cargado_mes > 0
    order by rds.owner_id, rds.client_id, rds.report_date asc, rds.created_at asc
  ),
  attributable_intakes as (
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
  latest_attributable_before_qualification as (
    select distinct on (fqs.owner_id, fqs.client_id)
      fqs.owner_id,
      fqs.client_id,
      fqs.created_at as qualification_time,
      ai.payload,
      ai.attribution_key
    from first_qualifying_snapshot fqs
    join attributable_intakes ai
      on ai.owner_id = fqs.owner_id
     and ai.client_id = fqs.client_id
     and ai.created_at <= fqs.created_at
    order by fqs.owner_id, fqs.client_id, ai.created_at desc
  ),
  qualified_candidates as (
    select
      la.owner_id,
      la.client_id,
      c.phone_e164,
      oci.username,
      la.payload,
      la.qualification_time as event_time
    from latest_attributable_before_qualification la
    join public.owner_client_links ocl
      on ocl.owner_id = la.owner_id
     and ocl.client_id = la.client_id
     and ocl.status = 'assigned'
    join public.owner_client_identities oci
      on oci.owner_client_link_id = ocl.id
     and oci.is_active = true
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
    'CompleteRegistration',
    'qualified_lead:' || encode(extensions.digest(convert_to(lower(qc.owner_id::text || ':' || qc.client_id::text), 'UTF8'), 'sha256'::text), 'hex'),
    null,
    'pending',
    qc.event_time,
    qc.phone_e164,
    qc.username,
    jsonb_strip_nulls(qc.payload || jsonb_build_object('username', qc.username, 'phone_e164', qc.phone_e164))
  from qualified_candidates qc
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

commit;
