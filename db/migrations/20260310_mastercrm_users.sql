begin;

create table if not exists public.mastercrm_users (
  id bigint generated always as identity primary key,
  username text not null check (username = lower(btrim(username)) and username <> ''),
  password_hash text not null check (btrim(password_hash) <> ''),
  nombre text not null check (nombre = btrim(nombre) and nombre <> ''),
  telefono text null,
  inversion numeric not null default 0 check (inversion >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_mastercrm_users_username
  on public.mastercrm_users (username);

drop trigger if exists trg_mastercrm_users_set_updated_at on public.mastercrm_users;
create trigger trg_mastercrm_users_set_updated_at
before update on public.mastercrm_users
for each row execute function public.set_updated_at();

alter table public.mastercrm_users enable row level security;

commit;
