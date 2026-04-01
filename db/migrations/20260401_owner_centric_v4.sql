create or replace function public.append_owner_client_event_v4(
  p_owner_id uuid,
  p_client_id uuid,
  p_alias_id uuid default null,
  p_actor_alias text default null,
  p_actor_phone text default null,
  p_event_type text default 'intake',
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_actor_alias text;
  v_actor_phone text;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_occurred_at timestamptz := now();
  v_received_at text;
begin
  if p_owner_id is null then
    raise exception using errcode = '22023', message = 'owner_id is required';
  end if;

  if p_client_id is null then
    raise exception using errcode = '22023', message = 'client_id is required';
  end if;

  v_actor_alias := nullif(btrim(coalesce(p_actor_alias, '')), '');
  if p_actor_phone is null or btrim(p_actor_phone) = '' then
    v_actor_phone := null;
  else
    v_actor_phone := public.normalize_phone_e164(p_actor_phone);
  end if;

  v_received_at := nullif(
    coalesce(
      v_payload ->> 'occurred_at',
      v_payload ->> 'OccurredAt',
      v_payload ->> 'ReceivedAt',
      v_payload -> 'source_context' ->> 'receivedAt',
      v_payload -> 'source_context' ->> 'ReceivedAt'
    ),
    ''
  );

  if v_received_at is not null then
    begin
      v_occurred_at := v_received_at::timestamptz;
    exception
      when others then
        v_occurred_at := now();
    end;
  end if;

  insert into public.owner_client_events (
    owner_id,
    client_id,
    alias_id,
    actor_alias,
    actor_phone,
    event_type,
    payload,
    occurred_at
  )
  values (
    p_owner_id,
    p_client_id,
    p_alias_id,
    v_actor_alias,
    v_actor_phone,
    p_event_type,
    v_payload,
    v_occurred_at
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

create or replace function public.intake_pending_cliente_v4(
  p_owner_key text,
  p_cliente_telefono text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null,
  p_source_context jsonb default null::jsonb
)
returns table (
  cajero_id uuid,
  jugador_id uuid,
  link_id uuid,
  estado text,
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
  v_client_id uuid;
  v_link_id uuid;
  v_status text;
  v_alias_id uuid;
  v_source_context jsonb := coalesce(p_source_context, '{}'::jsonb);
  v_payload jsonb;
begin
  if p_source_context is not null and jsonb_typeof(p_source_context) <> 'object' then
    raise exception using errcode = '22023', message = 'source_context must be a JSON object';
  end if;

  select r.owner_id, r.owner_key, r.pagina
    into v_owner_id, v_owner_key, v_pagina
  from public.resolve_owner_identity_v3(
    p_owner_key,
    coalesce(nullif(btrim(coalesce(p_owner_label, '')), ''), btrim(coalesce(p_owner_key, ''))),
    p_pagina
  ) as r
  limit 1;

  v_cliente_telefono := public.normalize_phone_e164(p_cliente_telefono);

  insert into public.clients (pagina, phone_e164)
  values (v_pagina, v_cliente_telefono)
  on conflict (pagina, phone_e164) do update
  set updated_at = now()
  returning id into v_client_id;

  insert into public.owner_client_links (
    owner_id,
    client_id,
    status,
    first_seen_at,
    last_seen_at
  )
  values (
    v_owner_id,
    v_client_id,
    'pending',
    now(),
    now()
  )
  on conflict on constraint uq_owner_client_links_owner_client do update
  set status = case
      when public.owner_client_links.status = 'assigned' then 'assigned'
      else 'pending'
    end,
    last_seen_at = now(),
    assigned_at = case
      when public.owner_client_links.status = 'assigned' then public.owner_client_links.assigned_at
      else null
    end
  returning id, status into v_link_id, v_status;

  v_alias_id := public.touch_owner_alias_v3(v_owner_id, p_actor_alias, p_actor_phone);

  v_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'owner_key',
      v_owner_key,
      'owner_label',
      coalesce(p_owner_label, v_owner_key),
      'source_context',
      case when v_source_context = '{}'::jsonb then null else v_source_context end,
      'ReferralCtwaClid',
      nullif(v_source_context ->> 'ctwaClid', ''),
      'ReferralSourceId',
      nullif(v_source_context ->> 'referralSourceId', ''),
      'ReferralSourceUrl',
      nullif(v_source_context ->> 'referralSourceUrl', ''),
      'ReferralHeadline',
      nullif(v_source_context ->> 'referralHeadline', ''),
      'ReferralBody',
      nullif(v_source_context ->> 'referralBody', ''),
      'ReferralSourceType',
      nullif(v_source_context ->> 'referralSourceType', ''),
      'WaId',
      nullif(v_source_context ->> 'waId', ''),
      'MessageSid',
      nullif(v_source_context ->> 'messageSid', ''),
      'AccountSid',
      nullif(v_source_context ->> 'accountSid', ''),
      'ProfileName',
      nullif(v_source_context ->> 'profileName', ''),
      'ClientIpAddress',
      nullif(v_source_context ->> 'clientIpAddress', ''),
      'ClientUserAgent',
      nullif(v_source_context ->> 'clientUserAgent', ''),
      'ReceivedAt',
      nullif(v_source_context ->> 'receivedAt', '')
    )
  );

  perform public.append_owner_client_event_v4(
    v_owner_id,
    v_client_id,
    v_alias_id,
    p_actor_alias,
    p_actor_phone,
    'intake',
    v_payload
  );

  cajero_id := v_owner_id;
  jugador_id := v_client_id;
  link_id := v_link_id;
  estado := v_status;
  owner_id := v_owner_id;
  client_id := v_client_id;
  return next;
end;
$$;

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
  v_target_identity_id uuid;
  v_existing_identity_id uuid;
  v_existing_link_id uuid;
  v_existing_owner_id uuid;
  v_existing_phone text;
  v_event_id uuid;
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
  previous_username := null;
  current_username := null;

  select c.id
    into v_target_client_id
  from public.clients c
  where c.pagina = v_pagina
    and c.phone_e164 = v_cliente_telefono
  limit 1;

  if not found then
    insert into public.clients (pagina, phone_e164)
    values (v_pagina, v_cliente_telefono)
    returning id into v_target_client_id;

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

  select i.id, i.owner_client_link_id, i.owner_id, c.phone_e164
    into v_existing_identity_id, v_existing_link_id, v_existing_owner_id, v_existing_phone
  from public.owner_client_identities i
  join public.clients c on c.id = i.client_id
  where i.pagina = v_pagina
    and i.username = v_target_username
    and i.is_active = true
  limit 1;

  if found then
    if v_existing_link_id = v_target_link_id then
      v_target_identity_id := v_existing_identity_id;
      current_username := v_target_username;
    elsif v_existing_owner_id <> v_owner_id then
      raise exception using errcode = 'P0001', message = 'username assigned to other owner';
    else
      moved_from_phone := v_existing_phone;

      update public.owner_client_identities
      set is_active = false,
          valid_to = now(),
          updated_at = now()
      where id = v_existing_identity_id;

      perform public.refresh_owner_client_link_status_v1(v_existing_link_id);
    end if;
  end if;

  select i.id, i.username
    into v_target_identity_id, previous_username
  from public.owner_client_identities i
  where i.owner_client_link_id = v_target_link_id
    and i.is_active = true
  limit 1;

  if found then
    if previous_username = v_target_username then
      current_username := v_target_username;
    else
      update public.owner_client_identities
      set is_active = false,
          valid_to = now(),
          updated_at = now()
      where id = v_target_identity_id;

      v_target_identity_id := null;
      overwritten := true;
      current_username := null;
    end if;
  end if;

  if v_target_identity_id is null then
    insert into public.owner_client_identities (
      owner_client_link_id,
      owner_id,
      client_id,
      pagina,
      username,
      is_active,
      valid_from
    )
    values (
      v_target_link_id,
      v_owner_id,
      v_target_client_id,
      v_pagina,
      v_target_username,
      true,
      now()
    )
    returning id into v_target_identity_id;

    current_username := v_target_username;
  end if;

  update public.owner_client_links
  set status = 'assigned',
      assigned_at = coalesce(assigned_at, now()),
      last_seen_at = now(),
      updated_at = now()
  where id = v_target_link_id;

  v_alias_id := public.touch_owner_alias_v3(v_owner_id, p_actor_alias, p_actor_phone);

  v_event_id := public.append_owner_client_event_v4(
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
      'identity_id',
      v_target_identity_id,
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

  update public.owner_client_identities
  set updated_at = now()
  where id = v_target_identity_id;

  owner_id := v_owner_id;
  client_id := v_target_client_id;
  return next;
end;
$$;

create or replace function public.assign_pending_username_v4(
  p_owner_key text,
  p_cliente_telefono text,
  p_username text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  jugador_id uuid,
  username text,
  estado text,
  owner_id uuid,
  client_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assign record;
begin
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

  jugador_id := v_assign.client_id;
  username := v_assign.current_username;
  estado := 'assigned';
  owner_id := v_assign.owner_id;
  client_id := v_assign.client_id;
  return next;
end;
$$;

create or replace function public.sync_create_player_link_v4(
  p_owner_key text,
  p_username text,
  p_cliente_telefono text default null,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null,
  p_source_context jsonb default null::jsonb
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
  from public.intake_pending_cliente_v4(
    p_owner_key,
    p_cliente_telefono,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone,
    p_source_context
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

create or replace function public.append_owner_client_event_v3(
  p_owner_id uuid,
  p_client_id uuid,
  p_alias_id uuid default null,
  p_actor_alias text default null,
  p_actor_phone text default null,
  p_event_type text default 'intake',
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.append_owner_client_event_v4(
    p_owner_id,
    p_client_id,
    p_alias_id,
    p_actor_alias,
    p_actor_phone,
    p_event_type,
    p_payload
  );
end;
$$;

create or replace function public.intake_pending_cliente_v3(
  p_owner_key text,
  p_cliente_telefono text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  cajero_id uuid,
  jugador_id uuid,
  link_id uuid,
  estado text,
  owner_id uuid,
  client_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select *
  from public.intake_pending_cliente_v4(
    p_owner_key,
    p_cliente_telefono,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone,
    null::jsonb
  );
end;
$$;

create or replace function public.assign_pending_username_v3(
  p_owner_key text,
  p_cliente_telefono text,
  p_username text,
  p_pagina text default 'ASN',
  p_owner_label text default null,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (
  jugador_id uuid,
  username text,
  estado text,
  owner_id uuid,
  client_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select *
  from public.assign_pending_username_v4(
    p_owner_key,
    p_cliente_telefono,
    p_username,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone
  );
end;
$$;

create or replace function public.assign_username_by_phone_v3(
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
  owner_id uuid,
  client_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    a.previous_username,
    a.current_username,
    a.overwritten,
    a.owner_id,
    a.client_id
  from public.assign_username_by_phone_v4(
    p_owner_key,
    p_cliente_telefono,
    p_username,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone
  ) as a;
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
begin
  return query
  select *
  from public.sync_create_player_link_v4(
    p_owner_key,
    p_username,
    p_cliente_telefono,
    p_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone,
    null::jsonb
  );
end;
$$;

revoke all on function public.append_owner_client_event_v4(uuid, uuid, uuid, text, text, text, jsonb) from public;
revoke all on function public.intake_pending_cliente_v4(text, text, text, text, text, text, jsonb) from public;
revoke all on function public.assign_username_by_phone_v4(text, text, text, text, text, text, text) from public;
revoke all on function public.assign_pending_username_v4(text, text, text, text, text, text, text) from public;
revoke all on function public.sync_create_player_link_v4(text, text, text, text, text, text, text, jsonb) from public;

grant execute on function public.append_owner_client_event_v4(uuid, uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function public.intake_pending_cliente_v4(text, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.assign_username_by_phone_v4(text, text, text, text, text, text, text) to service_role;
grant execute on function public.assign_pending_username_v4(text, text, text, text, text, text, text) to service_role;
grant execute on function public.sync_create_player_link_v4(text, text, text, text, text, text, text, jsonb) to service_role;
