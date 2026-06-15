begin;

alter table public.landing_sessions
  add column if not exists landing_variant text null;

commit;
