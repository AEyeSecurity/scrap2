# Meta CAPI para Click-to-WhatsApp

Esta guia documenta la integracion `v2` entre `n8n/Twilio`, `scrap2`, `Supabase` y el dataset de Meta para campanas `Click-to-WhatsApp`.

## Objetivo

La integracion envia dos conversiones server-side a Meta:

- `Lead`: cuando entra un intake atribuible a un anuncio CTWA.
- `CompleteRegistration`: cuando ese mismo lead ya tiene identidad activa y aparece por primera vez con `cargado_mes > 0` en `report_daily_snapshots`.

No se implementa todavia el umbral `>= 5000`. Eso queda fuera de esta version.

Cambios relevantes de esta version:

- `ctwa_clid` se envia en `user_data`.
- `Lead` ya no se deduplica solo por `owner_id + client_id`; admite multiples leads por cliente si entraron con `ctwa_clid` distintos.
- `CompleteRegistration` mantiene una sola conversion por `owner + cliente`, pero toma el intake atribuible mas reciente previo a la primera calificacion observada.
- `META_ACTION_SOURCE` queda configurable, con default conservador `system_generated`.
- `sourceContext` soporta opcionalmente `clientIpAddress`, `clientUserAgent` y `receivedAt`.

## Flujo

1. `Twilio` recibe el mensaje inicial proveniente del anuncio.
2. `n8n` extrae metadata de atribucion:
   - `ReferralCtwaClid`
   - `ReferralSourceId`
   - `ReferralSourceUrl`
   - `ReferralHeadline`
   - `ReferralBody`
   - `ReferralSourceType`
   - `WaId`
   - `MessageSid`
   - `AccountSid`
   - `ProfileName`
   - `ClientIpAddress` opcional
   - `ClientUserAgent` opcional
   - `ReceivedAt` opcional
3. `n8n` llama a `POST /users/intake-pending` con:
   - `pagina`
   - `telefono`
   - `ownerContext`
   - `sourceContext`
4. `scrap2` persiste el intake con `intake_pending_cliente_v4`.
5. El backend guarda la metadata de CTWA en `owner_client_events.payload`.
6. Si el intake es atribuible (`ReferralSourceType = ad` y `ReferralCtwaClid` presente), el backend encola un `Lead` en `meta_conversion_outbox`.
7. El worker de Meta consume la outbox y envia el evento al Graph API.
8. En paralelo, el worker escanea candidatos de `qualified_lead` usando:
   - `owner_client_links.status = assigned`
   - `owner_client_identities.is_active = true`
   - primer `report_daily_snapshots.cargado_mes > 0`
   - ultimo intake atribuible anterior o igual a ese momento
9. Si se cumple eso, se encola y envia `CompleteRegistration`.

## Reglas de atribucion

- `Lead` solo se encola cuando:
  - `ReferralSourceType = ad`
  - `ctwaClid` existe
- `Lead.attribution_key = lower(ctwaClid)`
- para el mismo `owner + client`, un `ctwaClid` nuevo genera un `Lead` nuevo
- `CompleteRegistration` se envia una sola vez por `owner + client`
- el `source_payload` de `CompleteRegistration` sale del intake atribuible mas reciente ocurrido antes o en el momento de la primera calificacion observada

## Semantica de `event_time`

- `Lead.event_time`:
  - usa `sourceContext.receivedAt` si llega y es valido
  - si no, usa el momento del enqueue server-side
- `CompleteRegistration.event_time`:
  - usa `created_at` del primer `report_daily_snapshots` con `cargado_mes > 0`
  - representa el primer momento observado por reportes, no necesariamente la hora exacta de la primera carga real

## Componentes

- [src/meta-source-context.ts](C:/Guiga/CIT/Master%20CRM%20RL/scrap2/src/meta-source-context.ts)
- [src/meta-conversions.ts](C:/Guiga/CIT/Master%20CRM%20RL/scrap2/src/meta-conversions.ts)
- [src/meta-conversions-store.ts](C:/Guiga/CIT/Master%20CRM%20RL/scrap2/src/meta-conversions-store.ts)
- [src/meta-conversions-worker.ts](C:/Guiga/CIT/Master%20CRM%20RL/scrap2/src/meta-conversions-worker.ts)
- [db/migrations/20260317_meta_conversions.sql](C:/Guiga/CIT/Master%20CRM%20RL/scrap2/db/migrations/20260317_meta_conversions.sql)
- [db/migrations/20260318_meta_conversions_v2.sql](C:/Guiga/CIT/Master%20CRM%20RL/scrap2/db/migrations/20260318_meta_conversions_v2.sql)

## Contrato HTTP

`POST /users/intake-pending` acepta `sourceContext` opcional.

Ejemplo:

