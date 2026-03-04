begin;

create or replace function public.assign_username_by_phone(
  p_agente text,
  p_telefono text,
  p_username text,
  p_pagina text default 'ASN'
)
returns table (
  previous_username text,
  current_username text,
  overwritten boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agente text;
  v_telefono text;
  v_username text;
  v_pagina text;
  v_cajero_id uuid;
  v_jugador_id uuid;
  v_existing_jugador_id uuid;
begin
  v_agente := public.normalize_username(p_agente, 'agente');
  v_telefono := public.normalize_phone_e164(p_telefono);
  v_username := public.normalize_username(p_username, 'username');
  v_pagina := btrim(coalesce(p_pagina, 'ASN'));

  if v_pagina not in ('RdA', 'ASN') then
    raise exception using
      errcode = '22023',
      message = 'pagina must be RdA or ASN';
  end if;

  select c.id
    into v_cajero_id
  from public.cajeros c
  where c.pagina = v_pagina
    and c.username = v_agente
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'link not found for agente + telefono';
  end if;

  select cj.jugador_id, j.username
    into v_jugador_id, previous_username
  from public.cajeros_jugadores cj
  join public.jugadores j on j.id = cj.jugador_id
  where cj.pagina = v_pagina
    and cj.cajero_id = v_cajero_id
    and cj.telefono = v_telefono
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'link not found for agente + telefono';
  end if;

  select j.id
    into v_existing_jugador_id
  from public.jugadores j
  where j.pagina = v_pagina
    and j.username = v_username
  limit 1;

  if v_existing_jugador_id is not null and v_existing_jugador_id <> v_jugador_id then
    raise exception using
      errcode = 'P0001',
      message = 'username already exists in this pagina';
  end if;

  begin
    update public.jugadores
    set username = v_username,
        estado = 'asignado'
    where id = v_jugador_id
      and pagina = v_pagina;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = 'username already exists in this pagina';
  end;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'link not found for agente + telefono';
  end if;

  current_username := v_username;
  overwritten := previous_username is not null and previous_username <> v_username;
  return next;
end;
$$;

revoke execute on function public.assign_username_by_phone(text, text, text, text) from public;
revoke execute on function public.assign_username_by_phone(text, text, text, text) from anon;
revoke execute on function public.assign_username_by_phone(text, text, text, text) from authenticated;
grant execute on function public.assign_username_by_phone(text, text, text, text) to service_role;

commit;
