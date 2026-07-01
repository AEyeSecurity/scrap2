begin;

drop function if exists public.purge_mastercrm_technical_history_v1(date);

create function public.purge_mastercrm_technical_history_v1(
  p_cutoff_date date
)
returns table (
  cutoff_date date,
  report_runs_deleted integer,
  report_run_items_deleted integer,
  report_outbox_deleted integer,
  meta_conversion_outbox_deleted integer,
  landing_sessions_deleted integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff_date date := p_cutoff_date;
  v_current_month_start date := date_trunc('month', timezone('America/Argentina/Buenos_Aires', now()))::date;
  v_landing_cutoff timestamptz;
begin
  if v_cutoff_date is null then
    raise exception using
      errcode = '22023',
      message = 'p_cutoff_date is required';
  end if;

  if v_cutoff_date <> date_trunc('month', v_cutoff_date::timestamp)::date then
    raise exception using
      errcode = '22023',
      message = 'p_cutoff_date must be the first day of a month';
  end if;

  if v_cutoff_date > v_current_month_start then
    raise exception using
      errcode = '22023',
      message = 'p_cutoff_date cannot be after the current Buenos Aires month';
  end if;

  v_landing_cutoff := (v_cutoff_date::timestamp at time zone 'America/Argentina/Buenos_Aires') - interval '48 hours';

  select count(*)::integer
    into report_run_items_deleted
  from public.report_run_items item
  join public.report_runs run on run.id = item.run_id
  where run.report_date < v_cutoff_date;

  select count(*)::integer
    into report_outbox_deleted
  from public.report_outbox outbox
  join public.report_runs run on run.id = outbox.run_id
  where run.report_date < v_cutoff_date;

  with deleted as (
    delete from public.report_runs
    where report_date < v_cutoff_date
    returning 1
  )
  select count(*)::integer
    into report_runs_deleted
  from deleted;

  with deleted as (
    delete from public.meta_conversion_outbox
    where created_at < (v_cutoff_date::timestamp at time zone 'America/Argentina/Buenos_Aires')
      and status in ('sent', 'failed', 'discarded')
    returning 1
  )
  select count(*)::integer
    into meta_conversion_outbox_deleted
  from deleted;

  with deleted as (
    delete from public.landing_sessions
    where created_at < v_landing_cutoff
    returning 1
  )
  select count(*)::integer
    into landing_sessions_deleted
  from deleted;

  cutoff_date := v_cutoff_date;
  return next;
end;
$$;

revoke all on function public.purge_mastercrm_technical_history_v1(date) from public;
grant execute on function public.purge_mastercrm_technical_history_v1(date) to service_role;

commit;
