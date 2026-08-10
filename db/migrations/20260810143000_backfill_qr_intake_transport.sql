begin;

-- Only exact, routed inbound QR messages are authoritative enough to repair
-- intake events created before intakeTransport was persisted.
with qr_intake_evidence as (
  select distinct events.id
  from public.owner_client_events events
  join public.clients clients
    on clients.id = events.client_id
  join public.mastercrm_whatsapp_qr_messages messages
    on messages.event_at = events.occurred_at
   and messages.direction = 'inbound'
   and messages.route_status = 'resolved'
   and regexp_replace(messages.client_phone_e164, '\D', '', 'g') =
       regexp_replace(clients.phone_e164, '\D', '', 'g')
  join public.mastercrm_whatsapp_qr_message_resolutions resolutions
    on resolutions.message_id = messages.id
   and resolutions.owner_id = events.owner_id
  where events.event_type = 'intake'
    and nullif(events.payload ->> 'IntakeTransport', '') is null
    and nullif(events.payload -> 'source_context' ->> 'intakeTransport', '') is null
)
update public.owner_client_events events
set payload = jsonb_set(
  coalesce(events.payload, '{}'::jsonb),
  '{source_context}',
  case
    when jsonb_typeof(events.payload -> 'source_context') = 'object'
      then events.payload -> 'source_context'
    else '{}'::jsonb
  end || jsonb_build_object('intakeTransport', 'whatsapp_qr'),
  true
)
from qr_intake_evidence evidence
where events.id = evidence.id;

commit;
