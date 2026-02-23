# ScrapSinoca

Scraper CLI/API for `agents.reydeases.com` using Node.js + Playwright.

## Features

- Login automation (UI) with reusable session (`storageState`) in `run` mode.
- Hybrid extraction strategy in `run`: login in UI, then fetch via authenticated API calls.
- Credentials by CLI flags (`--username`, `--password`) with env fallback.
- Async API server with shared job queue (`POST /login`, `POST /users/create-player`, `POST /users/deposit`, `GET /jobs/:id`).
- Funds jobs (`carga`/`descarga`/`descarga_total`/`consultar_saldo`) run in Turbo mode by default (headed, debug off, no slow-mo, timeout <= 15s) unless overridden.
- Debug-friendly flags: headless/headed, slow-mo, traces, video and screenshots on failure.

## Requirements

- Node.js 20+
- npm 10+

## Install

```bash
npm install
```

## Run mode (local, headed by default)

Credentials from command line:

```bash
npm run scraper -- run \
  --username my_user \
  --password my_password \
  --headless false \
  --debug true \
  --slow-mo 100 \
  --timeout-ms 45000
```

## API server mode (async jobs)

Start server:

```bash
npm run scraper -- server --host 127.0.0.1 --port 3000
```

Create login job:

```bash
curl -s -X POST http://127.0.0.1:3000/login \
  -H 'content-type: application/json' \
  -d '{"username":"my_user","password":"my_password","headless":false,"debug":true}'
```

Response:

```json
{
  "jobId": "<uuid>",
  "status": "queued",
  "statusUrl": "/jobs/<uuid>"
}
```

Get job status:

```bash
curl -s http://127.0.0.1:3000/jobs/<uuid>
```

Create player job:

```bash
curl -s -X POST http://127.0.0.1:3000/users/create-player \
  -H 'content-type: application/json' \
  -d '{
    "loginUsername":"agent_user",
    "loginPassword":"agent_pass",
    "newUsername":"player_1",
    "newPassword":"player_pass",
    "headless":false,
    "debug":true
  }'
```

Create funds job (`operacion` supports `carga`, `descarga`, `retiro`, `descarga_total`, `retiro_total`, `consultar_saldo`, `consultar saldo`):

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H 'content-type: application/json' \
  -d '{
    "operacion":"carga",
    "usuario":"player_1",
    "agente":"agent_user",
    "contrasena_agente":"agent_pass",
    "cantidad":500
  }'
```

Create withdraw job (descarga):

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H 'content-type: application/json' \
  -d '{
    "operacion":"descarga",
    "usuario":"player_1",
    "agente":"agent_user",
    "contrasena_agente":"agent_pass",
    "cantidad":500
  }'
```

Alias example (`retiro` is normalized to `descarga`):

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H 'content-type: application/json' \
  -d '{
    "operacion":"retiro",
    "usuario":"player_1",
    "agente":"agent_user",
    "contrasena_agente":"agent_pass",
    "cantidad":500
  }'
```

Create total withdraw job (`descarga_total` uses button `Toda` and ignores manual amount fill):

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H 'content-type: application/json' \
  -d '{
    "operacion":"descarga_total",
    "usuario":"player_1",
    "agente":"agent_user",
    "contrasena_agente":"agent_pass"
  }'
```

Alias example (`retiro_total` is normalized to `descarga_total`):

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H 'content-type: application/json' \
  -d '{
    "operacion":"retiro_total",
    "usuario":"player_1",
    "agente":"agent_user",
    "contrasena_agente":"agent_pass"
  }'
```

Consult balance job (`consultar_saldo`):

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H 'content-type: application/json' \
  -d '{
    "operacion":"consultar_saldo",
    "usuario":"player_1",
    "agente":"agent_user",
    "contrasena_agente":"agent_pass"
  }'
```

Alias example (`consultar saldo` is normalized to `consultar_saldo`):

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H 'content-type: application/json' \
  -d '{
    "operacion":"consultar saldo",
    "usuario":"player_1",
    "agente":"agent_user",
    "contrasena_agente":"agent_pass"
  }'
```

Note: `cantidad` is required for `carga` and `descarga`; for `descarga_total`/`retiro_total`/`consultar_saldo` it is optional and ignored.

Force visual/debug mode for a funds job:

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H 'content-type: application/json' \
  -d '{
    "operacion":"carga",
    "usuario":"player_1",
    "agente":"agent_user",
    "contrasena_agente":"agent_pass",
    "cantidad":500,
    "headless":false,
    "debug":true,
    "slowMo":120,
    "timeoutMs":120000
  }'
```

Returned fields:

- `id`
- `jobType` (`login|create-player|deposit|balance`)
- `status` (`queued|running|succeeded|failed|expired`)
- `createdAt`, `startedAt`, `finishedAt`
- `error`
- `artifactPaths`
- `steps`
- `result` (optional, for `balance` jobs)

Example result payload for `balance` jobs:

```json
{
  "result": {
    "kind": "balance",
    "usuario": "player_1",
    "saldoTexto": "12.345,67",
    "saldoNumero": 12345.67
  }
}
```

## Docker

Build image:

```bash
docker build -t scrapsinoca:latest .
```

Run default `run` mode:

```bash
docker run --rm \
  -v "$(pwd)/out:/app/out" \
  -v "$(pwd)/artifacts:/app/artifacts" \
  scrapsinoca:latest
```

Run API mode by overriding command:

```bash
docker run --rm \
  -v "$(pwd)/artifacts:/app/artifacts" \
  scrapsinoca:latest server --host 127.0.0.1 --port 3000
```

## CLI options

### `scraper run`

```text
--username <string>
--password <string>
--headless <boolean>
--debug <boolean>
--slow-mo <ms>
--timeout-ms <ms>
--retries <n>
--concurrency <n>
--output-dir <path>
--artifacts-dir <path>
--from-date <YYYY-MM-DD>
--to-date <YYYY-MM-DD>
--max-pages <n>
--log-level <fatal|error|warn|info|debug|trace|silent>
--no-block-resources
--reuse-session <boolean>
```

### `scraper server`

```text
--host <host>
--port <port>
--headless <boolean>
--debug <boolean>
--slow-mo <ms>
--timeout-ms <ms>
--artifacts-dir <path>
--log-level <fatal|error|warn|info|debug|trace|silent>
--no-block-resources
```

## Outputs

Run mode:

- `out/data.<timestamp>.json`
- `out/data.<timestamp>.csv`
- `out/run.<timestamp>.meta.json`

Server mode (job artifacts):

- `artifacts/jobs/<jobId>/...`

## Tests

```bash
npm test
```

## Benchmark (deposit)

```bash
npm run benchmark:deposit -- --agent monchi30 --password 123mon --user pruebita --amount 1 --turbo-runs 5 --visual-runs 3
```
