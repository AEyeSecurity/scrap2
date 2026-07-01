create table if not exists public.mastercrm_whatsapp_qr_ignored_phones (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  month_start date not null,
  client_phone_e164 text not null check (client_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  ignored_by_user_id bigint null references public.mastercrm_users(id) on delete set null,
  reason text not null default 'manual_ignore' check (reason = 'manual_ignore'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_whatsapp_qr_ignored_phones unique (owner_id, month_start, client_phone_e164)
);

create index if not exists ix_mastercrm_whatsapp_qr_ignored_owner_month
  on public.mastercrm_whatsapp_qr_ignored_phones (owner_id, month_start, created_at desc);

alter table public.mastercrm_whatsapp_qr_ignored_phones enable row level security;

revoke all on table public.mastercrm_whatsapp_qr_ignored_phones from public;

grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_ignored_phones to service_role;
