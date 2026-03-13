# Scrap2 Operations

Esta guia explica como operar `scrap2` cuando se retoma el repo en otro chat o en otra maquina.

## Repo y cuenta GitHub

Regla fija:

- Backend siempre usa la cuenta `AEyeSecurity`

Remoto esperado:

- `origin = https://github.com/AEyeSecurity/scrap2.git`

Branch de trabajo usada en esta etapa:

- `codex/back-local`

Verificar antes de trabajar:

```powershell
cd "C:\Guiga\CIT\Master CRM RL\scrap2"
git branch --show-current
git remote -v
git status --short
```

Push esperado:

```powershell
git push -u origin codex/back-local
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

No guardarlas en el repo.

## Levantar local

```powershell
cd "C:\Guiga\CIT\Master CRM RL\scrap2"
$env:SUPABASE_URL="..."
$env:SUPABASE_SERVICE_ROLE_KEY="..."
$env:MASTERCRM_STAFF_LINK_PASSWORD="..."
npm start -- server
```

Backend esperado:

- `http://127.0.0.1:3000`

## Flujo CRM implementado

Endpoints usados por el frontend:

- `POST /mastercrm-register`
- `POST /mastercrm-login`
- `POST /mastercrm-clients`
- `POST /mastercrm-link-cashier`
- `POST /mastercrm-owner-financials`

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

## Si otro chat retoma este repo

Checklist:

1. leer `README.md`
2. leer `OPERATIONS.md`
3. confirmar branch `codex/back-local`
4. confirmar remoto `AEyeSecurity/scrap2`
5. definir variables de entorno
6. correr `npm test`
7. correr `npm run build`
8. levantar API local
9. validar `mastercrm-register`, `mastercrm-login`, `mastercrm-clients`, `mastercrm-link-cashier`, `mastercrm-owner-financials`
10. si el front devuelve `409` al re-guardar inversion mensual, revisar que el `upsert` use `onConflict: 'owner_id,month_start'`
