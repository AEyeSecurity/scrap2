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
  v_run record;
  v_principal_key text;
begin
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'run_id is required';
  end if;

  v_principal_key := nullif(lower(btrim(coalesce(p_principal_key, ''))), '');
  if v_principal_key is null then
    raise exception using errcode = '22023', message = 'principal_key is required';
  end if;

  select rr.id, rr.pagina, rr.principal_key
    into v_run
  from public.report_runs rr
  where rr.id = p_run_id
  limit 1;

  if not found then
    raise exception using errcode = '23503', message = 'report run not found';
  end if;

  insert into public.report_run_items (
    run_id,
    owner_id,
    identity_id,
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
    i.id,
    c.id,
    l.id,
    i.username,
    o.owner_key,
    o.owner_label,
    'pending',
    3
  from public.owners o
  join public.owner_client_links l on l.owner_id = o.id
  join public.clients c on c.id = l.client_id
  join public.owner_client_identities i
    on i.owner_client_link_id = l.id
   and i.is_active = true
  where o.pagina = v_run.pagina
    and c.pagina = v_run.pagina
    and i.pagina = v_run.pagina
    and l.status = 'assigned'
    and (
      o.owner_key = v_principal_key
      or o.owner_key like v_principal_key || ':%'
    )
  on conflict (run_id, identity_id) do nothing;

  get diagnostics v_inserted = row_count;

  update public.report_runs
  set total_items = (
        select count(*)
        from public.report_run_items ri
        where ri.run_id = p_run_id
      )
  where id = p_run_id;

  if v_inserted = 0 then
    raise exception using errcode = 'P0001', message = 'no report users found for principal';
  end if;

  return v_inserted;
end;
$$;

revoke all on function public.enqueue_report_run_items(uuid, text) from public;
grant execute on function public.enqueue_report_run_items(uuid, text) to service_role;

