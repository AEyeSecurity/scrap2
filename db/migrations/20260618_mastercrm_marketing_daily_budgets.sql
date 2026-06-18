begin;

create table if not exists public.owner_marketing_daily_budgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  channel text not null check (channel in ('landing', 'meta_ctwa')),
  level text not null check (level in ('campaign', 'ad')),
  campaign_key text not null check (campaign_key = btrim(campaign_key) and campaign_key <> ''),
  campaign_name text not null check (campaign_name = btrim(campaign_name) and campaign_name <> ''),
  ad_key text not null default '',
  ad_name text null,
  link_url text null,
  daily_budget_ars numeric(14,2) not null check (daily_budget_ars >= 0),
  active_from date not null,
  active_to date null,
  updated_by_mastercrm_user_id bigint null references public.mastercrm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_owner_marketing_daily_budgets_active_window check (active_to is null or active_to >= active_from),
  constraint ck_owner_marketing_daily_budgets_ad_level check (
    (level = 'campaign' and ad_key = '')
    or (level = 'ad' and ad_key <> '')
  ),
  constraint uq_owner_marketing_daily_budgets_scope unique (
    owner_id,
    channel,
    level,
    campaign_key,
    ad_key,
    active_from
  )
);

create index if not exists ix_owner_marketing_daily_budgets_owner_active
  on public.owner_marketing_daily_budgets (owner_id, active_from desc, active_to);

create index if not exists ix_owner_marketing_daily_budgets_owner_scope
  on public.owner_marketing_daily_budgets (owner_id, channel, campaign_key, ad_key);

drop trigger if exists trg_owner_marketing_daily_budgets_set_updated_at on public.owner_marketing_daily_budgets;
create trigger trg_owner_marketing_daily_budgets_set_updated_at
before update on public.owner_marketing_daily_budgets
for each row execute function public.set_updated_at();

alter table public.owner_marketing_daily_budgets enable row level security;

revoke all on table public.owner_marketing_daily_budgets from public;
grant select, insert, update, delete on table public.owner_marketing_daily_budgets to service_role;

commit;
