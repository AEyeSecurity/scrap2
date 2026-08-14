const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const backupDir = process.argv[2]
const outputDir = process.argv[3]
if (!backupDir || !outputDir) {
  throw new Error('Usage: node scripts/build-valerio-central-workflows.cjs <backup-dir> <output-dir>')
}

fs.mkdirSync(outputDir, { recursive: true })

const specs = [
  {
    input: 'valerio-s1.json',
    output: 'valerio-s1-central.json',
    qaOutput: 'valerio-s1-central-qa.json',
    webhook: 'VS1',
    consumption: 'PubliValerioS1',
    agents: [
      { phone: '5493517362710', weight: 0.33, nick: 'Franco', routingKey: 'valerio' },
      { phone: '5493562669092', weight: 0.33, nick: 'Franco', routingKey: 'valerio' },
      { phone: '5493517363354', weight: 0.33, nick: 'Franco', routingKey: 'valerio' },
    ],
  },
  {
    input: 'valerio-alta-fortuna.json',
    output: 'valerio-alta-fortuna-central.json',
    qaOutput: 'valerio-alta-fortuna-central-qa.json',
    webhook: 'AFSU',
    consumption: 'PubliValerioAltaFortuna',
    agents: [
      { phone: '5493516828851', weight: 0.33, nick: 'Julio', routingKey: 'valerio' },
      { phone: '5493517363879', weight: 0.33, nick: 'Mari', routingKey: 'valerio' },
      { phone: '5493517363646', weight: 0.33, nick: 'Mari', routingKey: 'valerio' },
    ],
  },
]

function asWorkflow(value) {
  return Array.isArray(value) ? value[0] : value
}

function connection(node) {
  return { node, type: 'main', index: 0 }
}

function selectionCode(agents, includeInputExpression) {
  return `const agents = ${JSON.stringify(agents, null, 2)};
const totalWeight = agents.reduce((sum, agent) => sum + (agent.weight ?? 1), 0) || agents.length;
let cursor = Math.random() * totalWeight;
let chosen = agents[0];
for (const agent of agents) {
  cursor -= agent.weight ?? 1;
  if (cursor <= 0) { chosen = agent; break; }
}
${includeInputExpression}
return [{ json: {
  ...input,
  routingKey: chosen.routingKey,
  agentPhone: chosen.phone,
  agentNick: chosen.nick,
  routeContext: { actorAlias: chosen.nick, actorPhone: \`+\${chosen.phone.replace(/\\D/g, '')}\` }
} }];`
}

function centralPayloadExpression(webhook, sourceNode, resolverOnly = false) {
  return `={{ JSON.stringify((() => {
  const body = $('${webhook}').first().json.body || {};
  const digits = (value) => String(value ?? '').replace(/\\D/g, '');
  const e164 = (value) => { const valueDigits = digits(value); return valueDigits ? \`+\${valueDigits}\` : null; };
  const base = {
    telefono: e164(body.WaId || body.From),
    body,
    sourceContext: {
      waId: body.WaId || null,
      messageSid: body.MessageSid || null,
      accountSid: body.AccountSid || null,
      profileName: body.ProfileName || null,
      receivedAt: new Date().toISOString()
    }
  };
  ${resolverOnly ? 'return base;' : `return {
    ...base,
    routingKey: $('${sourceNode}').item.json.routingKey,
    routeContext: $('${sourceNode}').item.json.routeContext
  };`}
})()) }}`
}

function httpNode(name, position, jsonBody) {
  return {
    parameters: {
      method: 'POST',
      url: 'http://127.0.0.1:3000/whatsapp/intake',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody,
      options: {},
    },
    id: randomUUID(),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 1000,
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
  }
}

