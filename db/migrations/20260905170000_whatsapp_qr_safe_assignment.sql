begin;

create or replace function public.assign_username_by_phone_qr_v1(
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
  v_pagina text;
  v_phone text;
  v_username text;
  v_existing_username_owner_id uuid;
  v_existing_username_phone text;
  v_existing_phone_username text;
begin
  select resolved.owner_id, resolved.pagina
    into v_owner_id, v_pagina
  from public.resolve_owner_identity_v3(
    p_owner_key,
    coalesce(nullif(btrim(coalesce(p_owner_label, '')), ''), btrim(coalesce(p_owner_key, ''))),
    p_pagina
  ) resolved
  limit 1;

  v_phone := public.normalize_phone_e164(p_cliente_telefono);
  v_username := public.normalize_username(p_username, 'username');

  perform pg_advisory_xact_lock(hashtextextended('qr-username:' || v_pagina || ':' || v_username, 0));
  perform pg_advisory_xact_lock(hashtextextended('qr-phone:' || v_owner_id::text || ':' || v_phone, 0));

  select identity.owner_id, client.phone_e164
    into v_existing_username_owner_id, v_existing_username_phone
  from public.owner_client_identities identity
  join public.clients client on client.id = identity.client_id
  where identity.pagina = v_pagina
    and identity.username = v_username
    and identity.is_active = true
  limit 1;

  if found and (v_existing_username_owner_id <> v_owner_id or v_existing_username_phone <> v_phone) then
    raise exception using errcode = 'P0001', message = 'QR_USERNAME_ALREADY_ASSIGNED_TO_OTHER_PHONE';
  end if;

  select identity.username
    into v_existing_phone_username
  from public.owner_client_identities identity
  join public.clients client on client.id = identity.client_id
  where identity.owner_id = v_owner_id
    and identity.pagina = v_pagina
    and identity.is_active = true
    and client.phone_e164 = v_phone
  limit 1;

  if found and v_existing_phone_username <> v_username then
    raise exception using errcode = 'P0001', message = 'QR_PHONE_ALREADY_ASSIGNED_TO_OTHER_USERNAME';
  end if;

  return query
  select assignment.previous_username,
         assignment.current_username,
         assignment.overwritten,
         assignment.created_client,
         assignment.created_link,
         assignment.moved_from_phone,
         assignment.deleted_old_phone,
         assignment.owner_id,
         assignment.client_id
  from public.assign_username_by_phone_v4(
    p_owner_key,
    v_phone,
    v_username,
    v_pagina,
    p_owner_label,
    p_actor_alias,
    p_actor_phone
  ) assignment;
end;
$$;

create or replace function public.assign_username_to_platform_owner_pair_qr_v1(
  p_pair_id uuid,
  p_cliente_telefono text,
  p_username text,
  p_actor_alias text default null,
  p_actor_phone text default null
)
returns table (owner_id uuid, pagina text, owner_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pair public.mastercrm_platform_owner_pairs%rowtype;
  v_rda public.owners%rowtype;
  v_asn public.owners%rowtype;
begin
  select * into v_pair
  from public.mastercrm_platform_owner_pairs
  where id = p_pair_id
    and active_from <= now()
    and (active_to is null or active_to > now())
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR_PAIR_NOT_CONFIGURED';
  end if;

  select owner_row.* into v_rda
  from public.owners owner_row
  where owner_row.id = v_pair.rda_owner_id and owner_row.pagina = 'RdA';

  select owner_row.* into v_asn
  from public.owners owner_row
  where owner_row.id = v_pair.asn_owner_id and owner_row.pagina = 'ASN';

  if v_rda.id is null or v_asn.id is null then
    raise exception using errcode = '23514', message = 'invalid platform owner pair';
  end if;

  perform * from public.assign_username_by_phone_qr_v1(
    v_rda.owner_key, p_cliente_telefono, p_username, 'RdA', v_rda.owner_label, p_actor_alias, p_actor_phone
  );
  perform * from public.assign_username_by_phone_qr_v1(
    v_asn.owner_key, p_cliente_telefono, p_username, 'ASN', v_asn.owner_label, p_actor_alias, p_actor_phone
  );

  owner_id := v_rda.id; pagina := 'RdA'; owner_key := v_rda.owner_key; return next;
  owner_id := v_asn.id; pagina := 'ASN'; owner_key := v_asn.owner_key; return next;
end;
$$;

revoke all on function public.assign_username_by_phone_qr_v1(text, text, text, text, text, text, text) from public;
revoke all on function public.assign_username_to_platform_owner_pair_qr_v1(uuid, text, text, text, text) from public;
revoke all on function public.assign_username_by_phone_qr_v1(text, text, text, text, text, text, text) from anon, authenticated;
revoke all on function public.assign_username_to_platform_owner_pair_qr_v1(uuid, text, text, text, text) from anon, authenticated;
grant execute on function public.assign_username_by_phone_qr_v1(text, text, text, text, text, text, text) to service_role;
grant execute on function public.assign_username_to_platform_owner_pair_qr_v1(uuid, text, text, text, text) to service_role;

commit;
