# Scrap2 Operations

Esta guia explica como operar `scrap2` cuando se retoma el repo en otro chat o en otra maquina.

## Repo y cuenta GitHub

Regla fija:

- Backend siempre usa la cuenta `AEyeSecurity`

Remoto esperado:

- `origin = https://github.com/AEyeSecurity/scrap2.git`

Branch principal usada en esta etapa:

- `main`

Verificar antes de trabajar:

```powershell
cd "C:\Guiga\CIT\Master CRM RL\scrap2"
git branch --show-current
git remote -v
git status --short
```

Push esperado:

```powershell
git push origin main
```

## Rol del repo

`scrap2` es el backend operativo del sistema:

- Fastify para API HTTP
- Playwright para automatizacion
- Supabase para persistencia
- rutas `mastercrm-*` para el CRM web
- rutas operativas para reportes, fondos, creacion de usuarios y scraping

Archivos mas importantes:

- `src/server.ts`
- `src/mastercrm-user-store.ts`
- `src/player-phone-store.ts`
- `src/report-run-store.ts`
- `db/migrations/`

## Variables de entorno

Necesarias para el flujo CRM:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MASTERCRM_STAFF_LINK_PASSWORD`

Necesarias para Meta CAPI CTWA V3:

- `META_ENABLED`
- `META_DATASET_ID`
- `META_ACCESS_TOKEN`
- `META_API_VERSION`
- `META_ACTION_SOURCE`
- `META_LEAD_ENABLED`
- `META_PURCHASE_ENABLED`
- `META_VALUE_SIGNAL_THRESHOLD`
- `META_VALUE_SIGNAL_CURRENCY`
- `META_VALUE_SIGNAL_WINDOW_MODE`
- `META_WORKER_CONCURRENCY`
- `META_WORKER_POLL_MS`
- `META_WORKER_LEASE_SECONDS`
- `META_WORKER_MAX_ATTEMPTS`
- `META_WORKER_SCAN_LIMIT`

No guardarlas en el repo.

### Despliegue productivo en ServerCIT

Fuente de verdad operativa para produccion:

- host: `C:\ServerCIT\services\megascrap`
- env productivo local del host:
  - `C:\ServerCIT\services\megascrap\.env.production`
- script de deploy del host:
  - `C:\ServerCIT\scripts\deploy_megascrap_from_main.ps1`

Regla actual:

- el deploy ya no hereda variables del contenedor previo
- el script siempre lee `.env.production`
- `.env.production` sigue ignorado por Git

Prechecks cerrados del script antes de recrear `scrap2-api`:

- commit esperado en `origin/main`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MASTERCRM_STAFF_LINK_PASSWORD`
- `META_ACCESS_TOKEN`
- valores exactos para el rollout:
  - `META_ENABLED = true`
  - `META_DATASET_ID = 2123208205169806`
  - `META_API_VERSION = v25.0`
  - `META_ACTION_SOURCE = system_generated`
  - `META_LEAD_ENABLED = true`
  - `META_PURCHASE_ENABLED = true`
  - `META_VALUE_SIGNAL_THRESHOLD = 10000`
  - `META_VALUE_SIGNAL_CURRENCY = ARS`
  - `META_VALUE_SIGNAL_WINDOW_MODE = intake_local_day`
  - `META_BATCH_SIZE = 1`
  - `META_WORKER_CONCURRENCY = 2`
  - `META_WORKER_POLL_MS = 1000`
  - `META_WORKER_LEASE_SECONDS = 60`
  - `META_WORKER_MAX_ATTEMPTS = 5`
  - `META_WORKER_SCAN_LIMIT = 100`
- bloqueo si aparecen:
  - `META_TEST_EVENT_CODE`
  - `META_PAGE_ID`
  - `META_WHATSAPP_BUSINESS_ACCOUNT_ID`
- precheck real de Supabase:
  - lectura de `meta_conversion_outbox`
  - RPC `enqueue_meta_value_signals(...)`

## Levantar local

```powershell
cd "C:\Guiga\CIT\Master CRM RL\scrap2"
$env:SUPABASE_URL="..."
$env:SUPABASE_SERVICE_ROLE_KEY="..."
$env:MASTERCRM_STAFF_LINK_PASSWORD="..."
$env:META_ENABLED="true"
$env:META_DATASET_ID="2123208205169806"
$env:META_ACCESS_TOKEN="..."
$env:META_API_VERSION="v25.0"
$env:META_ACTION_SOURCE="system_generated"
$env:META_LEAD_ENABLED="true"
$env:META_PURCHASE_ENABLED="true"
$env:META_VALUE_SIGNAL_THRESHOLD="10000"
$env:META_VALUE_SIGNAL_CURRENCY="ARS"
$env:META_VALUE_SIGNAL_WINDOW_MODE="intake_local_day"
npm start -- server
```

