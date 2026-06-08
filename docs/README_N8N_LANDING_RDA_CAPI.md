# n8n Landing RdA CAPI Intake

Objetivo: cuando la landing redirige a WhatsApp del bot asignado (`+5493515747477`), n8n debe avisar al backend en el primer mensaje real para unir telefono + metadata WhatsApp con la sesion web guardada por `/landing/contact`.

## Workflow destino

Workflow activo validado:

```text
name: L10 Royal L Support
id: SNPyXfKncVbOERFG
webhook: RLS
path: rls
bot: +5493515747477
```

No modificar `Valerio Alta Fortuna`: solo se usa para confirmar el shape real de los campos Meta click-to-WhatsApp.

## Conexion validada

El workflow ya usa la primera rama existente del mensaje inicial:

```text
RLS -> Get row(s) -> Edit Fields -> If -> Code9 -> Switch2
Switch2[first] -> Asignar agente intake
Asignar agente intake -> HTTP Request                         # respuesta/template actual
Asignar agente intake -> API WhatsApp Intake Captura          # POST /whatsapp/intake
Switch2[yes/no/other] -> API WhatsApp Intake Resolver         # no inventa atribucion
```

No crear una rama grande nueva si la primera rama sigue presente: el payload del nodo `API WhatsApp Intake Captura` ya conserva el body Twilio completo y los campos de atribucion que solo llegan en ese primer mensaje.

## Payload requerido en `API WhatsApp Intake Captura`

Tipo: `n8n-nodes-base.httpRequest`

Config:

```json
{
  "method": "POST",
  "url": "http://127.0.0.1:3000/whatsapp/intake",
  "sendHeaders": true,
  "headerParameters": {
    "parameters": [
      {
        "name": "Content-Type",
        "value": "application/json"
      }
    ]
  },
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ JSON.stringify((() => {\n  const body = $('Edit Fields').item.json.body || {};\n\n  const onlyDigits = (value) => String(value ?? '').replace(/\\D/g, '');\n  const asE164 = (value) => {\n    const digits = onlyDigits(value);\n    return digits ? `+${digits}` : null;\n  };\n\n  let pagina = 'RdA';\n  try {\n    pagina = String($('Get row(s)').first().json.Sede || pagina).trim() || pagina;\n  } catch (e) {}\n\n  const clientePhone = asE164(body.WaId || body.From);\n  const actorPhone = asE164($json.agentPhone);\n  const agentKey = String($json.agentKey || '').trim().toLowerCase();\n  const agentNick = String($json.agentNick || agentKey || 'Lucas10').trim();\n\n  return {\n    pagina,\n    telefono: clientePhone,\n    body,\n    ownerContext: {\n      ownerKey: `luqui10:${agentKey}`,\n      ownerLabel: agentNick,\n      actorAlias: agentNick,\n      actorPhone\n    },\n    sourceContext: {\n      ctwaClid: body.ReferralCtwaClid || null,\n      referralSourceId: body.ReferralSourceId || null,\n      referralSourceUrl: body.ReferralSourceUrl || null,\n      referralHeadline: body.ReferralHeadline || null,\n      referralBody: body.ReferralBody || null,\n      referralSourceType: body.ReferralSourceType || null,\n      waId: body.WaId || null,\n      messageSid: body.MessageSid || null,\n      accountSid: body.AccountSid || null,\n      profileName: body.ProfileName || null,\n      receivedAt: new Date().toISOString()\n    }\n  };\n})()) }}"
}
```

## QA esperado

1. Landing genera mensaje tipo `Hola quiero mi usuario suertudo del Rey Dorado`.
2. WhatsApp entra por `RLS`.
3. `Switch2[first]` ejecuta `API WhatsApp Intake Captura`.
4. `/whatsapp/intake` reclama `landing_sessions` si el texto matchea una sesion pendiente.
5. Supabase:
   - `landing_sessions.status = claimed`
   - `owner_client_events.event_type = intake`
   - `owner_client_events.payload` conserva `Referral*`, CTWA, `WaId`, `MessageSid`, `AccountSid`, `ProfileName`, `ReceivedAt`
   - `meta_conversion_outbox.event_stage = landing_lead` cuando hay match landing
6. Ramas posteriores (`yes/no/other`) solo envian metadata de mensaje basica y no inventan `Referral*`.
