# Landing WhatsApp central

## Contrato vigente

- URL pública principal: `https://landing.imperial-support.com/landing`.
- Número WhatsApp: `+5491125671037`.
- Preparación: `POST /landing/contact`.
- Confirmación de clic: `POST /landing/contact/confirm`.
- Variante: `rda-central-auto-v1`.
- Evento Meta del clic: `Contact`.

La landing no navega automáticamente. Primero persiste una sesión y un token, y después habilita un `<a>` real con una URL `https://wa.me/5491125671037?...`. La apertura ocurre únicamente por el toque del usuario.

## Preparación

Payload mínimo:

```json
{
  "eventId": "contact-...",
  "landingSessionId": "landing-..."
}
```

También acepta `fbp`, `fbc`, `fbclid`, referrer, URL de origen y UTMs. La identidad se conserva en los reintentos manuales.

Respuesta:

```json
{
  "status": "ok",
  "eventId": "contact-...",
  "whatsappUrl": "https://wa.me/5491125671037?text=...",
  "whatsappMessage": "Hola, quiero mi usuario con mi bono: XXXXXXXX",
  "landingToken": "XXXXXXXX",
  "attributionStatus": "persisted",
  "trackingStatus": "awaiting_click",
  "created": true
}
```

Si no puede persistir la sesión, la API responde `503` y no entrega una URL de WhatsApp. La UI muestra `Reintentar` y reutiliza el mismo `eventId` y `landingSessionId`.

## Clic y Meta

Al pulsar `Abrir WhatsApp`:

1. Pixel emite `Contact` con `{ eventID: eventId }`.
2. `sendBeacon` envía sin bloquear la navegación:

```json
{
  "landingSessionId": "landing-...",
  "eventId": "contact-..."
}
```

3. El enlace navega directamente a `wa.me` conservando la activación del usuario.

El backend valida que sesión y evento coincidan, toma la atribución persistida y encola CAPI en `landing_contact_outbox`. La restricción única de `event_id` deduplica clics o confirmaciones repetidas.

`PageView` se mide al cargar. `Contact` representa únicamente el clic en WhatsApp, no una visita ni una precarga del navegador.

## Ingreso al CRM

El primer mensaje de WhatsApp contiene el token. `/whatsapp/intake` lo reclama por token, teléfono y `MessageSid` y conserva la atribución durante el ingreso central.

- Cartera con un owner RdA: crea el pendiente RdA.
- Cartera con un owner RdA y uno ASN: crea el pendiente exclusivamente en RdA.
- Cartera sin owner RdA: responde `CENTRAL_RDA_OWNER_INVALID`.
- Un reintento del mismo mensaje mantiene el mismo resultado y no puede convertirse en intake neutral.

## Validación

- La página no cambia de URL antes del clic.
- El enlace apunta a `wa.me/5491125671037`.
- No existe `window.location.href` ni temporizador de redirección.
- `Contact` no aparece antes del clic.
- Browser y CAPI usan el mismo `eventId`.
- Un doble clic genera un solo evento durable.
- Una cartera ASN/RdA crea únicamente el pendiente RdA.

WhatsApp o el sistema operativo pueden mostrar su propia pantalla `Abrir aplicación / Continuar en WhatsApp Web`; esa confirmación pertenece a WhatsApp/WebView y no se controla desde la landing.
