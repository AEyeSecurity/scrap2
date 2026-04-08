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

Nota `RdA` al `2026-04-07`:

- si el sitio remoto devuelve `RdA create-player API error (status 231): Password not verified`, el backend igual va a buscar el usuario en `/users/all`;
- si lo encuentra, el smoke queda `ok`;
- si no lo encuentra, ese error confirma diagnostico correcto del backend, no un falso duplicado de username.

Notas:

- usa `RDA_API_BASE_URL` si tu backend no corre en `http://127.0.0.1:3000`
- usa `RDA_SPAWN_SERVER=true` si quieres que el script levante `npm start -- server`
- imprime `jobId`, `status`, `result`, `steps` y `artifactPaths`
- si el job falla, sale con codigo `1`

## Smoke manual de API para `ASN`

Este smoke sirve para validar login + post-login en ASN sin redeployar el contenedor productivo.

Levantar una instancia local temporal:

```powershell
$env:API_PORT="3001"
npm start -- server --port 3001
```

Consultar saldo contra ASN:

```powershell
$body = @{
  pagina = "ASN"
  operacion = "consultar_saldo"
  usuario = "usuario_existente"
  agente = "agente_asn"
  contrasena_agente = "password_asn"
  headless = $true
} | ConvertTo-Json

$job = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3001/users/deposit" -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri ("http://127.0.0.1:3001/jobs/" + $job.id)
```

Nota ASN al `2026-04-08`:

- el paso `01b-continue-intermediate` debe tolerar `Continuar` intermitente despues del login;
- si el shell `Administracion` ya esta visible, el job debe seguir como `ok` o `skipped`, no fallar con `locator.click`;
- esta verificacion cubre la misma zona que afectaba `deposit` en el workflow `Leandro`, pero sin mover saldo real.

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
