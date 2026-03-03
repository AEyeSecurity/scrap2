create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.cajeros (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('RdA', 'ASN')),
  username text not null check (username = lower(btrim(username))),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_cajeros_pagina_username unique (pagina, username),
  constraint uq_cajeros_id_pagina unique (id, pagina)
);

create table if not exists public.jugadores (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('RdA', 'ASN')),
  username text not null check (username = lower(btrim(username))),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_jugadores_pagina_username unique (pagina, username),
  constraint uq_jugadores_id_pagina unique (id, pagina)
);

create table if not exists public.cajeros_jugadores (
  id uuid primary key default gen_random_uuid(),
  pagina text not null check (pagina in ('RdA', 'ASN')),
  cajero_id uuid not null,
  jugador_id uuid not null,
  telefono text null check (telefono ~ '^\+[1-9][0-9]{7,14}$'),
  source text not null check (source in ('create-player', 'manual-assign')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_cajeros_jugadores_jugador unique (jugador_id),
  constraint fk_cajeros_jugadores_cajero foreign key (cajero_id, pagina) references public.cajeros (id, pagina),
  constraint fk_cajeros_jugadores_jugador foreign key (jugador_id, pagina) references public.jugadores (id, pagina)
);

create unique index if not exists uq_cajeros_jugadores_cajero_telefono
  on public.cajeros_jugadores (cajero_id, telefono)
  where telefono is not null;

drop trigger if exists trg_cajeros_set_updated_at on public.cajeros;
create trigger trg_cajeros_set_updated_at
before update on public.cajeros
for each row execute function public.set_updated_at();

drop trigger if exists trg_jugadores_set_updated_at on public.jugadores;
create trigger trg_jugadores_set_updated_at
before update on public.jugadores
for each row execute function public.set_updated_at();

drop trigger if exists trg_cajeros_jugadores_set_updated_at on public.cajeros_jugadores;
create trigger trg_cajeros_jugadores_set_updated_at
before update on public.cajeros_jugadores
for each row execute function public.set_updated_at();

alter table public.cajeros enable row level security;
alter table public.jugadores enable row level security;
alter table public.cajeros_jugadores enable row level security;