Backend esperado:

- `http://127.0.0.1:3000`

## Meta CAPI CTWA V3

Semantica operativa:

- `Lead`
  - se encola inmediatamente desde `POST /users/intake-pending`
  - solo si `sourceContext` es atribuible:
    - `ReferralSourceType = ad`
    - `ctwaClid` presente
- `Purchase`
  - se encola de forma asíncrona por worker
  - usa `enqueue_meta_value_signals(...)`
  - califica si el mismo dia local del intake (`America/Argentina/Buenos_Aires`) alcanza `META_VALUE_SIGNAL_THRESHOLD` usando el maximo `cargado_hoy` observado

Payload enviado a Meta:

- `ph`
- `external_id`
- `ctwa_clid`
- metadata del anuncio disponible
- `value` y `currency` solo en `Purchase`

Campos descartados explícitamente en este flujo:

- `_fbp`
- `_fbc`
- Pixel/browser events
- email
- nombre/apellido

Campo adicional enviado cuando existe metadata de anuncio:

- `event_source_url`
  - se mapea desde `ReferralSourceUrl`

Compatibilidad real del asset:

- `system_generated` esta validado con Meta y hoy es el modo funcional por defecto
- dataset CRM activo validado:
  - `2123208205169806`
- version de Graph API validada:
  - `v25.0`
- `business_messaging` solo debe activarse si tambien se configuran:
  - `META_PAGE_ID` o
  - `META_WHATSAPP_BUSINESS_ACCOUNT_ID`
- en ese modo, Meta exige:
  - `messaging_channel = whatsapp`
  - `LeadSubmitted` en lugar de `Lead` para la señal de intención

Auditoria:

- tabla: `public.meta_conversion_outbox`
- columnas relevantes:
  - `request_payload`
  - `response_status`
  - `response_body`
  - `fbtrace_id`
  - `qualification_reason`
  - `discard_reason`
  - `qualification_report_date`
  - `qualification_value`

Checklist de verificación:

1. `npm run build`
2. `npm test -- tests/meta-conversions.test.ts tests/server.test.ts`
3. aplicar migración `20260326_meta_ctwa_v3_lead_purchase.sql`
4. levantar backend con `META_TEST_EVENT_CODE`
5. verificar `Lead` y `Purchase` en Test Events
6. verificar `sent`, `response_status` y `fbtrace_id` en `meta_conversion_outbox`
7. hacer una validacion final sin `META_TEST_EVENT_CODE` antes de cerrar produccion

### Activacion productiva validada el `2026-03-26`

Despliegue real cerrado:

- commit desplegado:
  - `0538b9b`
- modo activo:
  - `system_generated`
- dataset activo:
  - `2123208205169806`
- Graph API:
  - `v25.0`
- `business_messaging` queda fuera de alcance en esta activacion
- no se usa:
  - `META_TEST_EVENT_CODE`
  - `META_PAGE_ID`
  - `META_WHATSAPP_BUSINESS_ACCOUNT_ID`

Validacion tecnica real:

- `scrap2-api` recreado con `.env.production`
- `GET /` responde `404 Not Found` esperado
- `POST /users/intake-pending` sigue respondiendo normal
- sin `WARN/ERROR` del worker Meta despues del redeploy final
- `meta_conversion_outbox` ya persiste:
  - `request_payload`
  - `response_status`
  - `response_body`
  - `fbtrace_id`

Validacion funcional real desde el backend/worker del servidor:

- smoke `Lead` originado por `POST /users/intake-pending`
- owner usado:
  - `asnlucas10:lucas10`
- telefono sintetico de smoke:
  - `+5491123456701`
- `Lead` validado:
  - outbox id: `03618bd3-d44f-4df1-873a-f7486eb18b37`
  - event id:
    - `lead:9a8e61f4048f18528bf0b1fde6a2853208fa406e19212a5091306140771815bb`
  - `status = sent`
  - `response_status = 200`
  - `fbtrace_id = AsuLCso_1uA-TaMOYSejdl_`
- payload persistido confirmado:
  - `action_source = system_generated`
  - `event_source_url` desde `ReferralSourceUrl`
  - `custom_data.event_source = crm`
  - `custom_data.lead_event_source = scrap2`

