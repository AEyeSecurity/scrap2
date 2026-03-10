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
