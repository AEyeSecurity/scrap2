# n8n: reporte masivo diario RdA para `luqui10`

Este flujo dispara la corrida persistida de reportes RdA para todos los usuarios asignados bajo `principalKey = luqui10`, espera a que el worker termine y luego trae el detalle final de items.

Para RdA hay que usar los endpoints genericos de reportes:

- `POST /reports/run`
- `GET /reports/run/:runId`
- `GET /reports/run/:runId/items`

No uses `/reports/asn/run` para RdA, porque esa ruta fuerza `pagina = ASN`.

## Valores prefijados para este caso

Usa estos valores en el nodo `Edit Fields`:

```text
baseUrl                -> http://127.0.0.1:3000
pagina                 -> RdA
principalKey           -> luqui10
agente                 -> elpity24
contrasena_agente      -> <clave RdA guardada en n8n>
reportDate             -> {{ $now.setZone('America/Argentina/Buenos_Aires').toFormat('yyyy-MM-dd') }}
pollSeconds            -> 20
itemsLimit             -> 500
```

`principalKey = luqui10` incluye los owners del arbol `luqui10:*`, por ejemplo `luqui10:luqui10` y `luqui10:vicky`.

## Payload de creacion

El nodo `HTTP - Crear corrida RdA` debe mandar:

```json
{
  "pagina": "RdA",
  "principalKey": "luqui10",
  "agente": "elpity24",
  "contrasena_agente": "<clave RdA guardada en n8n>",
  "reportDate": "2026-04-08"
}
```

Respuesta esperada:

```json
{
  "runId": "uuid",
  "status": "queued",
  "statusUrl": "/reports/run/uuid"
}
```

## Campos de resultado

En RdA el job lee la pantalla `Reportes financieros > Depositos y retiros` y persiste el valor visible de `Deposito total`.

Ese valor se guarda en:

- `rawResult.depositoTotalTexto`
- `rawResult.depositoTotalNumero`
- `cargadoMes`

`cargadoHoy` queda en `0` por diseno actual del job RdA. Para reportes RdA, mira `cargadoMes` o `rawResult.depositoTotalNumero`.

## Usuarios que entran al reporte

La corrida solo encola usuarios que cumplen estas condiciones:

- `clients.pagina = 'RdA'`
- `owners.owner_key` empieza con `luqui10:`
- el link owner-cliente esta en `status = 'assigned'`
- existe una identidad activa para ese cliente en RdA

Los links `pending` no se scrapean, aunque tengan telefono o identidad asociada, porque el reporte necesita un username activo y asignado.

## Nota operativa: ceros en RdA

El reporte de RdA muestra un spinner/logo mientras carga los totales. Si el scraper lee la pantalla demasiado temprano, puede capturar el placeholder `$0,00` aunque el usuario tenga depositos reales.

El backend ahora espera a que:

- desaparezca el spinner/logo de carga;
- exista el bloque de totales;
- exista la tabla del reporte;
- ese estado se mantenga estable brevemente.

Si vuelve a aparecer una corrida con todos los valores en cero, revisar primero:

- que el backend desplegado tenga este fix;
- que la corrida se haya creado con `POST /reports/run` y `pagina = RdA`;
- que n8n este mirando `cargadoMes`, no `cargadoHoy`;
- que el worker este activo con `REPORT_WORKER_ENABLED=true`.
