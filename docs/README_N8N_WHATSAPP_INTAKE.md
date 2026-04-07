# n8n WhatsApp Intake

Este flujo reemplaza Google Sheets como memoria del Master CRM sin crear tablas nuevas: el primer contacto se guarda directo en el modelo CAPI existente (`clients`, `owner_client_links`, `owner_client_events`).

## Endpoint backend

Usar:

```text
POST http://127.0.0.1:3000/whatsapp/intake
```

El endpoint persiste el cliente pendiente usando la misma logica de `POST /users/intake-pending`.

- Con `ownerContext`: persiste el intake y deja los datos CTWA conectados a CAPI.
- Sin `ownerContext`: intenta resolver el owner ya persistido para ese `pagina + telefono`; sirve para la rama `SI, quiero mas info`.

## Nodos a sacar

Sacar del flujo de Master CRM:

- `Datos AD1`
- `CRM Ad`
- `Edit Fields1`
- `CRM Ad1`
- `Toma datos AD`

Mantener por ahora:

- `Guillote Sheet´s`
- `Guillote Sheet´s1`
- `Prepare Data`
- `Prepare Data1`

## Conexiones

- `Guillote Sheet´s` ya no debe ir a `Datos AD1`.
- En la salida `first` de `Switch2`, poner `Asignar agente intake` antes de `HTTP Request14`.
- `Asignar agente intake` debe conectar en paralelo a `API WhatsApp Intake Captura` y a `HTTP Request14`.
- En la salida `yes` de `Switch2`, reemplazar `Asignar agente sin link1` por `API WhatsApp Intake Resolver` -> `Set Agent From Intake` -> `Build vCard cajero`.
- No conectar esta rama a `HTTP Request15`; ese nodo corresponde a `/users/deposit`, no al intake.

## Nodo `Asignar agente intake`

Es una copia del asignador actual, pero se usa en la primera rama y no se conecta directo a vCard:

```json
{
  "parameters": {
    "jsCode": "const agents = [\n  { key: 'lucas10', Nick: 'Lucas10', phone: '5493516549344', weight: 0.6 },\n  { key: 'vicky', Nick: 'Vicky', phone: '5493516326134', weight: 0.4 },\n];\n\nconst totalWeight = agents.reduce((s, a) => s + (a.weight ?? 1), 0) || agents.length;\nlet r = Math.random() * totalWeight;\nlet chosen = agents[0];\n\nfor (const a of agents) {\n  r -= (a.weight ?? 1);\n  if (r <= 0) {\n    chosen = a;\n    break;\n  }\n}\n\nreturn [{\n  json: {\n    ...$json,\n    agentKey: chosen.key,\n    agentNick: chosen.Nick,\n    agentPhone: chosen.phone\n  }\n}];\n"
  },
  "type": "n8n-nodes-base.code",
  "typeVersion": 2,
  "position": [
    -1040,
    592
  ],
  "id": "asignar-agente-intake",
  "name": "Asignar agente intake"
}
```

## Nodo `API WhatsApp Intake Captura`

Importar o crear este nodo HTTP Request:

