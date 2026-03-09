begin;

create or replace function public.resolve_owner_identity_v3(
  p_owner_key text,
  p_owner_label text,
  p_pagina text default 'ASN'
)
returns table (
  owner_id uuid,
  pagina text,
  owner_key text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_key text;
  v_owner_label text;
  v_pagina text;
begin
  v_owner_key := lower(btrim(coalesce(p_owner_key, '')));
  if v_owner_key = '' then
    raise exception using
      errcode = '22023',
      message = 'owner_key is required';
  end if;

  v_owner_label := btrim(coalesce(p_owner_label, ''));
  if v_owner_label = '' then
    v_owner_label := v_owner_key;
  end if;

  v_pagina := btrim(coalesce(p_pagina, 'ASN'));
  if v_pagina not in ('RdA', 'ASN') then
    raise exception using
      errcode = '22023',
      message = 'pagina must be RdA or ASN';
  end if;

  insert into public.owners (pagina, owner_key, owner_label)
  values (v_pagina, v_owner_key, v_owner_label)
  on conflict on constraint uq_owners_pagina_owner_key do update
  set owner_label = excluded.owner_label
  returning public.owners.id, public.owners.pagina, public.owners.owner_key
    into owner_id, pagina, owner_key;

  return next;
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
declare
  v_owner_id uuid;
  v_owner_key text;
  v_pagina text;
  v_cliente_telefono text;
  v_client_id uuid;
  v_link_id uuid;
  v_status text;
  v_alias_id uuid;
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

  perform public.append_owner_client_event_v3(
    v_owner_id,
    v_client_id,
    v_alias_id,
    p_actor_alias,
    p_actor_phone,
    'intake',
    jsonb_build_object('owner_key', v_owner_key, 'owner_label', coalesce(p_owner_label, v_owner_key))
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

commit;
