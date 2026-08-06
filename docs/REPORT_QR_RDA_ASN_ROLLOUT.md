# Rollout escalonado de reportes y WhatsApp QR

Este documento describe el despliegue seguro de los cambios RdA/ASN. No se debe habilitar ASN antes de completar las tres compuertas RdA.

## Estado inicial obligatorio

```dotenv
REPORT_ASN_ENABLED=false
WHATSAPP_QR_ASN_ENABLED_OWNER_IDS=
WHATSAPP_QR_AUTO_BACKFILL_ENABLED=false
REPORT_WORKER_CONCURRENCY=1
REPORT_WORKER_LEASE_SECONDS=600
SCRAP2_BROWSER_CONCURRENCY=1
REPORT_EXPECTED_BA_START_HOUR=2
REPORT_EXPECTED_BA_END_HOUR=6
WHATSAPP_QR_MESSAGE_RETENTION_DAYS=90
```

`REPORT_API_TOKEN` se configura en el servicio y en n8n en el mismo cambio. Mientras n8n no haya sido actualizado, debe permanecer vacío para no cortar las corridas existentes.

## Migraciones

Aplicar, en este orden, sobre el esquema actual:

1. `20260806160000_rda_daily_amount_nullable.sql`
2. `20260806160100_whatsapp_qr_event_idempotency.sql`
3. `20260806160200_mastercrm_platform_credentials.sql`
4. `20260806160300_report_run_lease_tokens.sql`

Las migraciones conservan los aliases RdA y copian las credenciales existentes a la tabla neutral. No contienen secretos; los valores se migran dentro de la base.

Validaciones posteriores:

```sql
select count(*) from public.mastercrm_platform_credentials where pagina = 'RdA';
select count(*) from public.mastercrm_whatsapp_qr_messages where event_at is null;
select count(*) from public.mastercrm_whatsapp_qr_matches where event_at is null;
select count(*) from public.report_runs where contrasena_agente <> '[redacted]' and credential_id is not null;
```

El último resultado debe ser cero. Las filas históricas sin `credential_id` se mantienen temporalmente para compatibilidad y se redactan al cerrar su corrida.

## Compuerta RdA 1: reporte

1. Desplegar backend y portal con ASN deshabilitado.
2. Ejecutar un único reporte RdA del día para el owner piloto.
3. Confirmar un solo item terminado y un solo snapshot para `(identity_id, report_date)`.
4. Comparar el total mensual con RdA.
5. Si existe snapshot anterior del mismo mes, comprobar que `cargado_hoy = total_actual - total_anterior`.
6. Si no existe baseline y no es el primer día, comprobar `cargado_hoy = null`, cobertura incompleta y ausencia de cero falso.
7. Confirmar en el portal fecha, cobertura y actualización correctas.

## Compuerta RdA 2: QR

No desconectar la sesión conectada salvo recuperación autorizada.

1. Enviar un chat orgánico desde un teléfono de prueba nuevo.
2. Enviar un CTWA de prueba con `externalAdReply`.
3. Repetir/reproducir ambos eventos y comprobar que no se crean duplicados.
4. Confirmar para el orgánico: `transport=whatsapp_qr`, adquisición orgánica/unknown.
5. Confirmar para CTWA: `transport=whatsapp_qr`, adquisición `meta_ctwa`, con `sourceId`, `sourceUrl` y `ctwaClid` cuando estén disponibles.
6. Verificar detección, validación RdA, asignación, reporte, Analytics y cobertura QR.
7. Ejecutar backfill únicamente para el mes solicitado y dejar `WHATSAPP_QR_AUTO_BACKFILL_ENABLED=false`.

## Compuerta RdA 3: refactor neutral

1. Repetir el reporte individual y el piloto QR usando las credenciales de `mastercrm_platform_credentials`.
2. Comparar resultados con la ejecución previa al refactor.
3. Simular credenciales inválidas: debe existir un único intento de login y todos los items pendientes deben terminar con `PLATFORM_AUTH_FAILED`.
4. Simular lease vencido: el worker anterior no debe completar el item ni escribir snapshot/recheck.
5. Confirmar que el panel de salud muestra corrida, duración, cobertura, error, credenciales y estado QR.

## Piloto ASN

Solo después de aprobar RdA 1, 2 y 3:

1. Cargar credenciales ASN en `mastercrm_platform_credentials`.
2. Configurar un único UUID de owner en `WHATSAPP_QR_ASN_ENABLED_OWNER_IDS`.
3. Mantener `REPORT_ASN_ENABLED=false` y probar primero validación/asignación QR del owner allowlisted.
4. Habilitar `REPORT_ASN_ENABLED=true` para una única corrida ASN controlada.
5. Probar fecha actual e histórica. Si ASN no expone esa fecha, exigir `REPORT_DATE_UNAVAILABLE` y ausencia de snapshot.
6. Reconciliar corrida, items, snapshots, cliente, Analytics y panel de salud.
7. Ampliar la allowlist de owners en etapas; habilitar la corrida masiva al final.

## Verificación automatizada

Backend:

```powershell
npm test -- --run
npm run build
```

Portal:

```powershell
npm run build
npm run lint
```

Los workflows exportados deben importarse con `REPORT_API_TOKEN` configurado en n8n antes de activar la protección del backend.
También requieren `RDA_REPORT_AGENT_USERNAME`, `RDA_REPORT_AGENT_PASSWORD`, `ASN_REPORT_AGENT_USERNAME` y `ASN_REPORT_AGENT_PASSWORD`; las credenciales ya no están embebidas en los JSON exportados.
