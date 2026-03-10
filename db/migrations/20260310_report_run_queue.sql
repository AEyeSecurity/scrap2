begin;

create table if not exists public.report_runs (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('ASN')),
  principal_key text not null check (principal_key = lower(btrim(principal_key)) and principal_key <> ''),
  report_date date not null,
  status text not null check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  agente text not null check (agente = btrim(agente) and agente <> ''),
  contrasena_agente text not null check (contrasena_agente <> ''),
  requested_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null,
  total_items int not null default 0,
  done_items int not null default 0,
  failed_items int not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  constraint uq_report_runs_principal_date unique (principal_key, report_date)
);

create table if not exists public.report_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.report_runs(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  link_id uuid not null references public.owner_client_links(id) on delete cascade,
  username text not null check (username = lower(btrim(username))),
  owner_key text not null check (owner_key = lower(btrim(owner_key))),
  owner_label text not null check (owner_label = btrim(owner_label) and owner_label <> ''),
  status text not null check (status in ('pending', 'leased', 'done', 'failed', 'retry_wait')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  lease_until timestamptz null,
  next_retry_at timestamptz null,
  started_at timestamptz null,
  finished_at timestamptz null,
  last_error text null,
  cargado_hoy numeric(14,2) null,
  cargado_mes numeric(14,2) null,
  raw_result jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_report_run_items_run_username unique (run_id, username)
);

drop trigger if exists trg_report_run_items_set_updated_at on public.report_run_items;
create trigger trg_report_run_items_set_updated_at
before update on public.report_run_items
for each row execute function public.set_updated_at();

create index if not exists ix_report_run_items_run_status
  on public.report_run_items (run_id, status);
create index if not exists ix_report_run_items_status_retry
  on public.report_run_items (status, next_retry_at);
create index if not exists ix_report_run_items_status_lease
  on public.report_run_items (status, lease_until);
create index if not exists ix_report_run_items_owner_id
  on public.report_run_items (owner_id);
create index if not exists ix_report_run_items_client_id
  on public.report_run_items (client_id);

create table if not exists public.report_daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('ASN')),
  report_date date not null,
  principal_key text not null check (principal_key = lower(btrim(principal_key)) and principal_key <> ''),
  owner_id uuid not null references public.owners(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  link_id uuid not null references public.owner_client_links(id) on delete cascade,
  username text not null check (username = lower(btrim(username))),
  owner_key text not null check (owner_key = lower(btrim(owner_key))),
  owner_label text not null check (owner_label = btrim(owner_label) and owner_label <> ''),
  cargado_hoy numeric(14,2) not null,
  cargado_mes numeric(14,2) not null,
  raw_result jsonb not null,
  created_at timestamptz not null default now(),
  constraint uq_report_daily_snapshots_date_username unique (report_date, username)
);

create index if not exists ix_report_daily_snapshots_principal_date
  on public.report_daily_snapshots (principal_key, report_date desc);
create index if not exists ix_report_daily_snapshots_owner_date
  on public.report_daily_snapshots (owner_id, report_date desc);

create table if not exists public.report_outbox (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.report_runs(id) on delete cascade,
  kind text not null check (kind in ('asn_report_run_completed')),
  payload jsonb not null,
  status text not null check (status in ('pending', 'consumed')) default 'pending',
  created_at timestamptz not null default now(),
  consumed_at timestamptz null,
  constraint uq_report_outbox_run_kind unique (run_id, kind)
);

alter table public.report_runs enable row level security;
alter table public.report_run_items enable row level security;
alter table public.report_daily_snapshots enable row level security;
alter table public.report_outbox enable row level security;

