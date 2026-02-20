# ScrapSinoca

Scraper CLI/API for `agents.reydeases.com` using Node.js + Playwright.

## Features

- Login automation (UI) with reusable session (`storageState`) in `run` mode.
- Hybrid extraction strategy in `run`: login in UI, then fetch via authenticated API calls.
- Credentials by CLI flags (`--username`, `--password`) with env fallback.
- Async API server with shared job queue (`POST /login`, `POST /users/create-player`, `GET /jobs/:id`).
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

Returned fields:

- `id`
- `jobType` (`login|create-player`)
- `status` (`queued|running|succeeded|failed|expired`)
- `createdAt`, `startedAt`, `finishedAt`
- `error`
- `artifactPaths`
- `steps`

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