Validacion `Purchase` con worker real:

- se reencolo el registro que habia quedado `failed` solo por token viejo invalido
- outbox id:
  - `1c653f7a-eb2f-4ee5-b694-e1c91582200b`
- event id:
  - `value_signal:7eb57825214cb297946269a66dfd480fca64500224f9925873fef8c620717b83`
- resultado final:
  - `status = sent`
  - `response_status = 200`
  - `fbtrace_id = Aj7hwHAy1ZXW9UwLJiC-wFu`
- payload persistido confirmado:
  - `action_source = system_generated`
  - `event_source_url = https://fb.me/6j8cikXYF`
  - `custom_data.event_source = crm`
  - `value = 35000`
  - `currency = ARS`

Regla operativa de rollback:

- rollback inmediato si:
  - el backend no levanta
  - `POST /users/intake-pending` deja de responder
  - el worker Meta entra en errores repetidos de configuracion o payload
  - la outbox empieza a acumular `failed` estructurales
- accion:
  - restaurar contenedor previo
  - restaurar env previo si hace falta

## Flujo CRM implementado

Endpoints usados por el frontend:

- `POST /mastercrm-register`
- `POST /mastercrm-login`
- `POST /mastercrm-clients`
- `POST /mastercrm-link-cashier`
- `POST /mastercrm-owner-financials`

## Errores ASN para usuario inexistente

Regla actual:

- si una operacion ASN apunta a un `usuario` que no existe, la API no debe exponer errores tecnicos de Playwright
- el mensaje estandar visible para cliente es:
  - `No se ha encontrado el usuario xxxx`

### Precheck antes de encolar

Rutas cubiertas:

- `POST /users/deposit` para:
  - `consultar_saldo`
  - `carga`
  - `descarga`
  - `descarga_total`
- `POST /users/assign-phone`

Comportamiento:

- si el checker ASN detecta que el usuario no existe:
  - responde `404`
  - no crea `jobId`
  - no encola ningun job
  - devuelve:

```json
{
  "message": "No se ha encontrado el usuario xxxx",
  "code": "ASN_USER_NOT_FOUND",
  "details": {
    "usuario": "xxxx"
  }
}
```

- si el checker ASN no puede confirmar por una razon tecnica pero tampoco detecta `NOT_FOUND`:
  - `POST /users/deposit` no corta
  - se encola el job turbo igual
  - se registra warning en logs:
    - `ASN user precheck was inconclusive; continuing with turbo job enqueue`
- `POST /users/assign-phone` sigue siendo estricto:
  - `NOT_FOUND` devuelve `404`
  - cualquier falla tecnica sigue devolviendo `500`
  - `code = ASN_USER_CHECK_FAILED`

### Verificacion ASN robustecida

`src/asn-user-check.ts` ya no depende de una sola navegacion a `JugadoresCD.php`.

Flujo actual:

- login headless
- probea `JugadoresCD.php?usr=...`
- si la navegacion se aborta por redireccion, espera estabilizacion en vez de fallar de inmediato
- si no alcanza con esa vista, probea tambien `Jugadores.php?usr=...`
- solo devuelve `NOT_FOUND` si ASN realmente muestra texto de usuario inexistente
- si ninguna vista confirma ni niega, el resultado es `INTERNAL`

### `POST /users/assign-phone` consumido por el CRM

El dashboard web ahora usa directamente esta ruta para asignar o cambiar usernames desde `Estadisticas -> Detalle del cliente`.

Payload esperado:

```json
{
  "pagina": "ASN",
  "usuario": "cindy45",
  "agente": "Pity24",
  "contrasena_agente": "secret",
  "telefono": "+5492996051841",
  "ownerContext": {
    "ownerKey": "asnlucas10:lucas10",
    "ownerLabel": "Lucas10"
  }
}
```

Reglas de negocio:

- la validacion ASN se hace antes de persistir
- la asignacion sigue siendo por `ownerContext`
- aplica tanto a `pending` como a `assigned`
- el frontend no guarda credenciales ASN; las pide en cada submit

Mensajes HTTP visibles ya cerrados para esta ruta:

- `404 ASN_USER_NOT_FOUND`
  - `No se ha encontrado el usuario xxxx`
- `500 ASN_USER_CHECK_FAILED`
  - `No se pudo verificar el usuario en ASN`
- `409 USERNAME_ASSIGNED_TO_OTHER_OWNER`
  - `El usuario ya esta asignado a otro cajero`
