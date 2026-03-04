begin;

do $$
begin
  if exists (
    select 1
    from public.cajeros
    group by username
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'cannot add global unique on cajeros.username because duplicates exist';
  end if;
end;
$$;

alter table public.jugadores
  alter column username drop not null;

alter table public.jugadores
  add column if not exists estado text;

update public.jugadores
set estado = case when username is null then 'pendiente' else 'asignado' end
where estado is null
   or estado not in ('pendiente', 'asignado');

alter table public.jugadores
  alter column estado set default 'asignado';

alter table public.jugadores
  alter column estado set not null;

alter table public.jugadores
  drop constraint if exists ck_jugadores_estado_domain;

alter table public.jugadores
  add constraint ck_jugadores_estado_domain
  check (estado in ('pendiente', 'asignado'));

alter table public.jugadores
  drop constraint if exists ck_jugadores_estado_username_consistency;

alter table public.jugadores
  add constraint ck_jugadores_estado_username_consistency
  check (
    (estado = 'pendiente' and username is null)
    or
    (estado = 'asignado' and username is not null)
  );

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'uq_cajeros_username'
      and conrelid = 'public.cajeros'::regclass
  ) then
    alter table public.cajeros
      add constraint uq_cajeros_username unique (username);
  end if;
end;
$$;

create or replace function public.normalize_username(
  p_input text,
  p_field text default 'username'
)
returns text
language plpgsql
immutable
as $$
declare
  v_value text;
begin
  v_value := lower(btrim(coalesce(p_input, '')));
  if v_value = '' then
    raise exception using
      errcode = '22023',
      message = format('%s is required', p_field);
  end if;
  return v_value;
end;
$$;

create or replace function public.normalize_phone_e164(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v_phone text;
begin
  v_phone := btrim(coalesce(p_input, ''));
  if v_phone = '' then
    raise exception using
      errcode = '22023',
      message = 'telefono is required';
  end if;

  v_phone := regexp_replace(v_phone, '[\s\-\(\)]', '', 'g');
  if left(v_phone, 2) = '00' then
    v_phone := '+' || substr(v_phone, 3);
  end if;

  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = '22023',
      message = 'telefono must be strict E.164 format';
  end if;

  return v_phone;
end;
$$;

create or replace function public.intake_pending_cliente(
  p_agente text,
  p_telefono text,
  p_pagina text default 'ASN'
)
returns table (
  cajero_id uuid,
  jugador_id uuid,
  link_id uuid,
  estado text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agente text;
  v_telefono text;
  v_pagina text;
  v_cajero public.cajeros%rowtype;
  v_existing_link_id uuid;
  v_existing_jugador_id uuid;
  v_existing_estado text;
begin
  v_agente := public.normalize_username(p_agente, 'agente');
  v_telefono := public.normalize_phone_e164(p_telefono);
  v_pagina := btrim(coalesce(p_pagina, 'ASN'));

  if v_pagina not in ('RdA', 'ASN') then
    raise exception using
      errcode = '22023',
      message = 'pagina must be RdA or ASN';
  end if;

  insert into public.cajeros (pagina, username)
  values (v_pagina, v_agente)
  on conflict (username) do update
  set username = excluded.username
  returning * into v_cajero;

  select cj.id, cj.jugador_id, j.estado
    into v_existing_link_id, v_existing_jugador_id, v_existing_estado
  from public.cajeros_jugadores cj
  join public.jugadores j on j.id = cj.jugador_id
  where cj.cajero_id = v_cajero.id
    and cj.telefono = v_telefono
  limit 1;

  if found then
    if v_existing_estado = 'pendiente' then
      return query
      select v_cajero.id, v_existing_jugador_id, v_existing_link_id, v_existing_estado;
      return;
    end if;

    raise exception using
      errcode = 'P0001',
      message = 'telefono already assigned for this cajero';
  end if;

  begin
    insert into public.jugadores (pagina, username, estado)
    values (v_cajero.pagina, null, 'pendiente')
    returning id into jugador_id;

    insert into public.cajeros_jugadores (pagina, cajero_id, jugador_id, telefono, source)
    values (v_cajero.pagina, v_cajero.id, jugador_id, v_telefono, 'manual-assign')
    returning id into link_id;

    cajero_id := v_cajero.id;
    estado := 'pendiente';
    return next;
    return;
  exception
    when unique_violation then
      select cj.id, cj.jugador_id, j.estado
        into v_existing_link_id, v_existing_jugador_id, v_existing_estado
      from public.cajeros_jugadores cj
      join public.jugadores j on j.id = cj.jugador_id
      where cj.cajero_id = v_cajero.id
        and cj.telefono = v_telefono
      limit 1;

      if found and v_existing_estado = 'pendiente' then
        return query
        select v_cajero.id, v_existing_jugador_id, v_existing_link_id, v_existing_estado;
        return;
      end if;

      raise;
  end;
end;
$$;

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

  select *
    into v_cajero
  from public.cajeros
  where username = v_agente
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'agente not found';
  end if;

  select *
    into v_link
  from public.cajeros_jugadores
  where cajero_id = v_cajero.id
    and telefono = v_telefono
  limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'pending link not found for agente + telefono';
  end if;

  begin
    update public.jugadores
    set username = v_username,
        estado = 'asignado'
    where id = v_link.jugador_id
      and pagina = v_cajero.pagina
      and estado = 'pendiente'
      and username is null
    returning id, public.jugadores.username, public.jugadores.estado
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

revoke all on function public.intake_pending_cliente(text, text, text) from public;
revoke all on function public.assign_pending_username(text, text, text, text) from public;

grant execute on function public.intake_pending_cliente(text, text, text) to service_role;
grant execute on function public.assign_pending_username(text, text, text, text) to service_role;

commit;
