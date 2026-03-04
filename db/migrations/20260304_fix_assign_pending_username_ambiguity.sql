begin;

create or replace function public.assign_pending_username(
  p_agente text,
  p_telefono text,
  p_username text,
  p_pagina text default 'ASN'
)
returns table (
  jugador_id uuid,
  username text,
  estado text
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
  v_cajero public.cajeros%rowtype;
  v_link public.cajeros_jugadores%rowtype;
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

  select c.*
    into v_cajero
  from public.cajeros as c
  where c.username = v_agente
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'agente not found';
  end if;

  select cj.*
    into v_link
  from public.cajeros_jugadores as cj
  where cj.cajero_id = v_cajero.id
    and cj.telefono = v_telefono
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'pending link not found for agente + telefono';
  end if;

  begin
    update public.jugadores as j
    set username = v_username,
        estado = 'asignado'
    where j.id = v_link.jugador_id
      and j.pagina = v_cajero.pagina
      and j.estado = 'pendiente'
      and j.username is null
    returning j.id, j.username, j.estado
      into jugador_id, username, estado;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = 'username already exists in this pagina';
  end;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'jugador is already assigned and username is immutable';
  end if;

  return next;
end;
$$;

revoke all on function public.assign_pending_username(text, text, text, text) from public;
grant execute on function public.assign_pending_username(text, text, text, text) to service_role;

commit;
