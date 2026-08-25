begin;

alter table public.landing_sessions
  add column if not exists landing_token text null;

alter table public.landing_sessions
  drop constraint if exists ck_landing_sessions_landing_token;

alter table public.landing_sessions
  add constraint ck_landing_sessions_landing_token
    check (landing_token is null or landing_token ~ '^[A-HJ-NP-Z2-9]{8}$');

-- The old message-key index made the text itself the identity. New sessions use
-- an opaque server-issued token and are unique per browser session instead.
drop index if exists public.ux_landing_sessions_pending_message_key;
create unique index if not exists ux_landing_sessions_landing_token
  on public.landing_sessions (landing_token)
  where landing_token is not null;
create unique index if not exists ux_landing_sessions_landing_session_id_tokenized
  on public.landing_sessions (landing_session_id)
  where landing_token is not null;
create index if not exists ix_landing_sessions_pending_token_created
  on public.landing_sessions (landing_token, created_at desc)
  where status = 'pending' and landing_token is not null;

create table if not exists public.landing_contact_outbox (
  id uuid primary key,
  landing_session_id text not null,
  event_id text not null unique,
  event_time timestamptz not null,
  source_payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'leased', 'retry_wait', 'sent', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_retry_at timestamptz null,
  lease_until timestamptz null,
  request_payload jsonb null,
  response_status integer null,
  response_body jsonb null,
  fbtrace_id text null,
  last_error text null,
  sent_at timestamptz null,
  failed_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists ix_landing_contact_outbox_ready
  on public.landing_contact_outbox (status, next_retry_at, created_at);

create or replace function public.claim_next_landing_contact_outbox(p_lease_seconds integer, p_max_attempts integer)
returns setof public.landing_contact_outbox
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.landing_contact_outbox
  where (status = 'pending' or (status = 'retry_wait' and coalesce(next_retry_at, now()) <= now()) or (status = 'leased' and coalesce(lease_until, now()) <= now()))
    and attempts < greatest(1, p_max_attempts)
  order by created_at asc for update skip locked limit 1;
  if v_id is null then return; end if;
  return query update public.landing_contact_outbox
    set status = 'leased', attempts = attempts + 1, max_attempts = greatest(1, p_max_attempts),
        lease_until = now() + make_interval(secs => greatest(1, p_lease_seconds)), next_retry_at = null
    where id = v_id returning *;
end;
$$;

revoke all on table public.landing_sessions from public;
grant select, insert, update on table public.landing_sessions to service_role;
revoke all on table public.landing_contact_outbox from public;
grant select, insert, update on table public.landing_contact_outbox to service_role;
revoke all on function public.claim_next_landing_contact_outbox(integer, integer) from public;
revoke all on function public.claim_next_landing_contact_outbox(integer, integer) from anon, authenticated;
grant execute on function public.claim_next_landing_contact_outbox(integer, integer) to service_role;

commit;