create or replace function public.enqueue_report_run_items(
  p_run_id uuid,
  p_principal_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'run_id is required';
  end if;

  if nullif(lower(btrim(coalesce(p_principal_key, ''))), '') is null then
    raise exception using
      errcode = '22023',
      message = 'principal_key is required';
  end if;

  insert into public.report_run_items (
    run_id,
    owner_id,
    client_id,
    link_id,
    username,
    owner_key,
    owner_label,
    status,
    max_attempts
  )
  select
    p_run_id,
    o.id,
    c.id,
    l.id,
    c.username,
    o.owner_key,
    o.owner_label,
    'pending',
    3
  from public.owners o
  join public.owner_client_links l on l.owner_id = o.id
  join public.clients c on c.id = l.client_id
  where o.pagina = 'ASN'
    and c.pagina = 'ASN'
    and l.status = 'assigned'
    and c.username is not null
    and o.owner_key like lower(btrim(p_principal_key)) || ':%'
  on conflict (run_id, username) do nothing;

  get diagnostics v_inserted = row_count;

  update public.report_runs
  set total_items = (
        select count(*)
        from public.report_run_items ri
        where ri.run_id = p_run_id
      )
  where id = p_run_id;

  if v_inserted = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'no report users found for principal';
  end if;

  return v_inserted;
end;
$$;

create or replace function public.claim_next_report_run_item(
  p_lease_seconds integer default 60,
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
  client_id uuid,
  link_id uuid,
  username text,
  owner_key text,
  owner_label text,
  attempts integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
begin
  select
    ri.id,
    ri.run_id,
    rr.pagina,
    rr.principal_key,
    rr.report_date,
    rr.agente,
    rr.contrasena_agente,
    ri.owner_id,
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
  where rr.status in ('queued', 'running')
    and ri.attempts < least(coalesce(p_max_attempts, 3), ri.max_attempts)
    and (
      ri.status = 'pending'
      or (ri.status = 'retry_wait' and coalesce(ri.next_retry_at, now()) <= now())
      or (ri.status = 'leased' and coalesce(ri.lease_until, now()) <= now())
    )
  order by
    case ri.status
      when 'leased' then 0
      when 'retry_wait' then 1
      else 2
    end,
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
      lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 60), 1)),
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
  client_id := v_item.client_id;
  link_id := v_item.link_id;
  username := v_item.username;
  owner_key := v_item.owner_key;
  owner_label := v_item.owner_label;
  attempts := v_item.next_attempts;
  max_attempts := v_item.max_attempts;
  return next;
end;
$$;

create or replace function public.refresh_report_run_state(
  p_run_id uuid
)
returns table (
  run_id uuid,
  status text,
  total_items integer,
  done_items integer,
  failed_items integer,
  started_at timestamptz,
  finished_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer := 0;
  v_done integer := 0;
  v_failed integer := 0;
  v_in_progress integer := 0;
  v_status text;
  v_started_at timestamptz;
  v_finished_at timestamptz;
begin
  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'run_id is required';
  end if;

  select
    count(*),
    count(*) filter (where ri.status = 'done'),
    count(*) filter (where ri.status = 'failed'),
    count(*) filter (where ri.status in ('pending', 'leased', 'retry_wait'))
  into v_total, v_done, v_failed, v_in_progress
  from public.report_run_items ri
  where ri.run_id = p_run_id;

  if v_total = 0 then
    v_status := 'queued';
    v_finished_at := null;
  elsif v_in_progress > 0 then
    v_status := 'running';
    v_finished_at := null;
  elsif v_done = v_total then
    v_status := 'completed';
    v_finished_at := now();
  elsif v_done > 0 then
    v_status := 'completed_with_errors';
    v_finished_at := now();
  else
    v_status := 'failed';
    v_finished_at := now();
  end if;

  update public.report_runs rr
  set status = v_status,
      total_items = v_total,
      done_items = v_done,
      failed_items = v_failed,
      finished_at = case
        when v_status in ('completed', 'completed_with_errors', 'failed', 'cancelled')
          then coalesce(rr.finished_at, v_finished_at)
        else null
      end
  where rr.id = p_run_id
  returning rr.started_at, rr.finished_at
    into v_started_at, v_finished_at;

  run_id := p_run_id;
  status := v_status;
  total_items := v_total;
  done_items := v_done;
  failed_items := v_failed;
  started_at := v_started_at;
  finished_at := v_finished_at;
  return next;
end;
$$;

revoke all on table public.report_runs from public;
revoke all on table public.report_run_items from public;
revoke all on table public.report_daily_snapshots from public;
revoke all on table public.report_outbox from public;
revoke all on function public.enqueue_report_run_items(uuid, text) from public;
revoke all on function public.claim_next_report_run_item(integer, integer) from public;
revoke all on function public.refresh_report_run_state(uuid) from public;

grant all on table public.report_runs to service_role;
grant all on table public.report_run_items to service_role;
grant all on table public.report_daily_snapshots to service_role;
grant all on table public.report_outbox to service_role;
grant execute on function public.enqueue_report_run_items(uuid, text) to service_role;
grant execute on function public.claim_next_report_run_item(integer, integer) to service_role;
grant execute on function public.refresh_report_run_state(uuid) to service_role;

commit;