- `409 USERNAME_ALREADY_EXISTS_IN_PAGINA`
  - `Ese usuario ya esta vinculado a otro numero dentro de ASN`
- `409 PHONE_ALREADY_ASSIGNED_FOR_OWNER`
  - `Ese numero ya tiene otro usuario asignado para este cajero`
- `404 OWNER_CLIENT_LINK_NOT_FOUND`
  - `No se encontro el cliente dentro de la cartera del cajero`

Cobertura agregada:

- conflicto por username ya tomado dentro de ASN
- conflicto por telefono ya asignado dentro del owner
- owner-link inexistente

Smoke real validado para el flujo CRM:

- `+5492325478199 -> gabrie16`
- `+5492996051841 -> cindy45`
- con login ASN:
  - `agente = Pity24`
  - `contrasena_agente = pityboca1509`

### `POST /users/unassign-phone` consumido por el CRM

El dashboard web ahora usa esta ruta para desvincular un username desde `Estadisticas -> Detalle del cliente`, con el icono de link roto debajo del lapiz.

Payload esperado:

```json
{
  "pagina": "ASN",
  "telefono": "+5492996051841",
  "ownerContext": {
    "ownerKey": "asnlucas10:lucas10",
    "ownerLabel": "Lucas10"
  }
}
```

Comportamiento:

- resuelve el owner exacto por `ownerKey + pagina`
- resuelve el cliente global por `phone_e164`
- busca el `owner_client_link` de ese owner y ese telefono
- desactiva la identidad activa en `owner_client_identities`
- ejecuta `refresh_owner_client_link_status_v1`
- registra evento `unassign_username`
- deja el link nuevamente en `pending`

Respuesta exitosa:

```json
{
  "status": "ok",
  "previousUsername": "cindy45",
  "currentStatus": "pending",
  "unlinked": true
}
```

Errores legibles:

- `404 OWNER_CLIENT_LINK_NOT_FOUND`
  - `No se encontro el cliente dentro de la cartera del cajero`

Smoke real validado:

- se disparo la desvinculacion sobre `+5492996051841 -> cindy45`
- el backend dejo el cliente en `pending`
- despues se restauro a `assigned` para no dejar datos alterados en Supabase

### Traduccion residual dentro de jobs

Si un caso de usuario inexistente se escapa al precheck y explota dentro del job ASN:

- `GET /jobs/:id` ya no debe mostrar mensajes como:
  - `Step failed: 02-goto-user-cd (...)`
  - `No visible element found for selector: ...`
- el backend traduce esos errores a:
  - `No se ha encontrado el usuario xxxx`

Esto aplica sobre:

- `src/asn-funds-job.ts`
- `src/asn-report-job.ts`

Helper central:

- `src/asn-user-error.ts`

### Verificacion recomendada

```powershell
npm test -- tests/server.test.ts tests/asn-user-error.test.ts
npm run build
```

Cobertura validada:

- `POST /users/deposit` devuelve `404` inmediato para usuario ASN inexistente
- `POST /users/deposit` sigue encolando cuando el precheck es inconcluso
- `POST /users/deposit` no hace precheck para `reporte`
- `POST /users/assign-phone` devuelve el mismo mensaje amigable
- los jobs ASN traducen errores tecnicos residuales al mensaje limpio

## Modo turbo ASN para Docker

Regla operativa actual:

- el path final de ASN para fondos corre en modo turbo:
  - `headless = true`
  - `debug = false`
  - `slowMo = 0`
  - `timeoutMs <= 15000`
- para `POST /users/deposit`, ese modo se impone desde `resolveDepositExecutionOptions`

### Cambio importante en lectura post-operacion

El error viejo:

- `Step failed: 06-read-saldo-after (page.goto ... is interrupted by another navigation ...)`

venia de competir contra la redireccion propia de ASN despues del submit.

Correccion aplicada en `src/asn-funds-job.ts`:

- despues del submit ya no hace `goto` inmediato al panel del usuario
- primero espera que la pagina se estabilice
- solo hace un refresh tardio si sigue sin poder leer el saldo esperado
- `gotoWithRetry` ahora trata tambien `interrupted by another navigation` como navegacion abortada tolerable

### Smoke real validado en Docker

Validacion hecha el `2026-03-16` con imagen construida desde el `Dockerfile` y API expuesta en `127.0.0.1:3001`.

Credenciales ASN usadas:

- agente: `luuucas10`
- password: `australopitecus12725`

