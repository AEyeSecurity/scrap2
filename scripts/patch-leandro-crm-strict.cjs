const fs = require('node:fs')

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/patch-leandro-crm-strict.cjs <input-json> <output-json>')
}

const exported = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const workflow = Array.isArray(exported) ? exported[0] : exported
if (!workflow || workflow.name !== 'Leandro' || workflow.active !== true) {
  throw new Error('Expected the active Leandro workflow')
}

const originalSelector = workflow.nodes.find((node) => node.name === 'Select Central Destination')
const register = workflow.nodes.find((node) => node.name === 'CRM Central Route Register')
const resolver = workflow.nodes.find((node) => node.name === 'CRM Central Route Resolve')
const resolved = workflow.nodes.find((node) => node.name === 'Resolve Central Destination')
const missing = workflow.nodes.find((node) => node.name === 'Central Route Missing?')
const prepareData = workflow.nodes.find((node) => node.name === 'Prepare Data1')
const prepareVcard = workflow.nodes.find((node) => node.name === 'Prepare vCard Media')

if (!originalSelector || !register || !resolver || !resolved || !missing || !prepareData || !prepareVcard) {
  throw new Error('The current central routing shape is incomplete')
}

const selectorBefore = originalSelector.parameters.jsCode
for (const node of [register, resolver]) {
  node.retryOnFail = true
  node.maxTries = 3
  node.waitBetweenTries = 1000
  delete node.onError
  delete node.alwaysOutputData
}

resolved.parameters.jsCode = `const input = $input.first().json || {};
const route = input.routeContext && input.routeContext.actorPhone ? input.routeContext : null;
let original = {};
try { original = $('Rate-limit').item.json || {}; } catch (error) {}
if (!route) {
  return [{ json: { ...original, centralRouteMissing: true } }];
}
const phone = String(route.actorPhone).replace(/\\D/g, '');
return [{ json: {
  ...original,
  routingKey: input.routingKey,
  agentPhone: phone,
  agentNick: route.actorAlias || phone,
  routeContext: { actorAlias: route.actorAlias || phone, actorPhone: \`+\${phone}\` },
  centralRouteMissing: false
} }];`

missing.parameters.conditions.conditions[0].leftValue = '={{ $json.centralRouteMissing }}'
workflow.connections['CRM Central Route Register'] = {
  main: [[{ node: 'HTTP Request14', type: 'main', index: 0 }]]
}
workflow.connections['Central Route Missing?'] = {
  main: [[], [{ node: 'Prepare vCard Media', type: 'main', index: 0 }]]
}

const removedNames = new Set(['Central Selection Is Fallback?', 'Restore Central Destination'])
workflow.nodes = workflow.nodes.filter((node) => !removedNames.has(node.name))
for (const name of removedNames) {
  delete workflow.connections[name]
}

if (originalSelector.parameters.jsCode !== selectorBefore) {
  throw new Error('Destination selector changed unexpectedly')
}
for (const expected of [
  "{ phone: '5491154816740', weight: 0.33, nick: 'Leandro', routingKey: 'lear' }",
  "{ phone: '5493516549344', weight: 0.33, nick: 'Lucas10', routingKey: 'luqui10' }",
  "{ phone: '5493562591982', weight: 0.34, nick: 'Leandro Rey', routingKey: 'caro' }"
]) {
  if (!selectorBefore.includes(expected)) throw new Error(`Current destination missing: ${expected}`)
}

const nodeNames = new Set(workflow.nodes.map((node) => node.name))
const serialized = JSON.stringify(workflow)
for (const match of serialized.matchAll(/\$\('([^']+)'\)/g)) {
  if (!nodeNames.has(match[1])) throw new Error(`Expression references missing node: ${match[1]}`)
}
if (!JSON.stringify(prepareData.parameters).includes("$('Prepare vCard Media')")) {
  throw new Error('Prepare Data1 no longer references Prepare vCard Media')
}
if (serialized.includes('needsRouteFallback') || serialized.includes('crmFallbackRecorded')) {
  throw new Error('A central route fallback remains')
}
if (register.onError || resolver.onError || register.alwaysOutputData || resolver.alwaysOutputData) {
  throw new Error('CRM HTTP nodes still permit regular output after errors')
}

fs.writeFileSync(outputPath, `${JSON.stringify([workflow], null, 2)}\n`)
