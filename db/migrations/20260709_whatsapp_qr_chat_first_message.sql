alter table public.mastercrm_whatsapp_qr_contacts
  add column if not exists first_message_at timestamptz null,
  add column if not exists first_message_direction text null
    check (first_message_direction in ('inbound', 'outbound')),
  add column if not exists intake_recorded_at timestamptz null;

create index if not exists ix_mastercrm_whatsapp_qr_contacts_owner_first_message
  on public.mastercrm_whatsapp_qr_contacts (owner_id, first_message_at);

create or replace function public.record_whatsapp_qr_chat_message_v1(
  p_owner_id uuid,
  p_phone_e164 text,
  p_message_at timestamptz,
  p_direction text
)
returns table (
  first_message_at timestamptz,
  first_message_direction text,
  intake_recorded_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_owner_id is null or p_phone_e164 is null or p_message_at is null then
    raise exception using errcode = '22023', message = 'owner_id, phone_e164 and message_at are required';
  end if;

  if p_direction not in ('inbound', 'outbound') then
    raise exception using errcode = '22023', message = 'direction must be inbound or outbound';
  end if;

  return query
  insert into public.mastercrm_whatsapp_qr_contacts as c (
    owner_id,
    phone_e164,
    first_message_at,
    first_message_direction,
    last_seen_at,
    updated_at
  )
  values (p_owner_id, p_phone_e164, p_message_at, p_direction, now(), now())
  on conflict (owner_id, phone_e164) do update
  set
    first_message_at = least(coalesce(c.first_message_at, excluded.first_message_at), excluded.first_message_at),
    first_message_direction = case
      when c.first_message_at is null or excluded.first_message_at < c.first_message_at
        then excluded.first_message_direction
      else c.first_message_direction
    end,
    updated_at = now()
  returning c.first_message_at, c.first_message_direction, c.intake_recorded_at;
end;
$$;

create or replace function public.mark_whatsapp_qr_intake_recorded_v1(
  p_owner_id uuid,
  p_phone_e164 text
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recorded_at timestamptz;
begin
  update public.mastercrm_whatsapp_qr_contacts
  set intake_recorded_at = coalesce(intake_recorded_at, now()),
      updated_at = now()
  where owner_id = p_owner_id
    and phone_e164 = p_phone_e164
  returning intake_recorded_at into v_recorded_at;

  return v_recorded_at;
end;
$$;

revoke all on function public.record_whatsapp_qr_chat_message_v1(uuid, text, timestamptz, text) from public;
revoke all on function public.mark_whatsapp_qr_intake_recorded_v1(uuid, text) from public;
grant execute on function public.record_whatsapp_qr_chat_message_v1(uuid, text, timestamptz, text) to service_role;
grant execute on function public.mark_whatsapp_qr_intake_recorded_v1(uuid, text) to service_role;

-- Seed: primer mensaje conocido por chat desde los mensajes QR ya persistidos.
with firsts as (
  select distinct on (m.owner_id, m.client_phone_e164)
    m.owner_id,
    m.client_phone_e164 as phone_e164,
    coalesce(m.message_timestamp, m.created_at) as first_message_at,
    m.direction
  from public.mastercrm_whatsapp_qr_messages m
  where m.direction in ('inbound', 'outbound')
  order by m.owner_id, m.client_phone_e164, coalesce(m.message_timestamp, m.created_at) asc
)
insert into public.mastercrm_whatsapp_qr_contacts as c (
  owner_id,
  phone_e164,
  first_message_at,
  first_message_direction,
  last_seen_at,
  updated_at
)
select f.owner_id, f.phone_e164, f.first_message_at, f.direction, now(), now()
from firsts f
on conflict (owner_id, phone_e164) do update
set
  first_message_at = least(coalesce(c.first_message_at, excluded.first_message_at), excluded.first_message_at),
  first_message_direction = case
    when c.first_message_at is null or excluded.first_message_at < c.first_message_at
      then excluded.first_message_direction
    else c.first_message_direction
  end,
  updated_at = now();
