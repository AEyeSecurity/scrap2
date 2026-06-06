begin;

alter table public.landing_sessions
  add column if not exists utm_id text null,
  add column if not exists adset_id text null,
  add column if not exists ad_id text null,
  add column if not exists placement text null;

revoke all on table public.landing_sessions from public;
grant select, insert, update on table public.landing_sessions to service_role;

commit;
