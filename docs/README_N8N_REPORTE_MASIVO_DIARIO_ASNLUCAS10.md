# n8n: reporte masivo diario ASN para `asnlucas10`

Este flujo dispara la corrida persistida de reportes ASN para todos los usuarios que cuelgan de `principalKey = asnlucas10`, espera a que el worker termine y luego trae el detalle final de items.

El backend ya soporta este caso con `POST /reports/asn/run`.

## Archivo para importar

Si prefieres importarlo directo en n8n, usa este archivo:

- `docs/n8n-reporte-masivo-diario-asnlucas10.workflow.json`

Luego ajusta solo `baseUrl` si tu API no corre en `http://127.0.0.1:3000`.

## Valores prefijados para este caso

Usa estos valores en un nodo `Edit Fields`:

- `baseUrl`: URL publica de tu API. Ejemplo local: `http://127.0.0.1:3000`
- `pagina`: `ASN`
- `principalKey`: `asnlucas10`
- `agente`: `Pity24`
- `contrasena_agente`: `pityboca1509`
- `reportDate`: `{{ $now.setZone('America/Argentina/Buenos_Aires').toFormat('yyyy-MM-dd') }}`
- `pollSeconds`: `20`
- `itemsLimit`: `500`

Importante:

- `principalKey = asnlucas10` hace match con todos los `owner_key` del arbol `asnlucas10:*`.
- El worker del backend tiene que estar habilitado con Supabase conectado, si no la corrida queda en `queued`.

## Flujo recomendado

### 1. `Schedule Trigger - Reporte diario`

Configuralo una vez por dia en el horario que te convenga.

Ejemplo:

- frecuencia: `Every Day`
- hora: `03:10`
- timezone: `America/Argentina/Buenos_Aires`

Para pruebas, puedes sumar tambien un `Manual Trigger` y conectarlo al mismo flujo.

### 2. `Edit Fields - Prefijos ASN Lucas10`

Tipo: `Edit Fields` o `Set`

Carga manualmente estos campos:

```text
baseUrl                -> http://127.0.0.1:3000
pagina                 -> ASN
principalKey           -> asnlucas10
agente                 -> Pity24
contrasena_agente      -> pityboca1509
reportDate             -> {{ $now.setZone('America/Argentina/Buenos_Aires').toFormat('yyyy-MM-dd') }}
pollSeconds            -> 20
itemsLimit             -> 500
```

Si tu n8n no toma expresiones dentro de un valor literal, activa el modo expresion solo para `reportDate`.

### 3. `HTTP - Crear corrida ASN`

Tipo: `HTTP Request`

- method: `POST`
- url: `{{ $json.baseUrl }}/reports/asn/run`
- send body as: `JSON`

Body:

```json
{
  "pagina": "{{ $json.pagina }}",
  "principalKey": "{{ $json.principalKey }}",
  "agente": "{{ $json.agente }}",
  "contrasena_agente": "{{ $json.contrasena_agente }}",
  "reportDate": "{{ $json.reportDate }}"
}
```

Respuesta esperada:

```json
{
  "runId": "uuid",
  "status": "queued",
  "statusUrl": "/reports/asn/run/uuid"
}
```

### 4. `Wait - Espera worker`

Tipo: `Wait`

- amount: `{{ $('Edit Fields - Prefijos ASN Lucas10').item.json.pollSeconds }}`
- unit: `seconds`

La primera espera evita pegarle al estado demasiado rapido.

### 5. `HTTP - Estado corrida ASN`

Tipo: `HTTP Request`

- method: `GET`
- url: `{{ $('Edit Fields - Prefijos ASN Lucas10').item.json.baseUrl }}/reports/asn/run/{{ $('HTTP - Crear corrida ASN').item.json.runId }}`

Respuesta esperada:

```json
{
  "id": "uuid",
  "pagina": "ASN",
  "principalKey": "asnlucas10",
  "reportDate": "2026-03-10",
  "status": "queued|running|completed|completed_with_errors|failed|cancelled",
  "totalItems": 10,
  "doneItems": 0,
  "failedItems": 0
}
```

### 6. `IF - Corrida finalizada`

