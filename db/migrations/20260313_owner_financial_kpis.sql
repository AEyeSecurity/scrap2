begin;

create table if not exists public.owner_financial_settings (
  owner_id uuid primary key references public.owners(id) on delete cascade,
  commission_pct numeric(5,2) not null check (commission_pct >= 0 and commission_pct <= 100),
  updated_by_mastercrm_user_id bigint null references public.mastercrm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_owner_financial_settings_set_updated_at on public.owner_financial_settings;
create trigger trg_owner_financial_settings_set_updated_at
before update on public.owner_financial_settings
for each row execute function public.set_updated_at();

create table if not exists public.owner_monthly_ad_spend (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  month_start date not null check (month_start = date_trunc('month', month_start)::date),
  ad_spend_ars numeric(14,2) not null check (ad_spend_ars >= 0),
  updated_by_mastercrm_user_id bigint null references public.mastercrm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_owner_monthly_ad_spend_owner_month unique (owner_id, month_start)
);

create index if not exists ix_owner_monthly_ad_spend_owner_month
  on public.owner_monthly_ad_spend (owner_id, month_start desc);

drop trigger if exists trg_owner_monthly_ad_spend_set_updated_at on public.owner_monthly_ad_spend;
create trigger trg_owner_monthly_ad_spend_set_updated_at
before update on public.owner_monthly_ad_spend
for each row execute function public.set_updated_at();

alter table public.owner_financial_settings enable row level security;
alter table public.owner_monthly_ad_spend enable row level security;

commit;
