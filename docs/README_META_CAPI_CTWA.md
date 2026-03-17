# Meta CAPI para Click-to-WhatsApp

Esta guia documenta la integracion `v1` entre `n8n/Twilio`, `scrap2`, `Supabase` y el dataset de Meta para campañas `Click-to-WhatsApp`.

## Objetivo

La integracion envia dos conversiones server-side a Meta:

- `Lead`: cuando entra un intake atribuible a un anuncio CTWA.
- `CompleteRegistration`: cuando ese mismo lead ya tiene identidad activa y aparece por primera vez con `cargado_mes > 0` en `report_daily_snapshots`.

No se implementa todavia el umbral `>= 5000`. Eso queda para una `v2`.

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
   - primera `report_daily_snapshots.cargado_mes > 0`
9. Si se cumple eso y existe un intake atribuible previo, se encola y envia `CompleteRegistration`.

## Componentes nuevos

- [src/meta-source-context.ts](C:/Guiga/CIT/scrap2/src/meta-source-context.ts)
- [src/meta-conversions.ts](C:/Guiga/CIT/scrap2/src/meta-conversions.ts)
- [src/meta-conversions-store.ts](C:/Guiga/CIT/scrap2/src/meta-conversions-store.ts)
- [src/meta-conversions-worker.ts](C:/Guiga/CIT/scrap2/src/meta-conversions-worker.ts)
- [db/migrations/20260317_meta_conversions.sql](C:/Guiga/CIT/scrap2/db/migrations/20260317_meta_conversions.sql)

## Contrato HTTP

`POST /users/intake-pending` ahora acepta `sourceContext` opcional.

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
    "profileName": "Codex Meta Test"
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
META_WORKER_CONCURRENCY=2
META_WORKER_POLL_MS=1000
META_WORKER_LEASE_SECONDS=60
META_WORKER_MAX_ATTEMPTS=5
META_WORKER_SCAN_LIMIT=100
```

Notas:

- `META_ENABLED=false` desactiva completamente la integracion.
- `META_TEST_EVENT_CODE` es opcional, pero conviene usarlo para pruebas.
- El backend ya no manda `event_source_url` para CTWA puro, para evitar ruido de dominios web en `Diagnostico`.

## Esquema en Supabase

La migracion nueva crea:

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

## Workflow de n8n

El workflow operativo editado fuera del repo quedo en:

- `C:\Users\Guille\Downloads\Wpp campania.json`

Cambio esperado:

- agregar una rama paralela despues de `Assign Agent %1`
- `Assign Agent %1 -> Edit Fields1 -> HTTP Request15`
- `HTTP Request15` debe llamar a `http://127.0.0.1:3000/users/intake-pending`
- enviar `ownerContext` y `sourceContext`

Este archivo no vive dentro del repo Git, asi que no se versiona automaticamente con este commit.

## Validacion

Para Meta:

1. Abrir `CRM RL -> Probar eventos`.
2. Mantener abierta la pantalla.
3. Verificar eventos `Lead` y `CompleteRegistration` con `TEST87269`.

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
select event_stage, meta_event_name, status, attempts, last_error, sent_at
from public.meta_conversion_outbox
where client_id = '...'
order by created_at desc;
```

## Estado probado

Se valido en ambiente real:

- migracion aplicada en Supabase
- `Lead` enviado con `status = sent`
- `CompleteRegistration` enviado con `status = sent`
- metadata CTWA persistida en `owner_client_events.payload`

## Pendientes operativos

- importar/publicar el workflow de `n8n`
- redeploy del contenedor backend con las nuevas variables
- rotar la `SUPABASE_SERVICE_ROLE_KEY` y el token de Meta compartidos durante esta implementacion
