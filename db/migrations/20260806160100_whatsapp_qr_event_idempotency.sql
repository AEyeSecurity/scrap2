alter table public.mastercrm_whatsapp_qr_messages
  add column if not exists event_at timestamptz;

update public.mastercrm_whatsapp_qr_messages
set event_at = coalesce(message_timestamp, created_at)
where event_at is null;

alter table public.mastercrm_whatsapp_qr_messages
  alter column event_at set default now(),
  alter column event_at set not null;

-- Preserve every existing attribution before collapsing replayed messages. A
-- match may reference any copy of the same WhatsApp message, so point it to
-- the canonical (oldest) row first instead of relying on ON DELETE SET NULL.
with ranked_messages as (
  select
    id,
    first_value(id) over (
      partition by session_id, message_id
      order by coalesce(message_timestamp, created_at) asc, created_at asc, id asc
    ) as canonical_id,
    row_number() over (
      partition by session_id, message_id
      order by coalesce(message_timestamp, created_at) asc, created_at asc, id asc
    ) as duplicate_number
  from public.mastercrm_whatsapp_qr_messages
  where message_id is not null
)
update public.mastercrm_whatsapp_qr_matches matches
set message_id = ranked_messages.canonical_id
from ranked_messages
where matches.message_id = ranked_messages.id
  and ranked_messages.duplicate_number > 1;

with duplicates as (
  select id,
    row_number() over (
      partition by session_id, message_id
      order by coalesce(message_timestamp, created_at) asc, created_at asc, id asc
    ) as duplicate_number
  from public.mastercrm_whatsapp_qr_messages
  where message_id is not null
)
delete from public.mastercrm_whatsapp_qr_messages messages
using duplicates
where messages.id = duplicates.id
  and duplicates.duplicate_number > 1;

alter table public.mastercrm_whatsapp_qr_messages
  drop constraint if exists uq_mastercrm_whatsapp_qr_messages_session_message;
alter table public.mastercrm_whatsapp_qr_messages
  add constraint uq_mastercrm_whatsapp_qr_messages_session_message unique (session_id, message_id);

create index if not exists ix_mastercrm_whatsapp_qr_messages_owner_event
  on public.mastercrm_whatsapp_qr_messages (owner_id, event_at desc);

alter table public.mastercrm_whatsapp_qr_matches
  add column if not exists event_at timestamptz;

update public.mastercrm_whatsapp_qr_matches matches
set event_at = coalesce(messages.event_at, matches.created_at)
from public.mastercrm_whatsapp_qr_messages messages
where matches.message_id = messages.id
  and matches.event_at is null;

update public.mastercrm_whatsapp_qr_matches
set event_at = created_at
where event_at is null;

alter table public.mastercrm_whatsapp_qr_matches
  alter column event_at set default now(),
  alter column event_at set not null;

create index if not exists ix_mastercrm_whatsapp_qr_matches_owner_event
  on public.mastercrm_whatsapp_qr_matches (owner_id, event_at desc);

with duplicates as (
  select id,
    row_number() over (
      partition by message_id, username, source
      order by
        case status
          when 'assigned' then 1
          when 'validated' then 2
          when 'conflict' then 3
          when 'not_found' then 4
          when 'candidate' then 5
          else 6
        end,
        updated_at desc,
        id asc
    ) as duplicate_number
  from public.mastercrm_whatsapp_qr_matches
  where message_id is not null
)
delete from public.mastercrm_whatsapp_qr_matches matches
using duplicates
where matches.id = duplicates.id
  and duplicates.duplicate_number > 1;

alter table public.mastercrm_whatsapp_qr_matches
  drop constraint if exists uq_mastercrm_whatsapp_qr_matches_message_username_source;
alter table public.mastercrm_whatsapp_qr_matches
  add constraint uq_mastercrm_whatsapp_qr_matches_message_username_source unique (message_id, username, source);

create or replace function public.purge_mastercrm_whatsapp_qr_message_excerpts_v1(
  p_before timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  if p_before is null then
    raise exception using errcode = '22023', message = 'p_before is required';
  end if;

  update public.mastercrm_whatsapp_qr_messages
  set text_excerpt = null
  where event_at < p_before
    and text_excerpt is not null;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.purge_mastercrm_whatsapp_qr_message_excerpts_v1(timestamptz) from public;
grant execute on function public.purge_mastercrm_whatsapp_qr_message_excerpts_v1(timestamptz) to service_role;
