# MasterCRM Auth

Este documento resume como quedo implementado el login y registro web compatible con el frontend actual, sin usar el webhook de n8n.

## Objetivo

Se agregaron rutas nuevas dentro de esta API para cubrir el contrato que hoy espera el frontend:

- `POST /mastercrm-register`
- `POST /mastercrm-login`
- `POST /mastercrm-clients`
- `POST /mastercrm-link-cashier`

La ruta existente `POST /login` no se toca. Sigue siendo el login asincrono de agentes para Playwright.

## Como esta hecho

### Persistencia

Se creo la tabla `public.mastercrm_users` en la migracion:

- `db/migrations/20260310_mastercrm_users.sql`
- `db/migrations/20260311_mastercrm_user_owner_links.sql`

Columnas principales:

- `id bigint generated always as identity`
- `username` unico y normalizado en minuscula
- `password_hash`
- `nombre`
- `telefono`
- `inversion` con default `0`
- `is_active`
- `created_at`
- `updated_at`

### Store de usuarios

La logica de usuarios web vive en:

- `src/mastercrm-user-store.ts`

Ese modulo resuelve:

- alta de usuario;
- busqueda por `id`;
- autenticacion por `username + password`;
- vinculo entre usuario web y owner/cajero existente;
- hash de contrasenas con `node:crypto` usando `scrypt` + salt aleatorio;
- serializacion al formato que consume el frontend.

## Contrato HTTP

### `POST /mastercrm-register`

Acepta aliases:

- `username` o `usuario`
- `password` o `contrasena`
- `nombre` o `name`
- `telefono`, `phone` o `celular`

Si dos aliases del mismo campo llegan con valores distintos, responde `400`.

Ejemplo:

```json
{
  "usuario": "juan",
  "contrasena": "secret123",
  "nombre": "Juan Perez",
  "telefono": "54911..."
}
```

Respuesta exitosa `201`:

```json
{
  "id": 1,
  "usuario": "juan",
  "nombre": "Juan Perez",
  "telefono": "54911...",
  "created_at": "2026-03-10T12:00:00.000Z",
  "inversion": 0
}
```

### `POST /mastercrm-login`

Acepta exactamente el payload duplicado que hoy manda el frontend:

```json
{
  "username": "juan",
  "password": "secret123",
  "usuario": "juan",
  "contrasena": "secret123"
}
```

Reglas:

- autentica contra `mastercrm_users`;
- responde `200` con JSON canonico;
- responde `401` si las credenciales no son validas;
- nunca devuelve `password` ni `contrasena`.

### `POST /mastercrm-clients`

Devuelve el dashboard del cajero/owner vinculado al usuario web.

Acepta:

- `id`
- `user_id`
- `usuario_id`

Si el usuario existe y esta activo, responde un JSON con:

```json
{
  "linkedOwner": {},
  "summary": {},
  "financialInputs": {},
  "primaryKpis": {},
  "statsKpis": {},
  "charts": {},
  "clientes": []
}
```

Esta ruta ya lee datos reales persistidos en Supabase a partir de snapshots diarios y tablas owner-centric.

### `POST /mastercrm-link-cashier`

Vincula el usuario web autenticado del frontend con un owner/cajero ya existente.

Payload esperado:

```json
{
  "user_id": 123,
  "owner_key": "owner_key_del_cajero",
  "pagina": "ASN"
}
```

Reglas:

- `user_id` acepta string o number, pero debe resolver a entero positivo;
- `owner_key` se normaliza a minuscula;
- `pagina` acepta `ASN` o `RdA`; si no viene, el backend mantiene compatibilidad con `ASN`;
- el usuario debe existir y estar activo en `mastercrm_users`;
- el `owner_key` debe existir en `owners` con la `pagina` indicada;
- si el vinculo exacto ya existe, responde `409`;
- no crea owners nuevos ni devuelve todavia el listado de cajeros vinculados.

Respuesta exitosa `201`:

```json
{
  "success": true,
  "message": "Usuario vinculado al cajero correctamente",
  "data": {
    "user_id": 123,
    "owner_key": "owner_key_del_cajero",
    "pagina": "ASN",
    "linked": true
  }
}
```

## CORS

Se agrego CORS global con `@fastify/cors`.

Variable nueva:

- `MASTERCRM_CORS_ORIGINS`

Formato:

```text
http://localhost:5173,http://127.0.0.1:5173,https://tu-frontend.com
```

Default de desarrollo:

- `http://localhost:5173`
- `http://127.0.0.1:5173`

## Resumen de decisiones

- no se reutiliza `/login` porque ya existe para jobs de agentes;
- los usuarios web viven en una tabla propia, separada del modelo `owners/clients`;
- no hay JWT ni cookie en esta primera version;
- `mastercrm-clients` usa snapshots persistidos y no depende de Supabase Storage;
- `mastercrm-link-cashier` ya soporta `pagina = ASN` y `pagina = RdA`.
