create table if not exists public.mastercrm_whatsapp_qr_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  session_id uuid null references public.mastercrm_whatsapp_qr_sessions(id) on delete set null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  contact_name text null,
  notify text null,
  username text null,
  verified_name text null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_whatsapp_qr_contacts_owner_phone unique (owner_id, phone_e164)
);

create index if not exists ix_mastercrm_whatsapp_qr_contacts_owner_seen
  on public.mastercrm_whatsapp_qr_contacts (owner_id, last_seen_at desc);

create table if not exists public.mastercrm_whatsapp_qr_recheck_queue (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  session_id uuid null references public.mastercrm_whatsapp_qr_sessions(id) on delete set null,
  month_start date not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  reason text not null check (reason in ('outbound_candidate', 'contact_seen', 'technical_error', 'first_load', 'manual')),
  status text not null default 'pending' check (status in ('pending', 'done', 'expired')),
  attempts integer not null default 0 check (attempts >= 0),
  next_run_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_whatsapp_qr_recheck_owner_phone_month unique (owner_id, month_start, phone_e164)
);

create index if not exists ix_mastercrm_whatsapp_qr_recheck_due
  on public.mastercrm_whatsapp_qr_recheck_queue (status, next_run_at, expires_at);

create index if not exists ix_mastercrm_whatsapp_qr_recheck_owner_month
  on public.mastercrm_whatsapp_qr_recheck_queue (owner_id, month_start, updated_at desc);

alter table public.mastercrm_whatsapp_qr_contacts enable row level security;
alter table public.mastercrm_whatsapp_qr_recheck_queue enable row level security;

revoke all on table public.mastercrm_whatsapp_qr_contacts from public;
revoke all on table public.mastercrm_whatsapp_qr_recheck_queue from public;

grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_contacts to service_role;
grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_recheck_queue to service_role;