Operacion 1:

- usuario: `Ariel728`
- operacion: `carga`
- cantidad: `15238`
- resultado: `succeeded`
- `06-read-saldo-after = ok`

Operacion 2:

- usuario: `Ariel728`
- operacion: `descarga_total`
- resultado: `succeeded`
- `06-read-saldo-after = ok`

Resultado observado:

- carga aplicada: `15.238,00`
- descarga total aplicada: `15.238,00`
- sin reproduccion del choque de navegacion post-submit

## RdA validado en Docker

Estado validado el `2026-03-27` con imagen construida desde el `Dockerfile` y API expuesta en `127.0.0.1:3006`.
Revalidado el `2026-04-07` con imagen construida desde el `Dockerfile` y API expuesta en `127.0.0.1:3008` por el layout responsive de `/users/all`.

Flujos `RdA` probados contra el contenedor:

- `POST /login`
- `POST /users/create-player`
- `POST /users/deposit` con:
  - `consultar_saldo`
  - `carga`
  - `descarga`
  - `descarga_total`

Casos reales validados:

- login valido:
  - `status = succeeded`
- login invalido:
  - `error = Contraseña no corregida`
- alta de usuario:
  - `status = succeeded`
- alta duplicada:
  - genera sufijo automatico y sigue en `succeeded`
- reanalisis `2026-04-07`:
  - RdA hoy puede devolver `status = 231`
  - `error_message = Password not verified`
  - el backend ya no interpreta `La ejecución de la solicitud falló.` como username duplicado
  - ante `Password not verified`, el backend igual revisa `/users/all`
  - si el usuario existe, el job queda `succeeded`
  - si no existe, el job corta con el error real en vez de consumir 10 intentos falsos
- secuencia de fondos validada:
  - saldo inicial `0`
  - `carga 10`
  - saldo `10`
  - `descarga 4`
  - saldo `6`
  - `descarga_total`
  - saldo final `0`
- secuencia responsive revalidada:
  - saldo inicial `0,00`
  - `carga 1`
  - saldo `1,00`
  - `descarga_total`
  - saldo final `0,00`

Casos de falla esperada validados:

- usuario inexistente en `consultar_saldo`:
  - `No se ha encontrado el usuario xxxx`
- credenciales invalidas:
  - `Contraseña no corregida`
- payload sin `cantidad` para `carga`:
  - `400 Invalid payload`
- `reporte` sobre `RdA`:
  - `501`
- `assign-phone` sobre `RdA`:
  - `501`

Cambios operativos cerrados para `RdA`:

- helper nuevo:
  - `src/rda-user-error.ts`
- traduccion de errores tecnicos de fondos/saldo a mensajes limpios
- `RdA` deja de reutilizar la sesion pool de fondos
- motivo:
  - la reutilizacion hacia intermitentes `descarga` y `descarga_total` dentro de Docker
- criterio actual:
  - `RdA` usa sesion aislada por operacion
  - el pool de fondos queda disponible para otros casos turbo donde no degrade estabilidad
- criterio responsive:
  - en Docker, RdA puede ocultar o partir la columna del usuario en `/users/all`
  - fondos abre directo solo si la tabla filtrada deja una unica accion visible para la operacion
  - saldo acepta una unica cifra visible con coma decimal como lectura segura de la tabla filtrada
- `POST /users/deposit` fuerza modo turbo para `RdA` y `ASN`:
  - `headless = true`
  - `debug = false`
  - `slowMo = 0`
  - `timeoutMs <= 15000`
  - los overrides visuales del payload se ignoran en esta ruta

Verificacion recomendada para este bloque:

```powershell
npm test
npm run build
docker build -t scrapsinoca-rda-test .
docker run --rm `
  -p 3000:3000 `
  -v ${PWD}/artifacts:/app/artifacts `
  scrapsinoca-rda-test server --host 0.0.0.0 --port 3000
