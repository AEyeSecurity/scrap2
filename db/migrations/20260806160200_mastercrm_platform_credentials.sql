create table if not exists public.mastercrm_platform_credentials (
  owner_id uuid not null references public.owners(id) on delete cascade,
  pagina text not null check (pagina in ('RdA', 'ASN')),
  owner_key text not null,
  login_username text not null check (btrim(login_username) <> ''),
  login_password text not null check (login_password <> ''),
  source text not null default 'n8n',
  source_ref text null,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pk_mastercrm_platform_credentials primary key (owner_id, pagina)
);

create index if not exists ix_mastercrm_platform_credentials_owner_key
  on public.mastercrm_platform_credentials (pagina, owner_key);

insert into public.mastercrm_platform_credentials (
  owner_id, pagina, owner_key, login_username, login_password,
  source, source_ref, synced_at, updated_at
)
select
  owner_id, 'RdA', owner_key, login_username, login_password,
  source, source_ref, synced_at, updated_at
from public.mastercrm_rda_credentials
on conflict (owner_id, pagina) do update
set owner_key = excluded.owner_key,
    login_username = excluded.login_username,
    login_password = excluded.login_password,
    source = excluded.source,
    source_ref = excluded.source_ref,
    synced_at = excluded.synced_at,
    updated_at = excluded.updated_at;

alter table public.mastercrm_platform_credentials enable row level security;
revoke all on table public.mastercrm_platform_credentials from public;
grant select, insert, update, delete on table public.mastercrm_platform_credentials to service_role;

alter table public.mastercrm_whatsapp_qr_matches
  drop constraint if exists mastercrm_whatsapp_qr_matches_pagina_check;
alter table public.mastercrm_whatsapp_qr_matches
  add constraint mastercrm_whatsapp_qr_matches_pagina_check check (pagina in ('RdA', 'ASN'));

alter table public.mastercrm_whatsapp_qr_matches
  add column if not exists platform_validated_at timestamptz;

update public.mastercrm_whatsapp_qr_matches
set platform_validated_at = rda_validated_at
where platform_validated_at is null
  and rda_validated_at is not null;

comment on column public.mastercrm_whatsapp_qr_matches.rda_validated_at is
  'Deprecated compatibility alias. Use platform_validated_at.';
