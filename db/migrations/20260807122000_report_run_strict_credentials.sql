-- Resolve report authentication only from each item's exact owner/platform
-- credential. report_runs keeps compatibility placeholders, never secrets.

update public.report_runs
set agente = '[per-owner-platform-credential]',
    contrasena_agente = '[redacted]'
where agente <> '[per-owner-platform-credential]'
   or contrasena_agente <> '[redacted]';

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
  -- Missing or stale owner credentials are terminal for that owner's items.
  -- They are never leased with a principal/run-level fallback.
  update public.report_run_items ri
  set status = 'failed',
      lease_until = null,
      lease_token = null,
      next_retry_at = null,
      finished_at = now(),
      last_error = 'PLATFORM_CREDENTIAL_MISSING',
      updated_at = now()
  from public.report_runs rr
  where rr.id = ri.run_id
    and rr.status in ('queued', 'running')
    and ri.status in ('pending', 'retry_wait', 'leased')
    and not exists (
      select 1
      from public.mastercrm_platform_credentials credentials
      where credentials.owner_id = ri.owner_id
        and credentials.pagina = rr.pagina
        and credentials.owner_key = ri.owner_key
        and nullif(btrim(credentials.login_username), '') is not null
        and nullif(credentials.login_password, '') is not null
    );

  -- Finalize runs that became terminal solely because credentials were absent.
  with stats as (
    select
      rr.id,
      count(*) filter (where ri.status = 'done')::integer as done_items,
      count(*) filter (where ri.status = 'failed')::integer as failed_items,
      count(*) filter (where ri.status in ('pending', 'retry_wait', 'leased'))::integer as active_items
    from public.report_runs rr
    join public.report_run_items ri on ri.run_id = rr.id
    where rr.status in ('queued', 'running')
    group by rr.id
  )
  update public.report_runs rr
  set done_items = stats.done_items,
      failed_items = stats.failed_items,
      status = case
        when stats.active_items > 0 then rr.status
        when stats.failed_items = 0 then 'completed'
        when stats.done_items = 0 then 'failed'
        else 'completed_with_errors'
      end,
      finished_at = case when stats.active_items = 0 then now() else rr.finished_at end
  from stats
  where rr.id = stats.id;

  select
    ri.id,
    ri.run_id,
    rr.pagina,
    rr.principal_key,
    rr.report_date,
    credentials.login_username as agente,
    credentials.login_password as contrasena_agente,
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
  join public.mastercrm_platform_credentials credentials
    on credentials.owner_id = ri.owner_id
   and credentials.pagina = rr.pagina
   and credentials.owner_key = ri.owner_key
   and nullif(btrim(credentials.login_username), '') is not null
   and nullif(credentials.login_password, '') is not null
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
