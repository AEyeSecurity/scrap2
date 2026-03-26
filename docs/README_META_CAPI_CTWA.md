# Meta CAPI para Click-to-WhatsApp

Esta guia documenta la version `v3` de la integracion entre `n8n/Twilio`, `scrap2`, `Supabase` y Meta Conversions API para campañas `Click-to-WhatsApp`.

## Objetivo

La integracion envia dos señales server-side a Meta usando solo datos reales del flujo CTWA:

- `Lead`
  - se encola inmediatamente cuando entra un intake atribuible a anuncio
- `Purchase`
  - se encola cuando el mismo dia local del intake (`America/Argentina/Buenos_Aires`) alcanza el umbral monetario configurado usando el maximo `cargado_hoy` observado de ese `report_date`

## Datos disponibles en este flujo

Se usan solo datos ya presentes en la operacion:

- `ctwaClid`
- `waId`
- telefono del cliente
- `owner_id`, `client_id`
- `owner_key`, `owner_label`
- metadata del anuncio:
  - `ReferralSourceId`
  - `ReferralSourceUrl`
  - `ReferralHeadline`
  - `ReferralBody`
  - `ReferralSourceType`
- `messageSid`
- `accountSid`
- `profileName`
- snapshots diarios:
  - `report_date`
  - `cargado_hoy`
  - `username`

No se usan campos web inexistentes en este flujo:

- `_fbp`
- `_fbc`
- pixel/browser events
- cookies web
- email
- nombre/apellido estructurados

## Flujo

1. `Twilio` recibe el mensaje inicial del anuncio.
2. `n8n` llama a `POST /users/intake-pending` con:
   - `pagina`
   - `telefono`
   - `ownerContext`
   - `sourceContext`
3. `scrap2` persiste el intake con `intake_pending_cliente_v4`.
4. Si `sourceContext` es atribuible (`ReferralSourceType = ad` y `ctwaClid` presente), el backend encola un `Lead` inmediato en `meta_conversion_outbox`.
5. En paralelo, el worker de Meta ejecuta `enqueue_meta_value_signals(...)`.
6. Esa funcion SQL busca:
   - el dia local del intake atribuible
   - snapshots de ese mismo `report_date`
   - el maximo `cargado_hoy` observado en ese dia
7. Si ese valor supera el umbral configurado, se encola un `Purchase`.
8. El worker consume la outbox y envia cada evento al dataset de Meta.

## Reglas de negocio

### `Lead`

Se encola cuando:

- `event_type = intake`
- `ReferralSourceType = ad`
- `ctwaClid` existe

Unicidad:

- una vez por `owner_id + client_id + attribution_key(ctwa_clid)`

### `Purchase`

Se encola cuando:

- existe al menos un intake atribuible
- se toma el `report_date` local del intake en `America/Argentina/Buenos_Aires`
- se calcula el maximo `cargado_hoy` observado en ese mismo dia
- si ese valor es `>= META_VALUE_SIGNAL_THRESHOLD`, se encola

Unicidad:

- una vez por `owner_id + client_id`

### Semantica de `event_time`

- `Lead.event_time`
  - usa `sourceContext.receivedAt` si viene
  - si no, usa `now()`
- `Purchase.event_time`
  - usa `created_at` del snapshot que representa el maximo `cargado_hoy` del dia calificante

## Payload enviado a Meta

### `Lead`

```json
{
  "data": [
    {
      "event_name": "Lead",
      "event_time": 1774453513,
      "event_id": "lead:<sha256hex(owner_id:client_id:ctwa_clid)>",
      "action_source": "system_generated",
      "event_source_url": "<referral_source_url>",
      "user_data": {
        "ph": ["<sha256hex(phone_digits)>"],
        "external_id": ["<sha256hex(owner_id:client_id)>"],
        "ctwa_clid": "<ctwa_clid>"
      },
      "custom_data": {
        "event_source": "crm",
        "lead_event_source": "scrap2",
        "ctwa_clid": "<ctwa_clid>",
        "referral_source_id": "<referral_source_id>",
        "referral_source_url": "<referral_source_url>",
        "referral_headline": "<referral_headline>",
        "referral_body": "<referral_body>",
        "referral_source_type": "ad",
        "wa_id": "<wa_id>",
        "message_sid": "<message_sid>",
        "account_sid": "<account_sid>",
        "profile_name": "<profile_name>",
        "received_at": "<received_at>",
        "owner_key": "<owner_key>",
        "owner_label": "<owner_label>"
      }
    }
  ]
}
```

### `Purchase`

