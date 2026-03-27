# Testeo

## Estado actual

En este repo la suite se ejecuta con Vitest, pero el host necesita dependencias instaladas. Si trabajas solo con contenedor, usa un contenedor efimero para testear y deja la imagen `scrapsinoca` para runtime.

## Ejecutar todos los tests con Docker

```powershell
docker run --rm `
  -v ${PWD}:/workspace `
  -w /workspace `
  mcr.microsoft.com/playwright:v1.58.2-jammy `
  bash -lc "npm ci && npm test"
```

## Ejecutar un archivo puntual

```powershell
docker run --rm `
  -v ${PWD}:/workspace `
  -w /workspace `
  mcr.microsoft.com/playwright:v1.58.2-jammy `
  bash -lc "npm ci && npx vitest run tests/server.test.ts"
```

## Ejecutar tests en watch

```powershell
docker run --rm -it `
  -v ${PWD}:/workspace `
  -w /workspace `
  mcr.microsoft.com/playwright:v1.58.2-jammy `
  bash -lc "npm ci && npm run test:watch"
```

## Benchmark de depositos

Este script necesita credenciales reales y acceso al sitio de destino.

```powershell
docker run --rm -it `
  -v ${PWD}:/workspace `
  -w /workspace `
  mcr.microsoft.com/playwright:v1.58.2-jammy `
  bash -lc "npm ci && npm run benchmark:deposit -- --agent mi_agente --password mi_password --user pruebita --amount 1 --turbo-runs 5 --visual-runs 3"
```

Salida esperada:

- resumen por stdout;
- archivo JSON en `out/benchmarks/`.

## Smoke de API para `RdA`

Este smoke reutiliza la API HTTP del backend y espera a que termine el job encolado.

Variables minimas:

```powershell
$env:RDA_AGENTE="agent_user"
$env:RDA_CONTRASENA="agent_pass"
$env:RDA_USUARIO_TEST="player_1"
```

Consulta de saldo:

```powershell
npm run smoke:rda-api
```

Carga:

```powershell
$env:RDA_ACTION="deposit"
$env:RDA_OPERACION="carga"
$env:RDA_CANTIDAD="500"
npm run smoke:rda-api
```

Alta de usuario:

```powershell
$env:RDA_ACTION="create-player"
$env:RDA_NEW_USERNAME="codexrda123"
$env:RDA_NEW_PASSWORD="Secret123!"
npm run smoke:rda-api
```

Notas:

- usa `RDA_API_BASE_URL` si tu backend no corre en `http://127.0.0.1:3000`
- usa `RDA_SPAWN_SERVER=true` si quieres que el script levante `npm start -- server`
- imprime `jobId`, `status`, `result`, `steps` y `artifactPaths`
- si el job falla, sale con codigo `1`

## Que cubre la suite

- normalizacion de operaciones y pagina;
- parseo de saldo;
- matching de filas de usuario;
- endpoints y validaciones del servidor;
- stores de telefono y reportes;
- comportamiento de la cola de jobs.

## Notas

- La imagen del `Dockerfile` no copia `tests/` ni `vitest.config.ts`, por eso no es la imagen correcta para testear.
- Si Docker Desktop no esta levantado, los comandos anteriores fallan antes de arrancar Vitest.
