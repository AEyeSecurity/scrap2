# ScrapSinoca

ScrapSinoca es un servicio Node.js + Playwright orientado a automatizar operaciones sobre paneles de agentes y a exponer esas automatizaciones como CLI y como API HTTP.

Hoy el proyecto cubre dos frentes:

- `run`: login en la web, reutilizacion opcional de sesion y extraccion de datos via endpoints autenticados.
- `server`: API Fastify con jobs asincronos para login, creacion de usuarios, fondos, consulta de saldo y reportes ASN.

## Que hace

El sistema combina navegacion real con Playwright y logica de negocio propia:

- entra en el panel del agente y detecta si la sesion ya es valida;
- para `RdA` usa `https://agents.reydeases.com`;
- para `ASN` cambia selectores, base URL y flujos especificos;
- ejecuta operaciones como crear usuario, cargar, descargar, consultar saldo o leer reportes;
- opcionalmente sincroniza datos en Supabase con un modelo owner-centric;
- guarda artefactos de depuracion cuando un job falla o cuando se activa `debug`.

## Como esta organizado

- `src/index.ts`: CLI principal.
- `src/run.ts`: flujo de scraping por lote.
- `src/server.ts`: API HTTP y cola de jobs en memoria.
- `src/create-player-job.ts`, `src/deposit-job.ts`, `src/balance-job.ts`, `src/asn-report-job.ts`: automatizaciones de negocio.
- `src/player-phone-store.ts`, `src/report-run-store.ts`, `src/report-worker.ts`: persistencia y cola de reportes sobre Supabase.
- `tests/`: suite de Vitest.
- `db/migrations/`: SQL asociado al modelo owner-centric y a la cola de reportes.

## Como funciona

### Modo `run`

1. Abre Chromium.
2. Hace login con `AGENT_USERNAME` y `AGENT_PASSWORD` o con flags CLI.
3. Reutiliza `storage-state.json` si existe y si `reuseSession` esta activo.
4. Descubre endpoints `/api/...` desde el trafico o usa `AGENT_API_ENDPOINTS`.
5. Descarga, normaliza y escribe JSON, CSV y metadata.

### Modo `server`

1. Levanta Fastify.
2. Recibe requests HTTP.
3. Valida payloads con `zod`.
4. Encola jobs en memoria.
5. Ejecuta cada job con Playwright.
6. Expone el estado por `GET /jobs/:id`.
7. Si Supabase esta configurado, habilita persistencia de telefonos y la cola de reportes ASN.

## Arranque rapido con Docker

Los ejemplos siguientes asumen PowerShell y Docker Desktop activo. El `Dockerfile` actual genera una imagen de runtime cuyo `ENTRYPOINT` es `node dist/index.js` y cuyo `CMD` por defecto es `run`.

### 1. Construir la imagen

```powershell
docker build -t scrapsinoca .
```

### 2. Ejecutar `run`

```powershell
docker run --rm `
  -e AGENT_USERNAME=mi_agente `
  -e AGENT_PASSWORD=mi_password `
  -e AGENT_API_ENDPOINTS=/api/users/all,/api/reports/summary `
  -v ${PWD}/out:/app/out `
  -v ${PWD}/artifacts:/app/artifacts `
  scrapsinoca
```

Salidas esperadas:

- `out/data.<timestamp>.json`
- `out/data.<timestamp>.csv`
- `out/run.<timestamp>.meta.json`

### 3. Ejecutar `server`

```powershell
docker run --rm `
  -p 3000:3000 `
  -e API_HOST=0.0.0.0 `
  -e API_PORT=3000 `
  -e SUPABASE_URL=https://tu-proyecto.supabase.co `
  -e SUPABASE_SERVICE_ROLE_KEY=tu_service_role `
  -v ${PWD}/artifacts:/app/artifacts `
  scrapsinoca server --host 0.0.0.0 --port 3000
```

Artefactos del modo API:

- `artifacts/jobs/<jobId>/...`

## Variables importantes

- `AGENT_USERNAME`, `AGENT_PASSWORD`: credenciales para `run`.
- `AGENT_API_ENDPOINTS`: lista separada por comas para el modo `run`.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: habilitan persistencia y reportes.
- `REPORT_WORKER_ENABLED`: activa o desactiva el worker de reportes ASN.
- `FUNDS_SESSION_CACHE_ENABLED`: reutiliza sesiones de fondos entre jobs.

## Documentacion puntual

- API y endpoints: [docs/README_API.md](docs/README_API.md)
- Login y registro MasterCRM: [docs/README_MASTERCRM_AUTH.md](docs/README_MASTERCRM_AUTH.md)
- JSON listos para copiar: [docs/README_JSON_EJEMPLOS.md](docs/README_JSON_EJEMPLOS.md)
- Funciones y flujos internos: [docs/README_FUNCIONES_Y_FLUJOS.md](docs/README_FUNCIONES_Y_FLUJOS.md)
- Testeo y benchmark en Docker: [docs/README_TESTEO.md](docs/README_TESTEO.md)
- Prompt de orquestacion n8n: [docs/n8n-agent-system-message-v2.md](docs/n8n-agent-system-message-v2.md)

## Notas operativas

- La imagen del `Dockerfile` esta pensada para runtime, no para ejecutar la suite de tests dentro de la propia imagen.
- Si Docker Desktop no esta levantado, `docker build` y `docker run` van a fallar antes de arrancar la app.
- `GET /jobs/:id` usa memoria del proceso. Si reinicias el contenedor, se pierde la cola en memoria.
