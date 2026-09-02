# n8n: landing con clic directo → Leandro central

La landing prepara una sesión para el número `+5491125671037` y muestra un enlace directo a WhatsApp. No redirige automáticamente. El texto incluye un token opaco de ocho caracteres generado por el backend:

```text
Hola, quiero mi usuario con mi bono: XXXXXXXX
```

El workflow activo `Leandro` recibe el mensaje por Twilio. `CRM Central Route Register` debe enviar el body Twilio completo, el `routingKey` y el `routeContext`; nunca debe enviar `pagina` ni `ownerContext`.

```js
const body = $('Edit Fields').first().json.body || {};
const digits = (value) => String(value ?? '').replace(/\D/g, '');
const clientPhone = digits(body.WaId || body.From);

return {
  telefono: clientPhone ? `+${clientPhone}` : null,
  body,
  routingKey: $json.routingKey,
  routeContext: $json.routeContext,
  sourceContext: {
    ctwaClid: body.ReferralCtwaClid || null,
    referralSourceId: body.ReferralSourceId || null,
    referralSourceUrl: body.ReferralSourceUrl || null,
    referralHeadline: body.ReferralHeadline || null,
    referralBody: body.ReferralBody || null,
    referralSourceType: body.ReferralSourceType || null,
    waId: body.WaId || null,
    messageSid: body.MessageSid || null,
    accountSid: body.AccountSid || null,
    profileName: body.ProfileName || null,
    receivedAt: new Date().toISOString()
  }
};
```

`CRM Central Route Register` reintenta el mismo request como máximo tres veces. No usa `continueRegularOutput`: Twilio continúa únicamente si el CRM responde correctamente. No se vuelve a sortear ni se elige otro destino.

El backend reclama el token de forma atómica durante 24 horas. Un reintento solo recupera la sesión si coinciden token, teléfono y `MessageSid`. Para una landing exige exactamente un owner RdA activo dentro de la cartera; la existencia simultánea de un owner ASN es válida. El pendiente se crea exclusivamente en RdA. Si falta el owner RdA, responde `CENTRAL_RDA_OWNER_INVALID` y n8n detiene la rama.

`Contact` no se genera al cargar la página. El clic del usuario dispara Pixel y `POST /landing/contact/confirm` con el mismo `eventId`; el backend lo encola idempotentemente en `landing_contact_outbox`.
