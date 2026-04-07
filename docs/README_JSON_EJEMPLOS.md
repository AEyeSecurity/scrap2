# JSON de ejemplo

Los bloques siguientes estan pensados para copiar tal cual en llamadas `curl` contra el contenedor expuesto en `http://127.0.0.1:3000`.

## Login

```json
{
  "username": "mi_agente",
  "password": "mi_password"
}
```

## Crear usuario RdA

```json
{
  "pagina": "RdA",
  "loginUsername": "agent_user",
  "loginPassword": "agent_pass",
  "newUsername": "player_1",
  "newPassword": "player_pass"
}
```

## Crear usuario ASN con telefono y ownerContext

```json
{
  "pagina": "ASN",
  "loginUsername": "agent_user",
  "loginPassword": "agent_pass",
  "newUsername": "player_1",
  "newPassword": "player_pass",
  "telefono": "+5491122334455",
  "ownerContext": {
    "ownerKey": "wf_123",
    "ownerLabel": "Lucas 10",
    "actorAlias": "Vicky",
    "actorPhone": "+5493511111111"
  }
}
```

`telefono` sin `ownerContext` ahora devuelve `400`.

## Intake pending

```json
{
  "pagina": "ASN",
  "telefono": "+5493516633070",
  "ownerContext": {
    "ownerKey": "wf_123",
    "ownerLabel": "Lucas 10",
    "actorAlias": "Vicky",
    "actorPhone": "+5493511111111"
  }
}
```

## Assign phone

```json
{
  "pagina": "ASN",
  "usuario": "player_1",
  "agente": "agent_user",
  "contrasena_agente": "agent_pass",
  "telefono": "+5491122334455",
  "ownerContext": {
    "ownerKey": "wf_123",
    "ownerLabel": "Lucas 10",
    "actorAlias": "Vicky"
  }
}
```

Notas:

- `ownerContext` es obligatorio.
- Si el telefono no existia en Supabase, este endpoint crea cliente y vinculo.
- Si el username ya estaba en otro telefono del mismo owner, lo mueve automaticamente.

## Carga

```json
{
  "pagina": "RdA",
  "operacion": "carga",
  "usuario": "player_1",
  "agente": "agent_user",
  "contrasena_agente": "agent_pass",
  "cantidad": 500
}
```

## Descarga

```json
{
  "pagina": "RdA",
  "operacion": "descarga",
  "usuario": "player_1",
  "agente": "agent_user",
  "contrasena_agente": "agent_pass",
  "cantidad": 500
}
```

## Descarga total

```json
{
  "pagina": "RdA",
  "operacion": "descarga_total",
  "usuario": "player_1",
  "agente": "agent_user",
  "contrasena_agente": "agent_pass"
}
```

## Consultar saldo

```json
{
  "pagina": "RdA",
  "operacion": "consultar_saldo",
  "usuario": "player_1",
  "agente": "agent_user",
  "contrasena_agente": "agent_pass"
}
```

## Reporte ASN

```json
{
  "pagina": "ASN",
  "operacion": "reporte",
  "usuario": "Ariel728",
  "agente": "luuucas10",
  "contrasena_agente": "australopitecus12725"
}
```

## Report run ASN persistido

```json
{
  "pagina": "ASN",
  "principalKey": "wf_123",
  "agente": "luuucas10",
  "contrasena_agente": "australopitecus12725",
  "reportDate": "2026-03-10"
}
```

## Overrides de ejecucion visual

Puedes agregar estos campos a `login` o `create-player`:

```json
{
  "headless": false,
  "debug": true,
  "slowMo": 120,
  "timeoutMs": 120000
}
```

Nota: `POST /users/deposit` fuerza modo turbo para `RdA` y `ASN`, por lo que ignora overrides visuales y ejecuta con `headless=true`, `debug=false`, `slowMo=0` y `timeoutMs<=15000`.

## Ejemplo completo con `curl`

```bash
curl -s -X POST http://127.0.0.1:3000/users/deposit \
  -H "content-type: application/json" \
  -d "{\"pagina\":\"RdA\",\"operacion\":\"carga\",\"usuario\":\"player_1\",\"agente\":\"agent_user\",\"contrasena_agente\":\"agent_pass\",\"cantidad\":500}"
```
