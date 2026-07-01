# MasterCRM WhatsApp QR

V1 mantiene n8n como entrada y routing manual. La solapa `WhatsApp QR` permite que cada cajero conecte su numero publicitario por QR tipo WhatsApp Web. El backend procesa eventos en modo solo lectura, detecta candidatos por nombre de contacto o mensaje saliente `Usuario: ...`, valida el username en RdA con credenciales sincronizadas y asigna `telefono -> username -> owner`.

Al conectar un QR, el backfill inicial procesa contactos e historial reciente que WhatsApp entrega en `messaging-history.set`, pero solo si el telefono existe en la cartera mensual del cajero (`owner_client_monthly_facts` del mes actual en America/Argentina/Buenos_Aires). No guarda conversaciones completas.

## Base de datos

Aplicar la migracion:

```powershell
db/migrations/20260630_mastercrm_whatsapp_qr.sql
db/migrations/20260701_mastercrm_whatsapp_qr_ignored_phones.sql
```

Crea:

- `mastercrm_whatsapp_qr_sessions`
- `mastercrm_whatsapp_qr_messages`
- `mastercrm_whatsapp_qr_matches`
- `mastercrm_rda_credentials`
- `mastercrm_whatsapp_qr_ignored_phones`

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
- `POST /mastercrm-whatsapp-qr/assign`
- `POST /mastercrm-whatsapp-qr/ignore`
- `POST /mastercrm-whatsapp-qr/connect`
- `POST /mastercrm-whatsapp-qr/disconnect`

Todos requieren bearer token MasterCRM y `user_id`. `status` y `assign` tambien requieren `month` en formato `YYYY-MM`. Un cajero solo opera su owner vinculado. Un admin por `MASTERCRM_QR_ADMIN_OWNER_KEYS` puede ver todas las sesiones y desconectar por `owner_id`.

## Solapa CRM

La solapa `WhatsApp QR` muestra:

- estado de la sesion y datos basicos del numero conectado;
- resumen mensual por telefono del mes seleccionado en la app;
- una cola operativa de revision con una fila real por telefono;
- detalle por telefono con senal por contacto, senal por mensaje, ultimo intento y error;
- accion manual `Validar y asignar` usando credenciales RdA ya sincronizadas.
- accion manual `Ignorar` por telefono y mes para sacar casos no-RdA de la cola operativa.

Estados operativos del panel:

- `Asignado`: el telefono ya quedo vinculado al usuario.
- `Revisar / no_signal`: no hubo senal usable para ese telefono.
- `Revisar / detected_unassigned`: hubo username detectado, pero todavia no quedo asignado.
- `Revisar / not_found`: el username sugerido no existe en RdA.
- `Revisar / conflict`: el username sugerido ya pertenece a otro numero.
- `Revisar / technical_error`: fallo la validacion o la asignacion.

La fuente de verdad del panel ya no es el ultimo match crudo. El estado visible sale de:

- telefonos del `selectedMonth` global;
- asignacion real actual del owner;
- senales QR mas recientes por contacto o mensaje.

No hay limite de `50` ni paginacion en v1. La respuesta de `status` devuelve:

- `summary`: totales del mes (`totalPhones`, `assigned`, `review`, `ignored` y breakdown por motivo);
- `queue`: filas operativas por telefono con `assignedUsername`, `suggestedUsername`, `contactCandidateUsername`, `outboundCandidateUsername`, `primarySignalSource`, `lastSignalAt`, `lastAttemptAt` y `lastError`.

## Activacion controlada

1. Aplicar migracion.
2. Ejecutar sync en dry-run.
3. Resolver owners faltantes si los hubiera.
4. Ejecutar sync con `--write`.
5. Levantar backend con `WHATSAPP_QR_RUNTIME=baileys`.
6. Entrar al CRM y abrir `WhatsApp QR`.
7. Conectar un cajero de prueba y validar match por contacto o mensaje saliente.
