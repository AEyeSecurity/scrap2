begin;

alter table public.cajeros_jugadores
  drop constraint if exists cajeros_jugadores_telefono_check;

alter table public.cajeros_jugadores
  drop constraint if exists ck_cajeros_jugadores_telefono_e164;

alter table public.cajeros_jugadores
  add constraint ck_cajeros_jugadores_telefono_e164
  check (
    telefono is null
    or telefono ~ '^\+[1-9][0-9]{7,14}$'
  );

commit;
