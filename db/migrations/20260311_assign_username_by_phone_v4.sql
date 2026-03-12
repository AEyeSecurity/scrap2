begin;

create or replace function public.assign_username_by_phone_v4(
  p_owner_key text,
  p_cliente_telefono text,
  p_username text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  previous_username text,
  current_username text,
  overwritten boolean,
  created_client boolean,
  created_link boolean,
  moved_from_phone text,
  deleted_old_phone boolean,
  owner_id uuid,
  client_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_owner_key text;
  v_pagina text;
  v_cliente_telefono text;
  v_target_username text;
  v_alias_id uuid;
  v_target_client_id uuid;
  v_target_link_id uuid;
  v_username_client_id uuid;
  v_username_phone text;
begin
  select r.owner_id, r.owner_key, r.pagina
    into v_owner_id, v_owner_key, v_pagina
  from public.resolve_owner_identity_v3(
    p_owner_key,
    coalesce(nullif(btrim(coalesce(p_owner_label, '')), ''), btrim(coalesce(p_owner_key, ''))),
    p_pagina
  ) as r
  limit 1;

  v_cliente_telefono := public.normalize_phone_e164(p_cliente_telefono);
  v_target_username := public.normalize_username(p_username, 'username');

  created_client := false;
  created_link := false;
  overwritten := false;
  moved_from_phone := null;
  deleted_old_phone := false;

  select c.id, c.username
    into v_target_client_id, previous_username
  from public.clients c
  where c.pagina = v_pagina
    and c.phone_e164 = v_cliente_telefono
  limit 1;

  if not found then
    insert into public.clients (pagina, phone_e164)
    values (v_pagina, v_cliente_telefono)
    returning id, username into v_target_client_id, previous_username;

    created_client := true;
  else
    update public.clients
    set updated_at = now()
    where id = v_target_client_id;
  end if;

  select l.id
    into v_target_link_id
  from public.owner_client_links l
  where l.owner_id = v_owner_id
    and l.client_id = v_target_client_id
  limit 1;

  if not found then
    insert into public.owner_client_links (
      owner_id,
      client_id,
      status,
      first_seen_at,
      last_seen_at
    )
    values (
      v_owner_id,
      v_target_client_id,
      'pending',
      now(),
      now()
    )
    returning id into v_target_link_id;

    created_link := true;
  else
    update public.owner_client_links
    set last_seen_at = now(),
        updated_at = now()
    where id = v_target_link_id;
  end if;

  select c.id, c.phone_e164
    into v_username_client_id, v_username_phone
  from public.clients c
  where c.pagina = v_pagina
    and c.username = v_target_username
  limit 1;

  if found and v_username_client_id <> v_target_client_id then
    if exists (
      select 1
      from public.owner_client_links l
      where l.client_id = v_username_client_id
        and l.owner_id <> v_owner_id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'username assigned to other owner';
    end if;

    moved_from_phone := v_username_phone;

    delete from public.owner_client_links
    where owner_id = v_owner_id
      and client_id = v_username_client_id;

    update public.clients
    set username = null,
        updated_at = now()
    where id = v_username_client_id;

    if not exists (
      select 1
      from public.owner_client_links l
      where l.client_id = v_username_client_id
    ) then
      delete from public.clients
      where id = v_username_client_id;

      deleted_old_phone := true;
    end if;
  end if;

  begin
    update public.clients
    set username = v_target_username,
        updated_at = now()
    where id = v_target_client_id
      and pagina = v_pagina
    returning public.clients.username into current_username;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = 'username already exists in this pagina';
  end;

  overwritten := previous_username is not null and previous_username <> current_username;

  update public.owner_client_links
  set status = 'assigned',
      assigned_at = coalesce(assigned_at, now()),
      last_seen_at = now(),
      updated_at = now()
  where id = v_target_link_id;

  v_alias_id := public.touch_owner_alias_v3(v_owner_id, p_actor_alias, p_actor_phone);

  perform public.append_owner_client_event_v3(
    v_owner_id,
    v_target_client_id,
    v_alias_id,
    p_actor_alias,
    p_actor_phone,
    'assign_username',
    jsonb_build_object(
      'owner_key',
      v_owner_key,
      'username',
      current_username,
      'overwritten',
      overwritten,
      'created_client',
      created_client,
      'created_link',
      created_link,
      'moved_from_phone',
      moved_from_phone,
      'deleted_old_phone',
      deleted_old_phone
    )
  );

  owner_id := v_owner_id;
  client_id := v_target_client_id;
  return next;
end;
$$;

create or replace function public.sync_create_player_link_v3(
  p_owner_key text,
  p_username text,
  p_cliente_telefono text default null,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  owner_id uuid,
  client_id uuid,
  link_id uuid,
  estado text,
  previous_username text,
  current_username text,
  overwritten boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intake record;
  v_assign record;
begin
  if p_cliente_telefono is null or btrim(p_cliente_telefono) = '' then
    return;
  end if;

  select *
    into v_intake
  from public.intake_pending_cliente_v3(
    p_owner_key,
    p_cliente_telefono,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone
  ) i
  limit 1;

  select *
    into v_assign
  from public.assign_username_by_phone_v4(
    p_owner_key,
    p_cliente_telefono,
    p_username,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone
  ) a
  limit 1;

  owner_id := v_intake.owner_id;
  client_id := v_intake.client_id;
  link_id := v_intake.link_id;
  estado := 'assigned';
  previous_username := v_assign.previous_username;
  current_username := v_assign.current_username;
  overwritten := v_assign.overwritten;
  return next;
end;
$$;

revoke all on function public.assign_username_by_phone_v4(text, text, text, text, text, text, text) from public;
grant execute on function public.assign_username_by_phone_v4(text, text, text, text, text, text, text) to service_role;

commit;
