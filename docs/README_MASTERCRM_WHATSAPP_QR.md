# MasterCRM WhatsApp QR

V1 mantiene n8n como entrada y routing manual. La solapa `WhatsApp QR` permite que cada cajero conecte su numero publicitario por QR tipo WhatsApp Web. El backend procesa eventos en modo solo lectura, detecta candidatos por nombre de contacto o mensaje saliente `Usuario: ...`, valida el username en RdA con credenciales sincronizadas y asigna `telefono -> username -> owner`.

Al conectar un QR, el backfill inicial procesa contactos e historial reciente que WhatsApp entrega en `messaging-history.set`, pero solo si el telefono existe en la cartera mensual del cajero (`owner_client_monthly_facts` del mes actual en America/Argentina/Buenos_Aires). No guarda conversaciones completas.

## Base de datos

Aplicar la migracion:

```powershell
db/migrations/20260630_mastercrm_whatsapp_qr.sql
```

Crea:

- `mastercrm_whatsapp_qr_sessions`
- `mastercrm_whatsapp_qr_messages`
- `mastercrm_whatsapp_qr_matches`
- `mastercrm_rda_credentials`

La API usa service role. El CRM no expone claves RdA ni `qr_payload`; solo muestra `qr_data_url`, estado, heartbeat y matches.

## Variables

```dotenv
MASTERCRM_QR_ADMIN_OWNER_KEYS=luqui10:luqui10
WHATSAPP_QR_RUNTIME=baileys
WHATSAPP_QR_AUTH_DIR=artifacts/whatsapp-qr-auth
WHATSAPP_QR_TTL_MS=90000
WHATSAPP_QR_HEARTBEAT_STALE_MS=180000
WHATSAPP_QR_ALERT_POLL_MS=60000

TELEGRAM_BOT_TOKEN=
TELEGRAM_ALERT_CHAT_ID=
```

Si existen variables `SUPERBOT_TELEGRAM_BOT_TOKEN` y `SUPERBOT_TELEGRAM_ALERT_CHAT_ID`, tambien se usan como fallback. No hardcodear tokens.

## Sync n8n -> backend

Dry-run:

```powershell
npm run sync:n8n-rda-cashiers -- --sqlite C:\ruta\a\n8n\database.sqlite
```

Escritura:

```powershell
npm run sync:n8n-rda-cashiers -- --sqlite C:\ruta\a\n8n\database.sqlite --write
```

El comando lee tablas `data_table_user_*` con columnas `owner_key`, `usuario`, `clave`, filtra filas RdA activas y bloquea owners inexistentes. No imprime claves.

Si una sesion quedo `connected` y la auth persistida sigue valida, el backend la reengancha automaticamente al reiniciar. Si falta `creds.json` o la auth ya no sirve, la sesion pasa a `disconnected` con error explicito y exige un nuevo scan.

## Endpoints CRM

- `POST /mastercrm-whatsapp-qr/status`
- `POST /mastercrm-whatsapp-qr/connect`
- `POST /mastercrm-whatsapp-qr/disconnect`

Todos requieren bearer token MasterCRM y `user_id`. Un cajero solo opera su owner vinculado. Un admin por `MASTERCRM_QR_ADMIN_OWNER_KEYS` puede ver todas las sesiones y desconectar por `owner_id`.

## Activacion controlada

1. Aplicar migracion.
2. Ejecutar sync en dry-run.
3. Resolver owners faltantes si los hubiera.
4. Ejecutar sync con `--write`.
5. Levantar backend con `WHATSAPP_QR_RUNTIME=baileys`.
6. Entrar al CRM y abrir `WhatsApp QR`.
7. Conectar un cajero de prueba y validar match por contacto o mensaje saliente.
