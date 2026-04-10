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
- `POST /whatsapp/intake`: intake simplificado para n8n/Twilio, sin Google Sheets como memoria del Master CRM.
- `POST /users/assign-phone`: asignacion sincronica de username por telefono.
- `POST /users/deposit`: carga, descarga, descarga total, saldo o reporte.
- `GET /jobs/:id`: estado del job asincrono.
- `POST /reports/run`: crea una corrida persistida de reportes para `ASN` o `RdA`.
- `GET /reports/run/:runId`: estado agregado de la corrida.
- `GET /reports/run/:runId/items`: items individuales de la corrida.
- `POST /reports/asn/run`: alias compatible que fuerza `pagina = ASN`.
- `GET /reports/asn/run/:runId`: alias compatible para estado.
- `GET /reports/asn/run/:runId/items`: alias compatible para items.

## Reglas utiles

- `pagina` acepta `RdA` y `ASN`, sin importar mayusculas.
- `operacion` normaliza aliases:
  - `retiro` -> `descarga`
  - `retiro_total` -> `descarga_total`
  - `consultar saldo` -> `consultar_saldo`
  - `report` -> `reporte`
- `cantidad` es obligatoria para `carga` y `descarga`.
- `cantidad` se ignora en `descarga_total`, `consultar_saldo` y `reporte`.
- `assign-phone` valida existencia real en ASN o RdA antes de persistir.

## Endpoints principales

### `POST /mastercrm-register`

Registro de usuarios web. Guarda credenciales hasheadas en `mastercrm_users`.

### `POST /mastercrm-login`

Login web compatible con el payload duplicado actual del frontend.

### `POST /mastercrm-clients`

Placeholder compatible. En esta version devuelve `[]` cuando el usuario existe y esta activo.

### `POST /mastercrm-link-cashier`

Vincula un usuario web de MasterCRM con un cajero/owner ya existente en `owners`, usando `pagina = ASN` o `pagina = RdA`.

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

Nota operativa `RdA` al `2026-04-07`:

- el sitio remoto puede responder `{"status":231,"error_message":"Password not verified"}` al crear usuario;
- cuando eso pasa, el backend primero verifica si el usuario quedo creado igual en `/users/all`;
- si el usuario aparece, el job se considera exitoso aunque la API haya devuelto ese warning;
- si el usuario no aparece, `GET /jobs/:id` expone el error real;
- RdA rechaza contrasenas cortas: `newPassword` debe tener al menos 6 caracteres. Por ejemplo, para `0Ro347`, `ro123` falla y `ro1234` funciona.
- `La ejecución de la solicitud falló.` ya no se trata como `username duplicado`, por lo que el job deja de gastar 10 intentos falsos.

Nota operativa `RdA` al `2026-04-09`:

- antes de abrir `/users/create-player`, el backend ahora hace un precheck en `/users/all` para cada candidato de username;
- si un candidato ya existe, lo marca como intento descartado y prueba el siguiente sin golpear la API de alta;
- la API remota de RdA puede devolver duplicados con mensajes como `already exist` o `status = -3`; ambos casos se clasifican como duplicado real;
- ese chequeo post-submit queda solo como proteccion ante carrera, no como estrategia primaria;
- cada intento guarda artifacts en `artifacts/jobs/<jobId>/attempt-N/`, por lo que ya no se pisan screenshots entre reintentos;
- el resultado final sigue informando `createdUsername` y `attempts`, pero ahora con reintentos mas baratos y deterministas.

### `POST /users/intake-pending`

No crea usuario en la web. Solo deja al cliente pendiente en Supabase para asociarlo despues por telefono. `ownerContext` es obligatorio.

### `POST /whatsapp/intake`

Version simplificada para n8n. Acepta `pagina`, `ownerContext`, `telefono` opcional y `body` de Twilio/WhatsApp. Si `telefono` no viene, lo deriva de `body.WaId` o `body.From`, arma `sourceContext` desde campos `Referral*`, `WaId`, `MessageSid`, `AccountSid` y `ProfileName`, y persiste con la misma logica de `/users/intake-pending`.

Si `ownerContext` no viene, intenta resolverlo desde un intake ya persistido para ese `pagina + telefono`. Esto permite que la rama `SI, quiero mas info` recupere el mismo cajero asignado en el primer contacto sin usar Google Sheets.

Ejemplo:

```json
{
  "pagina": "ASN",
  "body": {
    "WaId": "5493515747477",
    "From": "whatsapp:+5493515747477",
    "ProfileName": "Cliente",
    "ReferralCtwaClid": "clid-123",
    "ReferralSourceType": "ad"
  },
  "ownerContext": {
    "ownerKey": "asnlucas10:lucas10",
    "ownerLabel": "Lucas10",
    "actorAlias": "Lucas10",
    "actorPhone": "+5493516549344"
  }
}
```

### `POST /users/assign-phone`

Flujo sincronico:

1. valida payload;
2. verifica en ASN o RdA que el usuario existe;
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
- `500`: solo si la verificacion ASN/RdA falla tecnicamente y no se puede continuar con seguridad.

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

Reglas `RdA` actuales:

