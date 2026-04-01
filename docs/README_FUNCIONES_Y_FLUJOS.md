# Funciones y flujos

Este archivo no intenta documentar cada helper del repo. Resume los modulos que definen el comportamiento real del sistema.

## Entrada principal

### `src/index.ts`

- define la CLI con `commander`;
- expone `run` y `server`;
- transforma flags en configuracion tipada;
- llama a `runScraper` o `startServer`.

### `src/config.ts`

- mezcla CLI y variables de entorno;
- valida formato con `zod`;
- resuelve defaults;
- cambia comportamiento de selectores, timeouts y rutas.

## Flujo de scraping

### `src/run.ts`

Es el pipeline del modo `run`:

1. abre Chromium;
2. prepara contexto;
3. intenta reutilizar `storage-state.json`;
4. autentica con `ensureAuthenticated`;
5. llama a `extractApiData`;
6. normaliza y escribe resultados.

### `src/auth.ts`

Hace el login real en UI:

- detecta si la sesion ya esta autenticada;
- encuentra campos visibles usando varios selectores;
- envia credenciales;
- espera una senal estable de autenticacion;
- guarda `storageState` si corresponde.

### `src/extract.ts`

- escucha trafico para descubrir endpoints `/api/`;
- o usa `AGENT_API_ENDPOINTS`;
- hidrata placeholders como `{fromDate}` y `{toDate}`;
- reintenta con `p-retry`;
- limita concurrencia con `p-limit`.

## API y jobs

### `src/server.ts`

Es el centro operativo del modo API:

- valida payloads;
- normaliza `pagina` y `operacion`;
- decide el tipo de job;
- responde `202` para operaciones asincronas;
- conecta con stores de Supabase cuando hay variables de entorno.

### `src/jobs.ts`

Implementa una cola en memoria con TTL:

- estados `queued`, `running`, `succeeded`, `failed`, `expired`;
- concurrencia limitada;
- guarda `steps`, `artifactPaths` y `result`.

## Flujos de negocio

### `src/create-player-job.ts`

- usa flujo UI para `RdA`;
- prueba variantes de username si encuentra duplicados;
- captura screenshots por paso;
- verifica que el usuario aparezca en `/users/all`.

### `src/create-player-asn.ts`

- contiene el flujo especifico de alta para ASN.

### `src/deposit-job.ts`

- cubre `carga`, `descarga` y `descarga_total` en `RdA`;
- localiza el usuario en `/users/all`;
- abre la pantalla de fondos;
- completa monto o pulsa `Toda`;
- valida resultado por mensaje, URL o saldo.

### `src/balance-job.ts`

- busca el usuario en el listado;
- extrae el saldo textual;
- lo convierte a numero.

### `src/asn-funds-job.ts`

- implementa fondos y saldo para ASN;
- devuelve resultados enriquecidos con saldos antes y despues.

### `src/asn-report-job.ts`

- entra en la vista ASN de cargas y descargas por usuario;
- busca la fila `TOTAL del mes YYYY-MM`;
- extrae cargado mensual y del dia actual en Buenos Aires.

## Persistencia

### `src/player-phone-store.ts`

- valida telefonos en E.164;
- hace intake pending;
- sincroniza `create-player` con Supabase;
- asigna username por telefono;
- usa RPCs versionadas `*_v4`.

### `src/report-run-store.ts`

- persiste corridas de reporte ASN;
- administra items, leases, reintentos y snapshots diarios;
- genera outbox al completar una corrida.

### `src/report-worker.ts`

- reclama items pendientes;
- ejecuta `runAsnReportJob`;
- marca done o failed;
- refresca el estado agregado del run.

## Soporte comun

### `src/site-profile.ts`

- decide si se usa perfil `RdA` o `ASN`;
- cambia base URL, login path y selectores.

### `src/browser.ts`

- ajusta timeouts del contexto;
- en headless puede bloquear imagenes, fuentes y media.

### `src/funds-session-pool.ts`

- cachea sesiones de agentes para jobs de fondos;
- evita logins completos en cada request cuando esta habilitado.

## Donde mirar segun el problema

- falla de login: `src/auth.ts`, `src/site-profile.ts`
- un endpoint de API responde mal: `src/server.ts`
- un job queda raro o expira: `src/jobs.ts`
- no persiste telefono o owner: `src/player-phone-store.ts`
- reportes ASN no avanzan: `src/report-run-store.ts`, `src/report-worker.ts`, `db/migrations/`