```json
{
  "data": [
    {
      "event_name": "Purchase",
      "event_time": 1774454044,
      "event_id": "value_signal:<sha256hex(owner_id:client_id)>",
      "action_source": "system_generated",
      "event_source_url": "<referral_source_url>",
      "user_data": {
        "ph": ["<sha256hex(phone_digits)>"],
        "external_id": ["<sha256hex(owner_id:client_id)>"],
        "ctwa_clid": "<ctwa_clid>"
      },
      "custom_data": {
        "event_source": "crm",
        "value": 10000,
        "currency": "ARS",
        "ctwa_clid": "<ctwa_clid>",
        "referral_source_id": "<referral_source_id>",
        "referral_source_url": "<referral_source_url>",
        "referral_headline": "<referral_headline>",
        "referral_body": "<referral_body>",
        "referral_source_type": "ad",
        "wa_id": "<wa_id>",
        "message_sid": "<message_sid>",
        "account_sid": "<account_sid>",
        "profile_name": "<profile_name>",
        "received_at": "<received_at>",
        "owner_key": "<owner_key>",
        "owner_label": "<owner_label>",
        "username": "<username>",
        "first_day_report_date": "2026-03-25",
        "first_day_cargado_hoy": 10000
      }
    }
  ]
}
```

## Variables de entorno

```dotenv
META_ENABLED=true
META_DATASET_ID=2123208205169806
META_ACCESS_TOKEN=tu_token_de_meta
META_API_VERSION=v25.0
META_TEST_EVENT_CODE=
META_ACTION_SOURCE=system_generated
META_PAGE_ID=
META_WHATSAPP_BUSINESS_ACCOUNT_ID=
META_LEAD_ENABLED=true
META_PURCHASE_ENABLED=true
META_VALUE_SIGNAL_THRESHOLD=10000
META_VALUE_SIGNAL_CURRENCY=ARS
META_VALUE_SIGNAL_WINDOW_MODE=intake_local_day
META_BATCH_SIZE=1
META_WORKER_CONCURRENCY=2
META_WORKER_POLL_MS=1000
META_WORKER_LEASE_SECONDS=60
META_WORKER_MAX_ATTEMPTS=5
META_WORKER_SCAN_LIMIT=100
```

Notas:

- `META_ACTION_SOURCE` soporta:
  - `system_generated`
  - `business_messaging`
- El modo funcional verificado hoy es `system_generated`.
- `business_messaging` requiere ademas:
  - `META_PAGE_ID` o `META_WHATSAPP_BUSINESS_ACCOUNT_ID`
- Cuando `business_messaging` se usa para eventos de intención, el payload se adapta a `LeadSubmitted` porque Meta no acepta `Lead` en ese contexto.
- `META_VALUE_SIGNAL_WINDOW_MODE` hoy solo soporta:
  - `intake_local_day`

## Dataset activo

Dataset activo validado para produccion:

- `META_DATASET_ID = 2123208205169806`
- `META_API_VERSION = v25.0`

## Supabase

Objetos principales:

- `public.meta_conversion_outbox`
- `public.intake_pending_cliente_v4(...)`
- `public.enqueue_meta_value_signals(...)`
- `public.claim_next_meta_conversion_outbox(...)`

Estados de outbox soportados:

- `pending`
- `leased`
- `retry_wait`
- `sent`
- `failed`
- `discarded`
- `not_qualified`
- `missing_data`

Stages internos:

- `lead`
- `qualified_lead`
- `value_signal`

En `v3`, los eventos activos son:

- `lead -> Lead`
- `value_signal -> Purchase`

## Auditoria minima

`meta_conversion_outbox` registra:

- `request_payload`
- `response_status`
- `response_body`
- `fbtrace_id`
- `qualification_reason`
- `discard_reason`
- `qualified_at`
- `qualification_report_date`
- `qualification_value`

Consultas utiles:

```sql
select
  id,
  owner_id,
  client_id,
  event_stage,
  meta_event_name,
  event_id,
  status,
  response_status,
  fbtrace_id,
  qualification_reason,
  qualification_report_date,
  qualification_value,
  sent_at,
  last_error
from public.meta_conversion_outbox
where owner_id = '...'
  and client_id = '...'
order by created_at asc;
```

```sql
select event_type, payload, created_at
from public.owner_client_events
where owner_id = '...'
  and client_id = '...'
order by created_at asc;
```

## Validacion

1. Configurar `META_TEST_EVENT_CODE`.
2. Verificar en Meta Test Events:
   - `Lead` inmediato al intake atribuible
   - `Purchase` cuando exista valor calificante
3. Confirmar `action_source`.
4. Confirmar `value` y `currency` para `Purchase`.
5. Confirmar en Supabase:
   - outbox `sent`
   - `response_status`
   - `response_body`
   - `fbtrace_id`

## Resultado real validado

Con `TEST82610` se validó exitosamente en Meta:

- `Lead`
  - `event_id = lead:f979e13221e395d8fece1e855d5b3e5ffa32523e0803ffb55817dd1d420d38d7`
  - `fbtrace_id = AzMQc_5IGAg8jckotXXcXop`
- `Purchase`
  - `event_id = value_signal:63df5368fb35dd4077964355a724c695dffa0098dd58bfa430df9f38d3e54898`
  - `fbtrace_id = AQigW0al4FPWUBv2NmUbvyE`

Intentos reales rechazados por Meta:

- `business_messaging` sin `messaging_channel`
- `business_messaging` con `Lead`
- `business_messaging` sin `page_id` o `whatsapp_business_account_id`

## Produccion

Prueba real en modo produccion contra el dataset activo:

- `Lead`
- `Purchase`

sin `test_event_code`, con `action_source = system_generated`.