- `POST /users/create-player`, `POST /users/deposit` y `consultar_saldo` fueron validados en Docker real el `2026-03-27`
- `POST /users/deposit` y `consultar_saldo` fueron revalidados en Docker real el `2026-04-07` por el caso responsive de RdA
- `POST /users/create-player` fue reanalizado en Docker real el `2026-04-07` por una regresion remota del sitio
- `POST /users/create-player` fue revalidado en Docker real el `2026-04-09` por colisiones de username en `Lucas 10 RdA`
- cuando RdA devuelve `Password not verified`, el backend verifica la lista de usuarios antes de fallar
- si el usuario existe, el alta queda `succeeded`; si no existe, devuelve ese motivo real y no reintenta como si fuera nick duplicado
- cuando el username pedido ya existe, el backend ahora lo detecta primero en `/users/all` y evita submits redundantes al formulario
- si aun asi la API de RdA devuelve `status = -3` o un mensaje `already exist` durante el submit, el job lo toma como colision real y rota al siguiente candidato
- para `RdA`, los jobs de fondos y saldo usan sesion aislada por operacion
- esa decision evita intermitencias de `descarga` y `descarga_total` al reutilizar una sesion vieja dentro del contenedor
- en Docker, RdA puede ocultar o partir la columna del usuario en `/users/all`; fondos y saldo usan la tabla filtrada y una unica accion/saldo visible como fallback seguro
- si el usuario no existe en `RdA`, `GET /jobs/:id` ya no expone errores tecnicos de matching de filas
- el mensaje limpio esperado pasa a ser:
  - `No se ha encontrado el usuario xxxx`
- si el retiro no deja una senal confiable de confirmacion, el backend devuelve un mensaje entendible:
  - `No se pudo confirmar la operacion descarga para el usuario xxxx`
  - `No se pudo confirmar la operacion descarga_total para el usuario xxxx`

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
- estos valores se imponen para `RdA` y `ASN`, aunque el payload envie overrides visuales

Correccion aplicada al flujo ASN:

- la lectura de saldo post-operacion ya no hace un `goto` inmediato que compita con la redireccion de ASN
- primero espera estabilizacion de pagina
- solo refresca una vez si hace falta
- esto evita errores como:
  - `Step failed: 06-read-saldo-after (page.goto ... is interrupted by another navigation ...)`
- el paso `01b-continue-intermediate` ya no falla por un `Continuar` transitorio o stale
- si ASN ya muestra el shell autenticado (`/NewAdmin/` o textos del panel), el backend sigue sin exigir ese click
- en modo turbo, el probe del post-login mantiene polling corto y timeout de click acotado para no volver lenta la ruta `/users/deposit`

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

Convencion de errores visibles:

- `ASN` y `RdA` deben priorizar mensajes de negocio antes que errores de Playwright
- para credenciales invalidas en login o fondos, el mensaje visible validado hoy es:
  - `Contraseña no corregida`
- para usuario inexistente en `RdA` o `ASN`, el objetivo es mantener:
  - `No se ha encontrado el usuario xxxx`

### `POST /reports/run`

Crea una corrida persistida para leer el reporte de muchos usuarios usando Supabase como cola y estado.

Usa `pagina = ASN` para el reporte de ASN y `pagina = RdA` para el reporte de RdA. Para RdA, usa `principalKey = luqui10` si queres incluir owners como `luqui10:luqui10` y `luqui10:vicky`.

`POST /reports/asn/run` sigue disponible como alias compatible para ASN y fuerza `pagina = ASN`.

Requiere:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

El worker se activa por defecto cuando hay configuracion de Supabase y puede ajustarse con:

- `REPORT_WORKER_ENABLED`
- `REPORT_WORKER_CONCURRENCY`
- `REPORT_WORKER_POLL_MS`
- `REPORT_WORKER_LEASE_SECONDS`
- `REPORT_WORKER_MAX_ATTEMPTS`

Notas RdA:

- el job lee `Deposito total` desde `Reportes financieros > Depositos y retiros`;
- ese valor queda en `cargadoMes` y en `rawResult.depositoTotalNumero`;
- `cargadoHoy` queda en `0` por diseno actual del job RdA;
- el scraper espera a que desaparezca el spinner/logo de carga antes de leer, para evitar capturar el placeholder `$0,00`.

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

Resultado ASN:

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

Resultado RdA:

```json
{
  "kind": "rda-reporte-deposito-total",
  "pagina": "RdA",
  "usuario": "0robertino254",
  "depositoTotalTexto": "$125.005,00",
  "depositoTotalNumero": 125005,
  "cargadoTexto": "$125.005,00",
  "cargadoNumero": 125005,
  "cargadoHoyTexto": "0,00",
  "cargadoHoyNumero": 0
}
```

## Recomendacion practica

- Para el detalle de login/registro web, ver `docs/README_MASTERCRM_AUTH.md`.
- Usa `ownerContext` siempre en flujos que persisten owner/client (`create-player` con `telefono`, `intake-pending`, `assign-phone`).
- Trata `GET /jobs/:id` como fuente de verdad del resultado.
- Monta `artifacts/` como volumen para inspeccionar errores.