```json
{
  "parameters": {
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
    "jsonBody": "={{ JSON.stringify((() => {\n  const body = $('Edit Fields').item.json.body || $('Bot Lucas10').item.json.body || {};\n\n  const onlyDigits = (value) => String(value ?? '').replace(/\\D/g, '');\n  const asE164 = (value) => {\n    const digits = onlyDigits(value);\n    return digits ? `+${digits}` : null;\n  };\n\n  let pagina = 'ASN';\n  try {\n    pagina = String($('Get row(s)').first().json.Sede || pagina).trim() || pagina;\n  } catch (e) {}\n\n  const clientePhone = asE164(body.WaId || body.From);\n  const actorPhone = asE164($json.agentPhone);\n  const agentKey = String($json.agentKey || '').trim().toLowerCase();\n  const agentNick = String($json.agentNick || agentKey || 'Lucas10').trim();\n\n  return {\n    pagina,\n    telefono: clientePhone,\n    body,\n    ownerContext: {\n      ownerKey: `asnlucas10:${agentKey}`,\n      ownerLabel: agentNick,\n      actorAlias: agentNick,\n      actorPhone\n    },\n    sourceContext: {\n      ctwaClid: body.ReferralCtwaClid || null,\n      referralSourceId: body.ReferralSourceId || null,\n      referralSourceUrl: body.ReferralSourceUrl || null,\n      referralHeadline: body.ReferralHeadline || null,\n      referralBody: body.ReferralBody || null,\n      referralSourceType: body.ReferralSourceType || null,\n      waId: body.WaId || null,\n      messageSid: body.MessageSid || null,\n      accountSid: body.AccountSid || null,\n      profileName: body.ProfileName || null,\n      receivedAt: new Date().toISOString()\n    }\n  };\n})()) }}"
  },
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.2,
  "position": [
    -512,
    960
  ],
  "id": "api-whatsapp-intake-captura",
  "name": "API WhatsApp Intake Captura"
}
```

## Nodo `API WhatsApp Intake Resolver`

Este nodo va en la rama `yes`, antes de armar la vCard. No manda `ownerContext`; el backend lo resuelve desde el intake persistido en la primera rama.

```json
{
  "parameters": {
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
    "jsonBody": "={{ JSON.stringify((() => {\n  const body = $('Edit Fields').item.json.body || $('Bot Lucas10').item.json.body || {};\n  const onlyDigits = (value) => String(value ?? '').replace(/\\D/g, '');\n  const asE164 = (value) => {\n    const digits = onlyDigits(value);\n    return digits ? `+${digits}` : null;\n  };\n\n  let pagina = 'ASN';\n  try {\n    pagina = String($('Get row(s)').first().json.Sede || pagina).trim() || pagina;\n  } catch (e) {}\n\n  return {\n    pagina,\n    telefono: asE164(body.WaId || body.From),\n    body,\n    sourceContext: {\n      waId: body.WaId || null,\n      messageSid: body.MessageSid || null,\n      accountSid: body.AccountSid || null,\n      profileName: body.ProfileName || null,\n      receivedAt: new Date().toISOString()\n    }\n  };\n})()) }}"
  },
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.2,
  "position": [
    -800,
    768
  ],
  "id": "api-whatsapp-intake-resolver",
  "name": "API WhatsApp Intake Resolver"
}
```

## Nodo `Set Agent From Intake`

Este nodo transforma la respuesta del backend al formato que ya usa `Build vCard cajero`.

```json
{
  "parameters": {
    "assignments": {
      "assignments": [
        {
          "id": "agent-key-from-intake",
          "name": "agentKey",
          "value": "={{ String($json.ownerContext?.ownerKey || '').split(':').pop() }}",
          "type": "string"
        },
        {
          "id": "agent-nick-from-intake",
          "name": "agentNick",
          "value": "={{ $json.ownerContext?.actorAlias || $json.ownerContext?.ownerLabel }}",
          "type": "string"
        },
        {
          "id": "agent-phone-from-intake",
          "name": "agentPhone",
          "value": "={{ String($json.ownerContext?.actorPhone || '').replace(/\\D/g, '') }}",
          "type": "string"
        }
      ]
    },
    "options": {}
  },
  "type": "n8n-nodes-base.set",
  "typeVersion": 3.4,
  "position": [
    -640,
    768
  ],
  "id": "set-agent-from-intake",
  "name": "Set Agent From Intake"
}
```

## RdA

Si este mismo flujo se usa para RdA, el nodo debe enviar:

```json
{
  "pagina": "RdA",
  "ownerContext": {
    "ownerKey": "luqui10:luqui10",
    "ownerLabel": "luqui10"
  }
}
```

En el workflow actual, el default del nodo queda en `ASN` para mantener compatibilidad con Lucas10.
