create table if not exists public.mastercrm_whatsapp_qr_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  pagina text not null check (pagina in ('ASN', 'RdA')),
  owner_key text not null check (owner_key = lower(btrim(owner_key)) and owner_key <> ''),
  owner_label text not null check (owner_label = btrim(owner_label) and owner_label <> ''),
  status text not null default 'idle'
    check (status in ('idle', 'waiting_qr', 'connected', 'disconnected', 'error')),
  runtime_session_id text not null,
  phone_e164 text null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  qr_payload text null,
  qr_data_url text null,
  qr_expires_at timestamptz null,
  last_heartbeat_at timestamptz null,
  last_connected_at timestamptz null,
  last_disconnected_at timestamptz null,
  last_error text null,
  bot_group_key text null,
  disconnected_alerted_at timestamptz null,
  qr_alerted_at timestamptz null,
  heartbeat_alerted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_whatsapp_qr_sessions_owner unique (owner_id)
);

create index if not exists ix_mastercrm_whatsapp_qr_sessions_status
  on public.mastercrm_whatsapp_qr_sessions (status, updated_at desc);

create table if not exists public.mastercrm_rda_credentials (
  owner_id uuid primary key references public.owners(id) on delete cascade,
  pagina text not null default 'RdA' check (pagina = 'RdA'),
  owner_key text not null check (owner_key = lower(btrim(owner_key)) and owner_key <> ''),
  login_username text not null check (login_username = btrim(login_username) and login_username <> ''),
  login_password text not null check (login_password <> ''),
  source text not null default 'n8n',
  source_ref text null,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_mastercrm_rda_credentials_owner_key
  on public.mastercrm_rda_credentials (owner_key);

create table if not exists public.mastercrm_whatsapp_qr_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.mastercrm_whatsapp_qr_sessions(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound', 'contact_sync')),
  remote_jid text null,
  message_id text null,
  client_phone_e164 text not null check (client_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  contact_name text null,
  push_name text null,
  text_excerpt text null,
  candidate_username text null,
  match_source text null check (match_source in ('contact_name', 'outbound_message')),
  message_timestamp timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists ix_mastercrm_whatsapp_qr_messages_owner_created
  on public.mastercrm_whatsapp_qr_messages (owner_id, created_at desc);

create index if not exists ix_mastercrm_whatsapp_qr_messages_candidate
  on public.mastercrm_whatsapp_qr_messages (owner_id, candidate_username)
  where candidate_username is not null;

create table if not exists public.mastercrm_whatsapp_qr_matches (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.mastercrm_whatsapp_qr_sessions(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  message_id uuid null references public.mastercrm_whatsapp_qr_messages(id) on delete set null,
  pagina text not null default 'RdA' check (pagina = 'RdA'),
  client_phone_e164 text not null check (client_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  username text not null check (username = lower(btrim(username)) and username <> ''),
  source text not null check (source in ('contact_name', 'outbound_message')),
  status text not null default 'candidate'
    check (status in ('candidate', 'validated', 'assigned', 'not_found', 'conflict', 'error')),
  rda_validated_at timestamptz null,
  assigned_at timestamptz null,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_mastercrm_whatsapp_qr_matches_owner_created
  on public.mastercrm_whatsapp_qr_matches (owner_id, created_at desc);

create index if not exists ix_mastercrm_whatsapp_qr_matches_status
  on public.mastercrm_whatsapp_qr_matches (status, updated_at desc);

alter table public.mastercrm_whatsapp_qr_sessions enable row level security;
alter table public.mastercrm_rda_credentials enable row level security;
alter table public.mastercrm_whatsapp_qr_messages enable row level security;
alter table public.mastercrm_whatsapp_qr_matches enable row level security;

revoke all on table public.mastercrm_whatsapp_qr_sessions from public;
revoke all on table public.mastercrm_rda_credentials from public;
revoke all on table public.mastercrm_whatsapp_qr_messages from public;
revoke all on table public.mastercrm_whatsapp_qr_matches from public;

grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_sessions to service_role;
grant select, insert, update, delete on table public.mastercrm_rda_credentials to service_role;
grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_messages to service_role;
grant select, insert, update, delete on table public.mastercrm_whatsapp_qr_matches to service_role;