function transform(spec) {
  const parsed = JSON.parse(fs.readFileSync(path.join(backupDir, spec.input), 'utf8'))
  const workflow = asWorkflow(parsed)
  const assignNode = workflow.nodes.find((node) => node.name === 'Assign Agent %1')
  const consumoNode = workflow.nodes.find((node) => node.name === 'Consumo')
  if (!assignNode || !consumoNode) throw new Error(`Unexpected workflow shape: ${workflow.name}`)

  consumoNode.parameters.workflowInputs.value.WorkflowName = spec.consumption

  const selectName = 'Select Central Destination'
  const initialIntakeName = 'CRM Central Intake Initial'
  const resolverName = 'CRM Central Route Resolve'
  const resolvedName = 'Resolve Central Destination'
  const missingName = 'Central Route Missing?'
  const fallbackIntakeName = 'CRM Central Route Fallback Intake'
  const restoreName = 'Restore Central Destination'

  workflow.nodes.push({
    parameters: {
      jsCode: selectionCode(spec.agents, "const input = $input.first().json;"),
    },
    id: randomUUID(),
    name: selectName,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [-40, 256],
  })
  workflow.nodes.push(httpNode(initialIntakeName, [176, 256], centralPayloadExpression(spec.webhook, selectName)))
  workflow.nodes.push(httpNode(resolverName, [176, 496], centralPayloadExpression(spec.webhook, '', true)))

  assignNode.name = resolvedName
  assignNode.position = [416, 496]
  assignNode.parameters.jsCode = `const agents = ${JSON.stringify(spec.agents, null, 2)};
const input = $input.first().json || {};
const route = input.routeContext && input.routeContext.actorPhone ? input.routeContext : null;
let chosen;
if (route) {
  const phone = String(route.actorPhone).replace(/\\D/g, '');
  chosen = { phone, nick: route.actorAlias || phone, routingKey: input.routingKey || 'valerio' };
} else {
  const totalWeight = agents.reduce((sum, agent) => sum + (agent.weight ?? 1), 0) || agents.length;
  let cursor = Math.random() * totalWeight;
  chosen = agents[0];
  for (const agent of agents) {
    cursor -= agent.weight ?? 1;
    if (cursor <= 0) { chosen = agent; break; }
  }
}
let original = {};
try { original = $('Rate-limit1').item.json || {}; } catch (error) {}
return [{ json: {
  ...original,
  routingKey: chosen.routingKey || 'valerio',
  agentPhone: chosen.phone,
  agentNick: chosen.nick,
  routeContext: { actorAlias: chosen.nick, actorPhone: \`+\${String(chosen.phone).replace(/\\D/g, '')}\` },
  needsRouteFallback: !route
} }];`

  workflow.nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: randomUUID(),
          leftValue: '={{ $json.needsRouteFallback }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    },
    id: randomUUID(),
    name: missingName,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [632, 496],
  })
  workflow.nodes.push(httpNode(fallbackIntakeName, [848, 432], centralPayloadExpression(spec.webhook, resolvedName)))
  workflow.nodes.push({
    parameters: {
      jsCode: `return [{ json: { ...$('${resolvedName}').item.json, crmFallbackRecorded: !$json.error } }];`,
    },
    id: randomUUID(),
    name: restoreName,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1064, 432],
  })

  workflow.connections.Switch2.main[0] = [connection(selectName)]
  workflow.connections[selectName] = { main: [[connection(initialIntakeName)]] }
  workflow.connections[initialIntakeName] = { main: [[connection('HTTP Request')]] }
  workflow.connections['Rate-limit1'] = { main: [[connection(resolverName)]] }
  workflow.connections[resolverName] = { main: [[connection(resolvedName)]] }
  workflow.connections[resolvedName] = { main: [[connection(missingName)]] }
  workflow.connections[missingName] = {
    main: [[connection(fallbackIntakeName)], [connection('Prepare vCard Media')]],
  }
  workflow.connections[fallbackIntakeName] = { main: [[connection(restoreName)]] }
  workflow.connections[restoreName] = { main: [[connection('Prepare vCard Media')]] }
  delete workflow.connections['Assign Agent %1']

  return parsed
}

for (const spec of specs) {
  const transformed = transform(spec)
  fs.writeFileSync(path.join(outputDir, spec.output), `${JSON.stringify(transformed, null, 2)}\n`)

  const qa = JSON.parse(JSON.stringify(transformed))
  const qaWorkflow = asWorkflow(qa)
  qaWorkflow.id = randomUUID()
  qaWorkflow.name = `QA Dual CRM - ${qaWorkflow.name}`
  qaWorkflow.active = false
  qaWorkflow.isArchived = false
  qaWorkflow.versionId = randomUUID()
  qaWorkflow.versionCounter = 1
  qaWorkflow.triggerCount = 0
  qaWorkflow.createdAt = new Date().toISOString()
  qaWorkflow.updatedAt = qaWorkflow.createdAt
  delete qaWorkflow.shared
  fs.writeFileSync(path.join(outputDir, spec.qaOutput), `${JSON.stringify(qa, null, 2)}\n`)
}
