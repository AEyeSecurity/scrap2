alter table public.mastercrm_whatsapp_qr_recheck_queue
  drop constraint if exists mastercrm_whatsapp_qr_recheck_queue_reason_check;

alter table public.mastercrm_whatsapp_qr_recheck_queue
  add constraint mastercrm_whatsapp_qr_recheck_queue_reason_check
  check (reason in ('outbound_candidate', 'contact_seen', 'technical_error', 'first_load', 'manual', 'backfill_no_signal'));

create table if not exists public.mastercrm_whatsapp_qr_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  session_id uuid null references public.mastercrm_whatsapp_qr_sessions(id) on delete set null,
  month_start date not null,
  trigger_source text not null check (trigger_source = btrim(trigger_source) and trigger_source <> ''),
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  last_completed_at timestamptz null,
  last_error text null,
  summary_json jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_mastercrm_whatsapp_qr_backfill_runs_owner_month
  on public.mastercrm_whatsapp_qr_backfill_runs (owner_id, month_start, started_at desc);

create index if not exists ix_mastercrm_whatsapp_qr_backfill_runs_status
  on public.mastercrm_whatsapp_qr_backfill_runs (status, started_at desc);

alter table public.mastercrm_whatsapp_qr_backfill_runs enable row level security;

revoke all on table public.mastercrm_whatsapp_qr_backfill_runs from public;

grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_backfill_runs to service_role;
