# Supabase con Docker

Esta guia explica como conectar este proyecto a una base de datos de Supabase cuando la API se ejecuta en Docker.

## Para que se usa Supabase en este proyecto

Supabase no es obligatorio para levantar la API, pero si es obligatorio para estas funciones:

- persistencia de telefonos y vinculos owner-centric;
- endpoints `POST /users/intake-pending` y `POST /users/assign-phone`;
- sincronizacion posterior a `POST /users/create-player` cuando el payload incluye `telefono`;
- usuarios web de MasterCRM (`/mastercrm-register`, `/mastercrm-login`, `/mastercrm-clients`);
- cola persistente de reportes ASN (`POST /reports/asn/run` y endpoints de consulta asociados).

Si no configuras Supabase, la API puede seguir corriendo, pero esas funciones no van a estar disponibles correctamente.

## Que datos necesitas de Supabase

Necesitas un proyecto de Supabase ya creado y dos valores del panel del proyecto:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Donde sacar esos datos

En el dashboard de Supabase:

1. Entra al proyecto.
2. Abre `Settings`.
3. Abre `API`.
4. Copia:
   - `Project URL` -> usar como `SUPABASE_URL`
   - `service_role` o `secret` key -> usar como `SUPABASE_SERVICE_ROLE_KEY`

## Que key usar

Usa la key `service_role` o una `secret` key equivalente para backend.

No uses:

- `anon`
- `publishable`
- ninguna key pensada para frontend

El codigo rechaza explicitamente una key publishable. Esta API necesita privilegios de backend porque inserta en tablas privadas y ejecuta RPCs con permisos de `service_role`.

## Que estructura debe existir en Supabase

No alcanza con tener un proyecto vacio. Antes de arrancar el contenedor, tu base debe tener las tablas, funciones y grants que espera la aplicacion.

Esos cambios estan en:

- [db/migrations/20260303_player_phone.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260303_player_phone.sql)
- [db/migrations/20260304_assign_username_by_phone.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260304_assign_username_by_phone.sql)
- [db/migrations/20260304_fix_assign_pending_username_ambiguity.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260304_fix_assign_pending_username_ambiguity.sql)
- [db/migrations/20260304_fix_telefono_check.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260304_fix_telefono_check.sql)
- [db/migrations/20260304_pending_cliente_rpc.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260304_pending_cliente_rpc.sql)
- [db/migrations/20260304_restrict_pending_rpc_grants.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260304_restrict_pending_rpc_grants.sql)
- [db/migrations/20260306_owner_context_v2.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260306_owner_context_v2.sql)
- [db/migrations/20260309_owner_centric_v3.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260309_owner_centric_v3.sql)
- [db/migrations/20260309_owner_centric_v3_hotfix.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260309_owner_centric_v3_hotfix.sql)
- [db/migrations/20260310_mastercrm_users.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260310_mastercrm_users.sql)
- [db/migrations/20260311_mastercrm_user_owner_links.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260311_mastercrm_user_owner_links.sql)
- [db/migrations/20260310_report_run_queue.sql](C:/Users/leone/OneDrive/Escritorio/Polo/scrap2/db/migrations/20260310_report_run_queue.sql)

### Como aplicar las migraciones

La forma mas simple, si administras Supabase desde el dashboard, es:

1. Abrir `SQL Editor` en tu proyecto de Supabase.
2. Ejecutar los archivos SQL de `db/migrations/` en orden por nombre.
3. Confirmar que no hubo errores.

El orden importa porque las migraciones mas nuevas dependen de tablas y funciones creadas por las anteriores.

## Donde pasar las variables

La aplicacion lee estas variables desde el entorno del proceso dentro del contenedor Docker:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

La forma recomendada en este repo es guardarlas en un archivo `.env` en la raiz del proyecto y pasar ese archivo a Docker con `--env-file`.

Hay dos archivos pensados para eso:

- `.env`: archivo real para tu entorno, ignorado por Git;
- `.env.example`: plantilla sin secretos para compartir o recrear el entorno.

### Ejemplo de `.env`

```dotenv
API_HOST=0.0.0.0
API_PORT=3000
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_o_secret_key
REPORT_WORKER_ENABLED=true
REPORT_WORKER_CONCURRENCY=3
REPORT_WORKER_POLL_MS=1000
REPORT_WORKER_LEASE_SECONDS=60
REPORT_WORKER_MAX_ATTEMPTS=3
```

### Ejemplo minimo

```powershell
docker run --rm `
  -p 3000:3000 `
  --env-file .env `
  -v ${PWD}/artifacts:/app/artifacts `
  scrapsinoca server --host 0.0.0.0 --port 3000
```

### Ejemplo con report worker configurado

```powershell
docker run --rm `
  -p 3000:3000 `
  --env-file .env `
  -v ${PWD}/artifacts:/app/artifacts `
  scrapsinoca server --host 0.0.0.0 --port 3000
```

Si necesitas cambiar algun valor solo para una ejecucion, puedes mantener `.env` como base y sobreescribir variables puntuales con `-e` en el comando.

## Que valida la aplicacion al conectar

Al crear el cliente de Supabase, la app hace estas comprobaciones:

- si falta `SUPABASE_URL`, falla;
- si falta `SUPABASE_SERVICE_ROLE_KEY`, falla;
- si la key empieza con `sb_publishable_`, falla;
- si las tablas o RPCs no existen, fallaran los endpoints que las usan.

## Como saber si quedo bien conectado

Senales practicas de que la conexion quedo bien:

- `POST /mastercrm-register` inserta correctamente en `mastercrm_users`;
- `POST /users/intake-pending` responde `200` y devuelve ids de la relacion creada;
- `POST /reports/asn/run` responde `202` y crea una corrida persistida;
- el worker de reportes avanza items en Supabase cuando esta habilitado.

Si la conexion esta mal, lo esperable es ver errores de configuracion o errores de PostgREST/RPC al invocar endpoints que dependen de Supabase.

## Errores tipicos

### `Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`

Falta alguna de las dos variables en el contenedor.

### `SUPABASE_SERVICE_ROLE_KEY is invalid: got a publishable key`

Le pasaste una key de frontend. Cambiala por `service_role` o por una key secreta de backend.

### Error al llamar RPCs o tablas inexistentes

Las migraciones no se aplicaron, se aplicaron fuera de orden o el proyecto Supabase no es el correcto.

## Recomendacion operativa

- guarda `SUPABASE_SERVICE_ROLE_KEY` como secreto del entorno donde lances Docker;
- no la subas al repo;
- no la reutilices en frontend ni en n8n del lado cliente;
- si cambias de proyecto Supabase, vuelve a aplicar las migraciones antes de apuntar el contenedor al nuevo `SUPABASE_URL`.
