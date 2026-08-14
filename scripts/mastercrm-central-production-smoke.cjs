const { createClient } = require('@supabase/supabase-js')

const apiBase = process.env.MASTERCRM_BACKEND_URL || 'http://127.0.0.1:3000'
const staffPassword = process.env.MASTERCRM_STAFF_LINK_PASSWORD
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!staffPassword || !supabaseUrl || !supabaseKey) {
  throw new Error('MASTERCRM_STAFF_LINK_PASSWORD, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const stamp = Date.now()
const prefix = `qa_dualcrm_${stamp}`
const username = prefix
const password = `Qa-${stamp}-Secret!`
const phones = [`+5491198${String(stamp).slice(-6)}01`, `+5491198${String(stamp).slice(-6)}02`, `+5491198${String(stamp).slice(-6)}03`]
const channel = `whatsapp:+5491197${String(stamp).slice(-6)}`
const messageSids = [`QA_DUALCRM_${stamp}_01`, `QA_DUALCRM_${stamp}_02`, `QA_DUALCRM_${stamp}_03`]
const ownerKeys = { RdA: `${prefix}_rda`, ASN: `${prefix}_asn` }
const created = { userId: null, ownerIds: [], clientIds: [], contactIds: [], eventIds: [], routeIds: [], pairIds: [] }

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function api(path, payload, token = '') {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  return { status: response.status, body }
}

async function mustQuery(query, label) {
  const { data, error } = await query
  if (error) throw new Error(`${label}: ${error.code || 'unknown'} ${error.message}`)
  return data
}

async function captureCreatedIds() {
  if (created.userId) {
    const contacts = await mustQuery(
      supabase.from('mastercrm_portfolio_contacts').select('id').eq('mastercrm_user_id', created.userId),
      'capture contacts',
    )
    created.contactIds = contacts.map((row) => row.id)
    const events = await mustQuery(
      supabase.from('mastercrm_portfolio_contact_events').select('id').eq('mastercrm_user_id', created.userId),
      'capture events',
    )
    created.eventIds = events.map((row) => row.id)
    const routes = await mustQuery(
      supabase.from('mastercrm_portfolio_routes').select('id').eq('mastercrm_user_id', created.userId),
      'capture routes',
    )
    created.routeIds = routes.map((row) => row.id)
  }
  if (created.ownerIds.length) {
    const clients = await mustQuery(
      supabase.from('owner_client_links').select('client_id').in('owner_id', created.ownerIds),
      'capture clients',
    )
    created.clientIds = [...new Set(clients.map((row) => row.client_id))]
    const pairs = await mustQuery(
      supabase.from('mastercrm_platform_owner_pairs').select('id').or(
        `rda_owner_id.in.(${created.ownerIds.join(',')}),asn_owner_id.in.(${created.ownerIds.join(',')})`,
      ),
      'capture pairs',
    )
    created.pairIds = pairs.map((row) => row.id)
  }
}

async function cleanup() {
  await captureCreatedIds().catch(() => {})
  if (created.userId) await supabase.from('mastercrm_users').delete().eq('id', created.userId)
  if (created.pairIds.length) await supabase.from('mastercrm_platform_owner_pairs').delete().in('id', created.pairIds)
  if (created.ownerIds.length) await supabase.from('owners').delete().in('id', created.ownerIds)
  if (created.clientIds.length) await supabase.from('clients').delete().in('id', created.clientIds)
}

async function verifyCleanup() {
  const checks = await Promise.all([
    mustQuery(supabase.from('mastercrm_users').select('id').eq('username', username), 'verify users'),
    mustQuery(supabase.from('owners').select('id').in('owner_key', Object.values(ownerKeys)), 'verify owners'),
    mustQuery(supabase.from('clients').select('id').in('phone_e164', phones), 'verify clients'),
    mustQuery(supabase.from('mastercrm_portfolio_routes').select('id').in('phone_e164', phones), 'verify routes'),
    mustQuery(supabase.from('mastercrm_portfolio_contact_events').select('id').in('message_sid', messageSids), 'verify events'),
  ])
  assert(checks.every((rows) => rows.length === 0), 'QA cleanup left rows behind')
}

async function main() {
  let token = ''
  try {
    const owners = await mustQuery(
      supabase.from('owners').insert([
        { pagina: 'RdA', owner_key: ownerKeys.RdA, owner_label: `${prefix} RdA` },
        { pagina: 'ASN', owner_key: ownerKeys.ASN, owner_label: `${prefix} ASN` },
      ]).select('id, pagina, owner_key'),
      'create owners',
    )
    created.ownerIds = owners.map((owner) => owner.id)

    const register = await api('/mastercrm-register', {
      username,
      password,
      nombre: prefix,
      telefono: phones[0],
      staff_password: staffPassword,
    })
    assert(register.status === 201, `register failed: ${register.status} ${JSON.stringify(register.body)}`)
    created.userId = register.body.id
    assert(register.body.routingKey === username, 'register did not return immutable routingKey')

    const login = await api('/mastercrm-login', { username, password })
    assert(login.status === 200 && login.body.access_token, 'login failed')
    token = login.body.access_token

    const neutral = await api('/whatsapp/intake', {
      routingKey: username,
      telefono: phones[0],
      body: { To: channel, MessageSid: messageSids[0], From: `whatsapp:${phones[0]}` },
      routeContext: { actorAlias: 'QA First Route', actorPhone: '+5491100000101' },
    })
    assert(neutral.status === 200 && neutral.body.linkedPlatforms.length === 0, 'neutral intake failed')
    assert(Boolean(neutral.body.configurationWarning), 'neutral intake did not warn about missing panels')

    const retry = await api('/whatsapp/intake', {
      routingKey: username,
      telefono: phones[0],
      body: { To: channel, MessageSid: messageSids[0], From: `whatsapp:${phones[0]}` },
      routeContext: { actorAlias: 'QA Must Not Replace', actorPhone: '+5491100000999' },
    })
    assert(retry.status === 200, 'idempotent retry failed')
    assert(retry.body.routeContext.actorPhone === '+5491100000101', 'idempotent retry replaced the original route')

    const resolve = await api('/whatsapp/intake', {
      telefono: phones[0],
      body: { To: channel, MessageSid: `${messageSids[0]}_REPLY`, From: `whatsapp:${phones[0]}` },
    })
    assert(resolve.status === 200 && resolve.body.routeContext.actorPhone === '+5491100000101', 'route resolution failed')

    const rdaLink = await api('/mastercrm-link-cashier', {
      user_id: created.userId,
      owner_key: ownerKeys.RdA,
      pagina: 'RdA',
      staff_password: staffPassword,
    }, token)
    assert(rdaLink.status === 201, `RdA link failed: ${rdaLink.status}`)

    const singlePanel = await api('/whatsapp/intake', {
      routingKey: username,
      telefono: phones[1],
      body: { To: channel, MessageSid: messageSids[1], From: `whatsapp:${phones[1]}` },
      routeContext: { actorAlias: 'QA RdA', actorPhone: '+5491100000102' },
    })
    assert(singlePanel.status === 200 && singlePanel.body.linkedPlatforms.join(',') === 'RdA', 'single-panel intake failed')
    assert(singlePanel.body.platformIntake?.pagina === 'RdA', 'single-panel intake did not create RdA pending lead')

    const asnLink = await api('/mastercrm-link-cashier', {
      user_id: created.userId,
      owner_key: ownerKeys.ASN,
      pagina: 'ASN',
      staff_password: staffPassword,
    }, token)
    assert(asnLink.status === 201, `ASN link failed: ${asnLink.status}`)
    assert(asnLink.body.linkedOwners?.length === 2, 'second platform did not preserve both links')

    const dualPanel = await api('/whatsapp/intake', {
      routingKey: username,
      telefono: phones[2],
      body: { To: channel, MessageSid: messageSids[2], From: `whatsapp:${phones[2]}` },
      routeContext: { actorAlias: 'QA Dual', actorPhone: '+5491100000103' },
    })
    assert(dualPanel.status === 200 && dualPanel.body.linkedPlatforms.length === 2, 'dual-panel intake failed')
    assert(!dualPanel.body.platformIntake, 'dual-panel intake must remain neutral until platform identity is known')

    const all = await api('/mastercrm-clients', { user_id: created.userId, platform: 'all' }, token)
    const onlyAsn = await api('/mastercrm-clients', { user_id: created.userId, platform: 'ASN' }, token)
    const onlyRda = await api('/mastercrm-clients', { user_id: created.userId, platform: 'RdA' }, token)
    assert(all.status === 200 && all.body.routingKey === username, 'combined dashboard failed')
    assert(all.body.linkedOwners?.length === 2, 'combined dashboard did not return both owners')
    assert((all.body.clientes || []).some((client) => client.telefono === phones[0] && client.isNeutral), 'neutral contact missing from all filter')
    assert(onlyAsn.status === 200 && !(onlyAsn.body.clientes || []).some((client) => client.telefono === phones[0]), 'neutral contact leaked into ASN filter')
    assert(onlyRda.status === 200 && !(onlyRda.body.clientes || []).some((client) => client.telefono === phones[0]), 'neutral contact leaked into RdA filter')

    const unlink = await api('/mastercrm-unlink-cashier', {
      user_id: created.userId,
      pagina: 'ASN',
      staff_password: staffPassword,
    }, token)
    assert(unlink.status === 200, `ASN unlink failed: ${unlink.status}`)

    await captureCreatedIds()
    const duplicateEvents = await mustQuery(
      supabase.from('mastercrm_portfolio_contact_events').select('id').eq('message_sid', messageSids[0]),
      'verify MessageSid idempotency',
    )
    assert(duplicateEvents.length === 1, 'duplicate MessageSid created duplicate events')

    console.log(JSON.stringify({ ok: true, prefix, created, assertions: 22 }, null, 2))
  } finally {
    await cleanup()
    await verifyCleanup()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, prefix, created, message: error.message }, null, 2))
  process.exit(1)
})