```

Smoke reutilizable para `RdA`:

- `npm run smoke:rda-api`
- ver `docs/README_TESTEO.md`

### Contrato mensual actual

`POST /mastercrm-clients` acepta:

- `user_id`
- `month` en formato `YYYY-MM`

Respuesta relevante:

- `linkedOwner`
- `summary`
- `financialInputs`
- `primaryKpis`
- `statsKpis`
- `clientes`

KPIs principales calculados:

- `cargadoMesArs`
- `gananciaEstimadaArs`
- `roiEstimadoPct`
- `costoPorLeadRealArs`
- `conversionAsignadoPct`

KPIs de estadisticas:

- `clientesTotales`
- `asignados`
- `pendientes`
- `cargadoHoyArs`
- `cargadoMesArs`
- `intakesMes`
- `asignacionesMes`
- `tasaIntakeAsignacionPct`
- `clientesConReporte`
- `promedioCargaGeneralArs`
- `tasaActivacionPct`

Definiciones operativas vigentes:

- `intakesMes` cuenta leads unicos del mes, no eventos repetidos de intake
- `asignacionesMes` sigue contando clientes unicos que tuvieron `assign_username` dentro del mes
- `tasaIntakeAsignacionPct` ya no usa `asignacionesMes / intakesMes`
- ahora mide:
  - `leads unicos del mes que hoy quedaron assigned / leads unicos del mes`
- con esta formula la tasa queda acotada a `<= 100%`

### Regla cerrada

Un usuario CRM tiene un solo cajero activo.

Eso se enforcea en:

- logica de backend
- tabla `mastercrm_user_owner_links`
- indice unico por `mastercrm_user_id`

Migracion aplicada:

- `db/migrations/20260312_mastercrm_user_single_owner.sql`

## Modelo de datos relevante

Tablas:

- `mastercrm_users`
- `mastercrm_user_owner_links`
- `owners`
- `owner_aliases`
- `owner_client_links`
- `clients`
- `owner_client_identities`
- `report_daily_snapshots`
- `owner_financial_settings`
- `owner_monthly_ad_spend`

### Modelo actual de identidad

Desde el refactor de identidad por owner:

- `clients` representa solo el contacto global por telefono
- `clients` ya no debe usarse como fuente de `username`
- `owner_client_links` representa el vinculo del contacto con cada cajero
- `owner_client_identities` representa la identidad operativa del jugador para ese vinculo

Regla funcional:

- un mismo telefono puede existir en mas de un owner
- cada owner puede tener un `username` distinto para ese mismo telefono
- el `username` activo es unico por `pagina`
- si cambia el `username` dentro del mismo owner, se conserva historial

Campos clave de `owner_client_identities`:

- `owner_client_link_id`
- `owner_id`
- `client_id`
- `pagina`
- `username`
- `is_active`
- `valid_from`
- `valid_to`

Regla de estado:

- `owner_client_links.status = pending` si no existe identidad activa
- `owner_client_links.status = assigned` si existe exactamente una identidad activa

Migracion aplicada para esto:

- `db/migrations/20260313_owner_client_identities_refactor.sql`

Migracion intermedia descartada por quedar obsoleta frente al refactor completo:

- `20260313_assign_username_owner_guard.sql`

### Impacto tecnico

Partes que ya no deben leer `clients.username`:

- dashboard CRM
- `assign-phone`
- `create-player` sync
- reporte masivo ASN
- snapshots diarios

Partes que ahora leen identidad activa:

- `src/mastercrm-user-store.ts`
- `src/player-phone-store.ts`
- `src/report-run-store.ts`

### Reportes despues del refactor

`report_run_items` y `report_daily_snapshots` ahora persisten `identity_id`.

Eso significa:

- el reporte masivo encola identidades activas, no clientes globales
- el dashboard cruza snapshots por `identity_id`
- un mismo telefono puede aparecer bajo dos owners distintos con dos usernames distintos sin mezclar cargas

### Smoke real validado

Se valido contra Supabase real este caso:

- mismo telefono: `+5491199999013`
- owner `asnlucas10:lucas10` -> `codexlucas9013`
- owner `asnlucas10:vicky` -> `codexvicky9013`

Resultado confirmado:

- un solo `client` global por telefono
- dos `owner_client_links` distintos en `assigned`
- dos `owner_client_identities` activas distintas
- dashboard de Lucas devuelve `codexlucas9013`
- dashboard de Vicky devuelve `codexvicky9013`

Limpieza realizada despues del smoke:

- se eliminaron de Supabase el telefono de prueba `+5491199999013`
- se eliminaron sus links, identidades, eventos y cualquier rastro asociado

### Tablas financieras nuevas

`owner_financial_settings`

- guarda `commission_pct`
- es fija por owner
- `owner_id` es unico

`owner_monthly_ad_spend`

- guarda `ad_spend_ars`
- es mensual por owner
- clave unica: `(owner_id, month_start)`

Migracion aplicada:

- `db/migrations/20260313_owner_financial_kpis.sql`

### Telefono del cajero

El telefono que ve el frontend no sale de `mastercrm_users.telefono`.

Sale de `owner_aliases.alias_phone` del owner vinculado.

Criterio implementado:

1. tomar aliases con telefono
2. priorizar `is_active = true`
3. ordenar por `updated_at desc`
4. desempatar con `last_seen_at desc`

Implementado en:

- `src/mastercrm-user-store.ts`

## Supabase

Project ref usado durante esta etapa:

- `ksewoqvzhrtosuwrvcwb`

No exponer secretos en docs.

### Migraciones

Si hay que aplicar SQL manualmente:

- usar `db/migrations/` en orden

Si hay acceso administrativo a Supabase:

```http
POST https://api.supabase.com/v1/projects/{project-ref}/database/query
Authorization: Bearer {SUPABASE_PAT}
Content-Type: application/json
```

## Pruebas recomendadas

Tests:

```powershell
npm test
```

Build:

```powershell
npm run build
```

Smoke reutilizable:

- `scripts/mastercrm-local-smoke.cjs`

Ese script:

- crea usuario temporal
- hace login
- vincula `asnlucas10:lucas10`
- relekea a `asnlucas10:vicky`
- verifica owner unico

## Casos verificados

Con `asnlucas10:lucas10`:

- `totalClients = 34`
- `assignedClients = 17`
- `pendingClients = 17`
- `reportDate = 2026-03-12`
- `hasReport = true`
- `cargadoHoyArs = 142200`
- `cargadoMesArs = 260000`
- `intakesMes = 43`
- `asignacionesMes = 17`
- `clientesConReporte = 16`
- `promedioCargaGeneralArs = 7647.06`
- con `adSpendArs = 250000` y `commissionPct = 12.5`:
  - `gananciaEstimadaArs = 32500`
  - `roiEstimadoPct = -87`
  - `costoPorLeadRealArs = 5813.95`

Con `asnlucas10:vicky`:

- `hasReport = false`
- `reportDate = null`
- `totalClients = 17`
- `assignedClients = 0`
- `pendingClients = 17`
- `intakesMes = 21`
- `asignacionesMes = 0`
- el relink deja una sola fila activa

Con `month = 2026-02` para `Lucas10`:

- cartera visible igual
- KPIs de carga en `null`
- intakes y asignaciones del mes en `0`

## Corrida masiva ASN validada

Estado validado el `2026-03-13` para principal `asnlucas10`:

- `report_runs.id = 691c3997-3fa3-430d-a8b1-a8b281bf62af`
- `status = completed`
- `total_items = 59`
- `done_items = 59`
- `failed_items = 0`
- `agente = Pity24`
- `report_date = 2026-03-13`

Estado resultante para `asnlucas10:lucas10` despues de esa corrida:

- `totalClients = 73`
- `assignedClients = 59`
- `pendingClients = 14`
- `reportDate = 2026-03-13`
- `hasReport = true`
- `cargadoHoyArs = 34500`
- `cargadoMesArs = 1390859`
- `clientesConReporte = 59`
- `promedioCargaGeneralArs = 19052.86`
- `financialInputs.adSpendArs = 500000`
- `financialInputs.commissionPct = 60`
- `gananciaEstimadaArs = 834515.4`
- `roiEstimadoPct = 66.9`
- `costoPorLeadRealArs = 11627.91`
- `conversionAsignadoPct = 80.82`

Notas operativas:

- la API local puede estar levantada con `REPORT_WORKER_ENABLED = false`
- eso no impide ver datos actualizados si la corrida ya fue procesada antes y los snapshots existen en Supabase
- para `Lucas10`, al momento de esta validacion, los `59` clientes `assigned` ya tenian snapshot del `2026-03-13`
- los `14` faltantes en snapshot correspondian a `pending`, no a fallo del reporte
- `/mastercrm-clients` ahora tambien expone `summary.reportUpdatedAt`
- ese campo sale de `report_runs.finished_at` para el `principal_key` y `report_date` del owner
- el frontend lo usa para mostrar la ultima fecha y hora real de corrida en `Detalle del cliente`

## Regla de seguridad UI/API

- `owner_key` sigue existiendo en API para vincular
- pero no debe mostrarse visualmente al usuario final
- la clave staff se valida solo en backend

## Meta CAPI v2

Estado validado el `2026-03-18` en `scrap2`:

- se implemento `Meta CAPI v2` para CTWA en backend
- `ctwa_clid` ahora viaja en `user_data`
- `sourceContext` soporta `clientIpAddress`, `clientUserAgent` y `receivedAt`
- `Lead` ya no deduplica solo por `owner + client`; ahora usa `attribution_key = lower(ctwaClid)`
- `CompleteRegistration` sigue siendo unico por `owner + client`
- `event_id` de `Lead` y `qualified_lead` quedo unificado con `sha256 hex`

Archivos principales:

- `src/meta-conversions.ts`
- `src/meta-conversions-store.ts`
- `src/meta-conversions-worker.ts`
- `src/meta-source-context.ts`
- `src/server.ts`
- `src/types.ts`
- `db/migrations/20260318_meta_conversions_v2.sql`
- `docs/README_META_CAPI_CTWA.md`

Supabase real:

- se aplico la migracion `20260318_meta_conversions_v2.sql`
- `meta_conversion_outbox.attribution_key` ya existe
- `enqueue_meta_qualified_leads(...)` fue validada en remoto
- hubo que ajustar la funcion SQL para usar `extensions.digest(...)`
  porque en este proyecto `pgcrypto` esta instalado en schema `extensions`
  y no en `public`
- ese ajuste tambien quedo reflejado en el archivo de migracion del repo

Pruebas reales contra Supabase:

- enqueue real de `Lead` OK
- mismo `ctwa_clid` no duplica
- `ctwa_clid` distinto genera otro `Lead`
- las filas de prueba del outbox se limpiaron despues de validar

Validacion local:

- `npm test -- tests/meta-conversions.test.ts tests/server.test.ts` OK
- `70 passed`
- `npm run build` OK

Pendiente para test publicitario real:

- cargar `META_ACCESS_TOKEN` y levantar un worker Meta activo
- usar `META_TEST_EVENT_CODE`
- revisar Events Manager despues del dispatch
- si Meta devuelve algo raro, contrastarlo contra `docs/README_META_CAPI_CTWA.md`

Validacion real con Meta:

- el `2026-03-18` se disparo un `Lead` real al dataset usando `TEST87269`
- `action_source = system_generated`
- respuesta del Graph API:
  - `HTTP 200`
  - `events_received = 1`
  - `messages = []`
- `fbtrace_id = ARasLcKtl8KkMZ-x4-LjLdB`
- el request incluyo:
  - `event_name = Lead`
  - `ctwa_clid` dentro de `user_data`
  - `client_ip_address` dentro de `user_data`
  - `client_user_agent` dentro de `user_data`
- eso valida que el pipeline actual ya puede enviar un `Lead` de prueba sin error de API
- falta solo la lectura manual de `Test Events` para revisar warnings de calidad o recomendaciones de Meta

Actualizacion `2026-03-25`:

- el `Lead` inmediato desde `POST /users/intake-pending` quedo desactivado
- la nueva regla publicitaria pasa a ser:
  - intake atribuible por ad
  - primer `report_daily_snapshots` observado despues de ese intake
  - `cargado_hoy >= 10000` en ese primer snapshot
- el evento visible en Meta sigue siendo `Lead`
- internamente se sigue usando `event_stage = qualified_lead`
- la migracion nueva es:
  - `db/migrations/20260325_meta_lead_first_day_10k.sql`
- la migracion limpia de la outbox los eventos pendientes/viejos de `lead` y `qualified_lead`
- despues del deploy hay que validar en Meta `Test Events` solo un `Lead` tardio y no el `Lead` inmediato anterior
- validacion real en Supabase:
  - migracion aplicada OK
  - `select public.enqueue_meta_qualified_leads(20)` devolvio `0`
  - control de candidatos:
    - `total_candidates = 1`
    - `qualifying_candidates = 0`
  - conclusion:
    - la logica nueva ya esta activa en base
    - hoy no hay ningun caso real con `primer dia observado + cargado_hoy >= 10000`
    - por eso todavia no hay evento nuevo para mirar en Meta bajo esta regla

## Si otro chat retoma este repo

Checklist:

1. leer `README.md`
2. leer `OPERATIONS.md`
3. confirmar branch `main`
4. confirmar remoto `AEyeSecurity/scrap2`
5. definir variables de entorno
6. correr `npm test`
7. correr `npm run build`
8. levantar API local
9. validar `mastercrm-register`, `mastercrm-login`, `mastercrm-clients`, `mastercrm-link-cashier`, `mastercrm-owner-financials`
10. si el front devuelve `409` al re-guardar inversion mensual, revisar que el `upsert` use `onConflict: 'owner_id,month_start'`