Tipo: `IF`

Usa una condicion booleana por expresion:

```text
{{ ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes($json.status) }}
```

Comportamiento:

- si da `false`: vuelve a `Wait - Espera worker`
- si da `true`: pasa a leer los items finales

Conexiones:

- salida `false` -> `Wait - Espera worker`
- `Wait - Espera worker` -> `HTTP - Estado corrida ASN`

Eso arma el loop de polling.

### 7. `HTTP - Listar items corrida ASN`

Tipo: `HTTP Request`

- method: `GET`
- url: `{{ $('Edit Fields - Prefijos ASN Lucas10').item.json.baseUrl }}/reports/asn/run/{{ $('HTTP - Crear corrida ASN').item.json.runId }}/items?limit={{ $('Edit Fields - Prefijos ASN Lucas10').item.json.itemsLimit }}&offset=0`

Respuesta esperada:

```json
{
  "total": 10,
  "items": [
    {
      "username": "vandrea487",
      "ownerKey": "asnlucas10:lucas10",
      "ownerLabel": "Lucas 10",
      "status": "done",
      "cargadoHoy": 300,
      "cargadoMes": 3000
    }
  ]
}
```

### 8. `Edit Fields - Resumen final`

Tipo: `Edit Fields` o `Set`

Arma una salida compacta para usar despues en Sheets, email, Telegram o webhook.

Campos sugeridos:

```text
runId         -> {{ $('HTTP - Crear corrida ASN').item.json.runId }}
principalKey  -> {{ $('Edit Fields - Prefijos ASN Lucas10').item.json.principalKey }}
reportDate    -> {{ $('Edit Fields - Prefijos ASN Lucas10').item.json.reportDate }}
status        -> {{ $('HTTP - Estado corrida ASN').item.json.status }}
totalItems    -> {{ $('HTTP - Estado corrida ASN').item.json.totalItems }}
doneItems     -> {{ $('HTTP - Estado corrida ASN').item.json.doneItems }}
failedItems   -> {{ $('HTTP - Estado corrida ASN').item.json.failedItems }}
itemsTotal    -> {{ $json.total }}
items         -> {{ $json.items }}
```

Desde ahi puedes:

- iterar `items` con `Split Out`;
- guardar snapshots en Google Sheets;
- mandar solo errores si `failedItems > 0`;
- resumir por `ownerKey`.

## Orden de conexiones

Usa este orden:

1. `Schedule Trigger - Reporte diario` -> `Edit Fields - Prefijos ASN Lucas10`
2. `Manual Trigger` -> `Edit Fields - Prefijos ASN Lucas10`
3. `Edit Fields - Prefijos ASN Lucas10` -> `HTTP - Crear corrida ASN`
4. `HTTP - Crear corrida ASN` -> `Wait - Espera worker`
5. `Wait - Espera worker` -> `HTTP - Estado corrida ASN`
6. `HTTP - Estado corrida ASN` -> `IF - Corrida finalizada`
7. `IF - Corrida finalizada (false)` -> `Wait - Espera worker`
8. `IF - Corrida finalizada (true)` -> `HTTP - Listar items corrida ASN`
9. `HTTP - Listar items corrida ASN` -> `Edit Fields - Resumen final`

## Payload real que debe salir del workflow

Este es el JSON efectivo que el nodo `HTTP - Crear corrida ASN` tiene que mandar:

```json
{
  "pagina": "ASN",
  "principalKey": "asnlucas10",
  "agente": "Pity24",
  "contrasena_agente": "pityboca1509",
  "reportDate": "2026-03-10"
}
```

## Validaciones rapidas

Si todo esta bien:

- `POST /reports/asn/run` responde `202`
- el estado pasa de `queued` a `running`
- termina en `completed` o `completed_with_errors`
- `GET /reports/asn/run/:runId/items` devuelve los usernames del arbol `asnlucas10:*`

Si falla:

- revisa que `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` existan en el backend
- revisa que `REPORT_WORKER_ENABLED=true`
- revisa que existan usuarios asociados a `principalKey = asnlucas10`
- revisa conectividad entre n8n y `baseUrl`
