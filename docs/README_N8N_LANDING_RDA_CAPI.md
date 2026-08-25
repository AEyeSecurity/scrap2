# n8n: landing automática → Leandro central

La landing abre siempre `+5493562590932` (workflow Leandro) y usa el texto `Hola, quiero mi usuario con mi bono: XXXXXXXX`. El código es un token de ocho caracteres generado y persistido por el backend; no se deriva a un cajero desde el navegador.

En la primera rama del mensaje entrante de `L10 Royal L Support` (webhook `rls`), `API WhatsApp Intake Captura` debe hacer `POST http://127.0.0.1:3000/whatsapp/intake`. Debe enviar el body Twilio completo, `routingKey` y `routeContext`; no enviar `pagina` ni `ownerContext`.

```js
const body = $('Edit Fields').item.json.body || {};
const digits = (value) => String(value || '').replace(/\D/g, '');
const clientPhone = digits(body.WaId || body.From);
const actorPhone = digits($json.agentPhone);
const routingKey = String($json.agentKey || '').trim().toLowerCase();

return {
  telefono: clientPhone ? `+${clientPhone}` : null,
  body,
  routingKey, // luqui10 (Lucas10, 60%) o vicky (40%)
  routeContext: {
    actorAlias: String($json.agentNick || routingKey).trim(),
    actorPhone: `+${actorPhone}`
  },
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

El backend reclama el token de forma atómica, con vigencia de 24 h. Para landing, sólo crea el intake CRM/CAPI Lead y permite handoff cuando la ruta tiene exactamente un owner RdA activo; si no, responde `CENTRAL_RDA_OWNER_INVALID` y n8n no debe redirigir al cajero. `landing_contact_outbox` guarda el Contact CAPI para entrega durable. Los mensajes posteriores/QR no reclaman ni duplican la sesión.