```json
{
  "pagina": "ASN",
  "telefono": "+5491199926171",
  "ownerContext": {
    "ownerKey": "asnlucas10:lucas10",
    "ownerLabel": "Lucas10",
    "actorAlias": "Lucas10",
    "actorPhone": "+5493516549344"
  },
  "sourceContext": {
    "ctwaClid": "clid-123",
    "referralSourceId": "6904268485256",
    "referralSourceUrl": "https://fb.me/8cuWQu6gD",
    "referralHeadline": "ROYAL LUCK",
    "referralBody": "Prueba Codex Meta",
    "referralSourceType": "ad",
    "waId": "5491199926171",
    "messageSid": "SM123",
    "accountSid": "AC123",
    "profileName": "Codex Meta Test",
    "clientIpAddress": "181.45.10.22",
    "clientUserAgent": "Mozilla/5.0",
    "receivedAt": "2026-03-18T12:00:00.000Z"
  }
}
```

## Variables de entorno

Agregar al contenedor/backend:

```dotenv
META_ENABLED=true
META_DATASET_ID=900004339427467
META_ACCESS_TOKEN=tu_token_de_meta
META_API_VERSION=v23.0
META_TEST_EVENT_CODE=TEST87269
META_ACTION_SOURCE=system_generated
META_BATCH_SIZE=1
META_WORKER_CONCURRENCY=2
META_WORKER_POLL_MS=1000
META_WORKER_LEASE_SECONDS=60
META_WORKER_MAX_ATTEMPTS=5
META_WORKER_SCAN_LIMIT=100
```

Notas:

- `META_ENABLED=false` desactiva completamente la integracion.
- `META_TEST_EVENT_CODE` es opcional, pero conviene usarlo para pruebas.
- `META_ACTION_SOURCE` permite:
  - `system_generated`
  - `business_messaging`
- En esta version el default sigue siendo `system_generated`.
- Si se quiere probar `business_messaging`, hacerlo siempre con `META_TEST_EVENT_CODE` y validacion manual en Events Manager.
- `META_BATCH_SIZE` prepara batching futuro, pero el worker sigue despachando unitariamente en esta version.
- El backend no manda `event_source_url` para CTWA puro.

## Esquema en Supabase

Objetos principales:

- tabla `public.meta_conversion_outbox`
- funcion `public.intake_pending_cliente_v4(...)`
- funcion `public.enqueue_meta_qualified_leads(...)`
- funcion `public.claim_next_meta_conversion_outbox(...)`

Estados de la outbox:

- `pending`
- `leased`
- `retry_wait`
- `sent`
- `failed`

Etapas:

- `lead`
- `qualified_lead`

`meta_conversion_outbox` ahora agrega:

- `attribution_key`

Unicidad:

- `Lead`: unico por `owner_id + client_id + event_stage + attribution_key`
- `qualified_lead`: unico por `owner_id + client_id + event_stage`

## Workflow de n8n

El workflow operativo editado fuera del repo quedo en:

- `C:\Users\Guille\Downloads\Wpp campania.json`

Cambio esperado:

- agregar una rama paralela despues de `Assign Agent %1`
- `Assign Agent %1 -> Edit Fields1 -> HTTP Request15`
- `HTTP Request15` debe llamar a `http://127.0.0.1:3000/users/intake-pending`
- enviar `ownerContext` y `sourceContext`

Este archivo no vive dentro del repo Git, asi que no se versiona automaticamente.

## Validacion

Para Meta:

1. Abrir `CRM RL -> Probar eventos`.
2. Mantener abierta la pantalla.
3. Verificar eventos `Lead` y `CompleteRegistration` con `META_TEST_EVENT_CODE`.
4. Confirmar que `ctwa_clid` aparezca dentro de `user_data`.

Para Supabase:

- revisar `owner_client_events.payload`
- revisar `meta_conversion_outbox`

Consultas utiles:

```sql
select event_type, payload
from public.owner_client_events
where client_id = '...'
order by created_at desc;
```

```sql
select event_stage, meta_event_name, attribution_key, status, attempts, last_error, sent_at
from public.meta_conversion_outbox
where client_id = '...'
order by created_at desc;
```

## Estado probado

Validado en codigo:

- `ctwa_clid` presente en `user_data`
- `clientIpAddress` y `clientUserAgent` se envian solo cuando existen
- `Lead` usa `receivedAt` si viene en `sourceContext`
- backend compila y tests cubren payload de Meta + intake atribuible

## Pendientes operativos

- aplicar la migracion `20260318_meta_conversions_v2.sql` en Supabase
- publicar el workflow de `n8n`
- redeploy del contenedor backend con las nuevas variables
- si se quiere probar `business_messaging`, hacerlo primero en modo test
