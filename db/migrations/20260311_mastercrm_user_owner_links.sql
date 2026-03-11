begin;

create table if not exists public.mastercrm_user_owner_links (
  id uuid primary key default gen_random_uuid(),
  mastercrm_user_id bigint not null references public.mastercrm_users(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_user_owner_links_user_owner unique (mastercrm_user_id, owner_id)
);

create index if not exists ix_mastercrm_user_owner_links_user
  on public.mastercrm_user_owner_links (mastercrm_user_id);

create index if not exists ix_mastercrm_user_owner_links_owner
  on public.mastercrm_user_owner_links (owner_id);

drop trigger if exists trg_mastercrm_user_owner_links_set_updated_at on public.mastercrm_user_owner_links;
create trigger trg_mastercrm_user_owner_links_set_updated_at
before update on public.mastercrm_user_owner_links
for each row execute function public.set_updated_at();

alter table public.mastercrm_user_owner_links enable row level security;

commit;
