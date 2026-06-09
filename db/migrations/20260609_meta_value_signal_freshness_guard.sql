begin;

-- Guard de frescura para value signals: Meta CAPI rechaza eventos con
-- event_time mayor a 7 dias (error_subcode 2804003, "event_time too old").
-- La RPC encolaba calificaciones historicas (qualification_time de semanas
-- atras) que fallaban siempre en el dispatch. Solo se encolan calificaciones
-- con menos de 6 dias de antiguedad (1 dia de margen para reintentos del
-- worker antes de cruzar el limite de Meta).

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
  v_window_days integer;
begin
  v_window_days := case lower(coalesce(p_window_mode, ''))
    when 'intake_local_day' then 1
    when 'intake_local_7d' then 7
    else null
  end;

  if v_window_days is null then
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
    select distinct on (ad.owner_id, ad.client_id, rds.report_date)
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
     and rds.report_date >= ad.intake_local_date
     and rds.report_date <= ad.intake_local_date + (v_window_days - 1)
    where exists (
      select 1
      from attributable_intakes ai
      where ai.owner_id = ad.owner_id
        and ai.client_id = ad.client_id
        and ai.intake_local_date = ad.intake_local_date
        and ai.created_at <= rds.created_at
    )
    order by ad.owner_id, ad.client_id, rds.report_date, rds.cargado_hoy desc, rds.created_at desc
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
      and bspd.qualification_time > now() - interval '6 days'
      and not exists (
        select 1
        from public.meta_conversion_outbox mco
        where mco.owner_id = bspd.owner_id
          and mco.client_id = bspd.client_id
          and mco.event_stage = 'value_signal'
      )
    order by bspd.owner_id, bspd.client_id, bspd.report_date asc, bspd.qualification_time asc
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
    lower(p_window_mode) || '_threshold',
    qc.qualification_time,
    qc.report_date,
    qc.cargado_hoy
  from qualified_candidates qc
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.enqueue_meta_value_signals(integer, numeric, text, text) from public;
grant execute on function public.enqueue_meta_value_signals(integer, numeric, text, text) to service_role;

commit;
