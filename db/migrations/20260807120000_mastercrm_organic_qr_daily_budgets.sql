begin;

create table if not exists public.owner_organic_qr_daily_budgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  daily_budget_ars numeric(14,2) not null check (daily_budget_ars >= 0),
  active_from date not null,
  active_to date null,
  updated_by_mastercrm_user_id bigint null references public.mastercrm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_owner_organic_qr_daily_budgets_active_window
    check (active_to is null or active_to >= active_from)
);

create index if not exists ix_owner_organic_qr_daily_budgets_owner_active
  on public.owner_organic_qr_daily_budgets (owner_id, active_from, active_to);

create or replace function public.prevent_owner_organic_qr_budget_overlap_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 0));

  if exists (
    select 1
    from public.owner_organic_qr_daily_budgets existing
    where existing.owner_id = new.owner_id
      and existing.id <> new.id
      and existing.active_from <= coalesce(new.active_to, 'infinity'::date)
      and new.active_from <= coalesce(existing.active_to, 'infinity'::date)
  ) then
    raise exception using
      errcode = '23P01',
      message = 'Organic QR budget overlaps an existing period';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_owner_organic_qr_daily_budgets_no_overlap
  on public.owner_organic_qr_daily_budgets;
create trigger trg_owner_organic_qr_daily_budgets_no_overlap
before insert or update of owner_id, active_from, active_to
on public.owner_organic_qr_daily_budgets
for each row execute function public.prevent_owner_organic_qr_budget_overlap_v1();

drop trigger if exists trg_owner_organic_qr_daily_budgets_set_updated_at
  on public.owner_organic_qr_daily_budgets;
create trigger trg_owner_organic_qr_daily_budgets_set_updated_at
before update on public.owner_organic_qr_daily_budgets
for each row execute function public.set_updated_at();

create or replace function public.upsert_owner_organic_qr_daily_budget_v1(
  p_owner_id uuid,
  p_mastercrm_user_id bigint,
  p_budget_id uuid,
  p_daily_budget_ars numeric,
  p_active_from date,
  p_active_to date
)
returns table (
  id uuid,
  daily_budget_ars numeric,
  active_from date,
  active_to date,
  updated_at timestamptz
)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_owner_id is null or p_mastercrm_user_id is null then
    raise exception using errcode = '22023', message = 'owner and mastercrm user are required';
  end if;
  if p_daily_budget_ars is null or p_daily_budget_ars < 0 then
    raise exception using errcode = '22023', message = 'daily budget must be positive or zero';
  end if;
  if p_active_from is null or (p_active_to is not null and p_active_to < p_active_from) then
    raise exception using errcode = '22023', message = 'invalid organic QR budget period';
  end if;

  if p_budget_id is null then
    return query
    insert into public.owner_organic_qr_daily_budgets (
      owner_id,
      daily_budget_ars,
      active_from,
      active_to,
      updated_by_mastercrm_user_id
    ) values (
      p_owner_id,
      round(p_daily_budget_ars, 2),
      p_active_from,
      p_active_to,
      p_mastercrm_user_id
    )
    returning
      owner_organic_qr_daily_budgets.id,
      owner_organic_qr_daily_budgets.daily_budget_ars,
      owner_organic_qr_daily_budgets.active_from,
      owner_organic_qr_daily_budgets.active_to,
      owner_organic_qr_daily_budgets.updated_at;
    return;
  end if;

  return query
  update public.owner_organic_qr_daily_budgets budget
  set daily_budget_ars = round(p_daily_budget_ars, 2),
      active_from = p_active_from,
      active_to = p_active_to,
      updated_by_mastercrm_user_id = p_mastercrm_user_id
  where budget.id = p_budget_id
    and budget.owner_id = p_owner_id
  returning budget.id, budget.daily_budget_ars, budget.active_from, budget.active_to, budget.updated_at;

  if not found then
    raise exception using errcode = '22023', message = 'organic QR budget does not belong to owner';
  end if;
end;
$$;

alter table public.owner_organic_qr_daily_budgets enable row level security;

revoke all on table public.owner_organic_qr_daily_budgets from public;
grant select, insert, update, delete on table public.owner_organic_qr_daily_budgets to service_role;

revoke all on function public.prevent_owner_organic_qr_budget_overlap_v1() from public;
revoke all on function public.upsert_owner_organic_qr_daily_budget_v1(uuid, bigint, uuid, numeric, date, date) from public;
grant execute on function public.upsert_owner_organic_qr_daily_budget_v1(uuid, bigint, uuid, numeric, date, date)
  to service_role;

commit;
