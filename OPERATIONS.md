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
- `report_daily_snapshots`
- `owner_financial_settings`
- `owner_monthly_ad_spend`

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
