create table if not exists public.mastercrm_report_credentials (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('RdA', 'ASN')),
  principal_key text not null,
  login_username text not null check (btrim(login_username) <> ''),
  login_password text not null check (login_password <> ''),
  source text not null default 'report_api',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_report_credentials_pagina_principal unique (pagina, principal_key)
);

alter table public.mastercrm_report_credentials enable row level security;
revoke all on table public.mastercrm_report_credentials from public;
grant select, insert, update, delete on table public.mastercrm_report_credentials to service_role;

alter table public.report_runs
  add column if not exists credential_id uuid references public.mastercrm_report_credentials(id) on delete restrict;

-- Move any still-active legacy run credentials into the credential vault.
-- Environments where the hygiene migration already redacted old runs simply
-- insert zero rows here. Existing vault entries always win over old history.
insert into public.mastercrm_report_credentials (
  pagina,
  principal_key,
  login_username,
  login_password,
  source
)
select distinct on (pagina, principal_key)
  pagina,
  principal_key,
  agente,
  contrasena_agente,
  'legacy_report_run'
from public.report_runs
where nullif(btrim(agente), '') is not null
  and nullif(contrasena_agente, '') is not null
  and contrasena_agente <> '[redacted]'
order by pagina, principal_key, requested_at desc, id desc
on conflict (pagina, principal_key) do nothing;

update public.report_runs runs
set credential_id = credentials.id
from public.mastercrm_report_credentials credentials
where runs.credential_id is null
  and credentials.pagina = runs.pagina
  and credentials.principal_key = runs.principal_key;

update public.report_runs
set contrasena_agente = '[redacted]'
where credential_id is not null
  and contrasena_agente <> '[redacted]';

alter table public.report_run_items
  add column if not exists lease_token uuid;

create index if not exists ix_report_run_items_active_lease_token
  on public.report_run_items (id, lease_token)
  where status = 'leased';

drop function if exists public.claim_next_report_run_item(integer, integer);

create function public.claim_next_report_run_item(
  p_lease_seconds integer default 600,
  p_max_attempts integer default 3
)
returns table (
  item_id uuid,
  run_id uuid,
  pagina text,
  principal_key text,
  report_date date,
  agente text,
  contrasena_agente text,
  owner_id uuid,
  identity_id uuid,
  client_id uuid,
  link_id uuid,
  username text,
  owner_key text,
  owner_label text,
  attempts integer,
  max_attempts integer,
  lease_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_lease_token uuid := gen_random_uuid();
begin
  select
    ri.id,
    ri.run_id,
    rr.pagina,
    rr.principal_key,
    rr.report_date,
    coalesce(credentials.login_username, rr.agente) as agente,
    coalesce(credentials.login_password, rr.contrasena_agente) as contrasena_agente,
    ri.owner_id,
    ri.identity_id,
    ri.client_id,
    ri.link_id,
    ri.username,
    ri.owner_key,
    ri.owner_label,
    ri.attempts + 1 as next_attempts,
    ri.max_attempts
  into v_item
  from public.report_run_items ri
  join public.report_runs rr on rr.id = ri.run_id
  left join public.mastercrm_report_credentials credentials on credentials.id = rr.credential_id
  where rr.status in ('queued', 'running')
    and ri.attempts < least(coalesce(p_max_attempts, 3), ri.max_attempts)
    and (
      ri.status = 'pending'
      or (ri.status = 'retry_wait' and coalesce(ri.next_retry_at, now()) <= now())
      or (ri.status = 'leased' and coalesce(ri.lease_until, now()) <= now())
    )
  order by
    case ri.status when 'leased' then 0 when 'retry_wait' then 1 else 2 end,
    ri.created_at,
    ri.id
  limit 1
  for update of ri skip locked;

  if not found then
    return;
  end if;

  update public.report_run_items
  set status = 'leased',
      attempts = v_item.next_attempts,
      lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 1)),
      lease_token = v_lease_token,
      next_retry_at = null,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = v_item.id;

  update public.report_runs
  set status = case when status = 'queued' then 'running' else status end,
      started_at = coalesce(started_at, now())
  where id = v_item.run_id;

  item_id := v_item.id;
  run_id := v_item.run_id;
  pagina := v_item.pagina;
  principal_key := v_item.principal_key;
  report_date := v_item.report_date;
  agente := v_item.agente;
  contrasena_agente := v_item.contrasena_agente;
  owner_id := v_item.owner_id;
  identity_id := v_item.identity_id;
  client_id := v_item.client_id;
  link_id := v_item.link_id;
  username := v_item.username;
  owner_key := v_item.owner_key;
  owner_label := v_item.owner_label;
  attempts := v_item.next_attempts;
  max_attempts := v_item.max_attempts;
  lease_token := v_lease_token;
  return next;
end;
$$;

revoke all on function public.claim_next_report_run_item(integer, integer) from public;
grant execute on function public.claim_next_report_run_item(integer, integer) to service_role;
