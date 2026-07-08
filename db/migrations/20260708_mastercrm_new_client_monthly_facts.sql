create table if not exists public.owner_new_client_monthly_facts (
  owner_id uuid not null references public.owners(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  link_id uuid not null references public.owner_client_links(id) on delete cascade,
  month_start date not null,
  first_intake_at timestamptz null,
  status_at_month_end text not null check (status_at_month_end in ('assigned', 'pending')),
  username_at_month_end text null,
  phone_e164 text null,
  cargado_hoy_ars numeric(14, 2) not null default 0,
  cargado_mes_ars numeric(14, 2) not null default 0,
  report_date date null,
  has_report boolean not null default false,
  finalized_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pk_owner_new_client_monthly_facts primary key (owner_id, client_id, month_start),
  constraint ck_owner_new_client_monthly_facts_month_start check (
    month_start = date_trunc('month', month_start::timestamp)::date
  )
);

create index if not exists ix_owner_new_client_monthly_facts_owner_month
  on public.owner_new_client_monthly_facts (owner_id, month_start);

alter table public.owner_new_client_monthly_facts enable row level security;

revoke all on table public.owner_new_client_monthly_facts from public;
grant select, insert, update, delete on table public.owner_new_client_monthly_facts to service_role;

create or replace function public.refresh_mastercrm_new_client_monthly_facts_v1(
  p_owner_id uuid,
  p_month_start date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start date;
  v_next_month_start date;
  v_rows integer := 0;
begin
  if p_owner_id is null then
    raise exception using errcode = '22023', message = 'owner_id is required';
  end if;

  if p_month_start is null then
    raise exception using errcode = '22023', message = 'month_start is required';
  end if;

  v_month_start := date_trunc('month', p_month_start::timestamp)::date;
  v_next_month_start := (v_month_start + interval '1 month')::date;

  delete from public.owner_new_client_monthly_facts
  where owner_id = p_owner_id
    and month_start = v_month_start;

  insert into public.owner_new_client_monthly_facts (
    owner_id,
    client_id,
    link_id,
    month_start,
    first_intake_at,
    status_at_month_end,
    username_at_month_end,
    phone_e164,
    cargado_hoy_ars,
    cargado_mes_ars,
    report_date,
    has_report,
    finalized_at,
    updated_at
  )
  select
    facts.owner_id,
    facts.client_id,
    facts.link_id,
    facts.month_start,
    facts.first_intake_at,
    facts.status_at_month_end,
    facts.username_at_month_end,
    clients.phone_e164,
    coalesce(snapshots.cargado_hoy_ars, 0),
    coalesce(snapshots.cargado_mes_ars, 0),
    snapshots.report_date,
    snapshots.report_date is not null,
    now(),
    now()
  from public.owner_client_monthly_facts facts
  join public.clients clients on clients.id = facts.client_id
  left join lateral (
    select
      daily.report_date,
      sum(coalesce(daily.cargado_hoy, 0))::numeric(14, 2) as cargado_hoy_ars,
      sum(coalesce(daily.cargado_mes, 0))::numeric(14, 2) as cargado_mes_ars
    from public.report_daily_snapshots daily
    where daily.owner_id = facts.owner_id
      and daily.client_id = facts.client_id
      and daily.report_date = (
        select max(last_daily.report_date)
        from public.report_daily_snapshots last_daily
        where last_daily.owner_id = facts.owner_id
          and last_daily.client_id = facts.client_id
          and last_daily.report_date >= v_month_start
          and last_daily.report_date < v_next_month_start
      )
    group by daily.report_date
  ) snapshots on true
  where facts.owner_id = p_owner_id
    and facts.month_start = v_month_start
    and facts.is_new_intake_in_month = true;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.refresh_mastercrm_closed_new_client_monthly_facts_v1(
  p_cutoff_date date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  month_row record;
  v_total integer := 0;
begin
  if p_cutoff_date is null then
    raise exception using errcode = '22023', message = 'cutoff_date is required';
  end if;

  for month_row in
    select distinct owner_id, month_start
    from public.owner_client_monthly_facts
    where month_start >= date '2026-07-01'
      and month_start < date_trunc('month', p_cutoff_date::timestamp)::date
      and is_new_intake_in_month = true
  loop
    v_total := v_total + public.refresh_mastercrm_new_client_monthly_facts_v1(
      month_row.owner_id,
      month_row.month_start
    );
  end loop;

  return v_total;
end;
$$;

revoke all on function public.refresh_mastercrm_new_client_monthly_facts_v1(uuid, date) from public;
revoke all on function public.refresh_mastercrm_closed_new_client_monthly_facts_v1(date) from public;
grant execute on function public.refresh_mastercrm_new_client_monthly_facts_v1(uuid, date) to service_role;
grant execute on function public.refresh_mastercrm_closed_new_client_monthly_facts_v1(date) to service_role;
