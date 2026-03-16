# API

Esta API corre en el comando:

```powershell
docker run --rm `
  -p 3000:3000 `
  --env-file .env `
  -v ${PWD}/artifacts:/app/artifacts `
  scrapsinoca server --host 0.0.0.0 --port 3000
```

Base URL local:

```text
http://127.0.0.1:3000
```

## Modelo general

- `POST /mastercrm-register`: alta de usuario web para el frontend MasterCRM.
- `POST /mastercrm-login`: login web compatible con el frontend actual.
- `POST /mastercrm-clients`: placeholder compatible para clientes del frontend.
- `POST /mastercrm-link-cashier`: vincula un usuario web con un owner/cajero existente.
- `POST /login`: job asincrono de autenticacion.
- `POST /users/create-player`: job asincrono de alta de usuario.
- `POST /users/intake-pending`: persistencia sin Playwright para telefonos pendientes.
- `POST /users/assign-phone`: asignacion sincronica de username por telefono, solo ASN.
- `POST /users/deposit`: carga, descarga, descarga total, saldo o reporte.
- `GET /jobs/:id`: estado del job asincrono.
- `POST /reports/asn/run`: crea una corrida persistida de reportes ASN.
- `GET /reports/asn/run/:runId`: estado agregado de la corrida.
- `GET /reports/asn/run/:runId/items`: items individuales de la corrida.

## Reglas utiles

- `pagina` acepta `RdA` y `ASN`, sin importar mayusculas.
- `operacion` normaliza aliases:
  - `retiro` -> `descarga`
  - `retiro_total` -> `descarga_total`
  - `consultar saldo` -> `consultar_saldo`
  - `report` -> `reporte`
- `cantidad` es obligatoria para `carga` y `descarga`.
- `cantidad` se ignora en `descarga_total`, `consultar_saldo` y `reporte`.
- `assign-phone` devuelve `501` fuera de ASN.

## Endpoints principales

### `POST /mastercrm-register`

Registro de usuarios web. Guarda credenciales hasheadas en `mastercrm_users`.

### `POST /mastercrm-login`

Login web compatible con el payload duplicado actual del frontend.

### `POST /mastercrm-clients`

Placeholder compatible. En esta version devuelve `[]` cuando el usuario existe y esta activo.

### `POST /mastercrm-link-cashier`

Vincula un usuario web de MasterCRM con un cajero/owner ya existente en `owners`, usando `pagina = ASN`.

### `POST /login`

Recibe credenciales y encola un login.

```bash
curl -s -X POST http://127.0.0.1:3000/login \
  -H "content-type: application/json" \
  -d "{\"username\":\"mi_agente\",\"password\":\"mi_password\"}"
```

Respuesta:

```json
{
  "jobId": "uuid",
  "status": "queued",
  "statusUrl": "/jobs/uuid"
}
```

### `POST /users/create-player`

Alta asincrona de usuario. Si mandas `telefono`, `ownerContext` pasa a ser obligatorio para sincronizar Supabase sin fallbacks legacy.

### `POST /users/intake-pending`

No crea usuario en la web. Solo deja al cliente pendiente en Supabase para asociarlo despues por telefono. `ownerContext` es obligatorio.

### `POST /users/assign-phone`

Flujo sincronico:

1. valida payload;
2. verifica en ASN que el usuario existe;
3. crea o actualiza `telefono -> username` en Supabase para el owner indicado.

Reglas:

- `ownerContext` es obligatorio.
- Si el telefono no existia, crea cliente y vinculo.
- Si el telefono ya tenia otro username, lo sobreescribe.
- Si el telefono ya tenia ese username, responde idempotente.
- Si el username estaba en otro telefono del mismo owner, lo mueve al telefono nuevo.
- Si el username estaba en otro owner, devuelve conflicto.

Errores esperables:

- `400`: payload invalido o telefono fuera de E.164.
- `404`: usuario ASN inexistente.
- `409`: conflicto de username entre owners.
- `501`: pagina distinta de ASN.
- `500`: solo si la verificacion ASN falla tecnicamente y no se puede continuar con seguridad.

Contrato de error:

```json
{
  "message": "El usuario ya esta asignado a otro cajero",
  "code": "USERNAME_ASSIGNED_TO_OTHER_OWNER",
  "details": {
    "usuario": "player_1"
  }
}
```

Respuesta exitosa posible:

```json
{
  "status": "ok",
  "overwritten": true,
  "previousUsername": "ailen389",
  "currentUsername": "1ailen389",
  "createdClient": true,
  "createdLink": true,
  "movedFromPhone": "+5493514000000",
  "deletedOldPhone": true
}
```

### `POST /users/deposit`

Centraliza cinco casos:

- `carga`
- `descarga`
- `descarga_total`
- `consultar_saldo`
- `reporte` solo para ASN

Internamente:

- `consultar_saldo` genera un job de tipo `balance`;
- `reporte` genera un job de tipo `report`;
- el resto genera jobs de tipo `deposit`.

Reglas ASN actuales:

- para `consultar_saldo`, `carga`, `descarga` y `descarga_total`:
  - si ASN confirma que el usuario no existe, responde `404` inmediato con `ASN_USER_NOT_FOUND`
  - si el precheck es inconcluso por una falla tecnica intermitente, la API ya no devuelve `500`; encola el job turbo igual
- para `reporte`:
  - no se hace precheck de usuario, porque el job de reporte no depende de validar un panel puntual antes de encolar

Contrato de error para usuario inexistente:

```json
{
  "message": "No se ha encontrado el usuario Ariel728",
  "code": "ASN_USER_NOT_FOUND",
  "details": {
    "usuario": "Ariel728"
  }
}
```

Comportamiento turbo en Docker:

- `headless = true`
- `debug = false`
- `slowMo = 0`
- `timeoutMs` capped en `15000` para `POST /users/deposit`

Correccion aplicada al flujo ASN:

- la lectura de saldo post-operacion ya no hace un `goto` inmediato que compita con la redireccion de ASN
- primero espera estabilizacion de pagina
- solo refresca una vez si hace falta
- esto evita errores como:
  - `Step failed: 06-read-saldo-after (page.goto ... is interrupted by another navigation ...)`

### `GET /jobs/:id`

Devuelve:

- `id`
- `jobType`
- `status`
- `createdAt`
- `startedAt`
- `finishedAt`
- `error`
- `artifactPaths`
- `steps`
- `result` cuando aplica

Estados posibles:

- `queued`
- `running`
- `succeeded`
- `failed`
- `expired`

### `POST /reports/asn/run`

Crea una corrida persistida para leer el reporte de muchos usuarios ASN usando Supabase como cola y estado.

Requiere:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

El worker se activa por defecto cuando hay configuracion de Supabase y puede ajustarse con:

- `REPORT_WORKER_ENABLED`
- `REPORT_WORKER_CONCURRENCY`
- `REPORT_WORKER_POLL_MS`
- `REPORT_WORKER_LEASE_SECONDS`
- `REPORT_WORKER_MAX_ATTEMPTS`

## Resultado de jobs

### `create-player`

```json
{
  "kind": "create-player",
  "pagina": "ASN",
  "requestedUsername": "pepito47",
  "createdUsername": "pepito471",
  "createdPassword": "PepitoPass123",
  "attempts": 2
}
```

### `balance`

```json
{
  "kind": "balance",
  "usuario": "player_1",
  "saldoTexto": "12.345,67",
  "saldoNumero": 12345.67
}
```

### `report`

```json
{
  "kind": "asn-reporte-cargado-mes",
  "pagina": "ASN",
  "usuario": "Ariel728",
  "mesActual": "2026-03",
  "fechaActual": "2026-03-09",
  "cargadoTexto": "40.000,00",
  "cargadoNumero": 40000,
  "cargadoHoyTexto": "0,00",
  "cargadoHoyNumero": 0
}
```

## Recomendacion practica

- Para el detalle de login/registro web, ver `docs/README_MASTERCRM_AUTH.md`.
- Usa `ownerContext` siempre en flujos que persisten owner/client (`create-player` con `telefono`, `intake-pending`, `assign-phone`).
- Trata `GET /jobs/:id` como fuente de verdad del resultado.
- Monta `artifacts/` como volumen para inspeccionar errores.
