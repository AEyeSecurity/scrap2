const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright');

const backendCwd = 'C:/Guiga/CIT/Master CRM RL/scrap2';
const frontendCwd = 'C:/Guiga/CIT/Master CRM RL/mastercrmrl/client-admin-portal';
const backendUrl = process.env.MASTERCRM_BACKEND_URL || 'http://127.0.0.1:3000';
const frontendUrl = process.env.MASTERCRM_FRONTEND_URL || 'http://127.0.0.1:5173';
const staffPassword = process.env.MASTERCRM_STAFF_LINK_PASSWORD;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey || !staffPassword) {
  throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and MASTERCRM_STAFF_LINK_PASSWORD are required');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
});

const username = `codexe2e${Date.now()}`;
const password = 'Secret123!';
const nombre = 'Codex Smoke';
const telefono = '+5491112345680';
const ownerWithReport = 'asnlucas10:lucas10';
const ownerWithoutReport = 'asnlucas10:vicky';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, expectedStatuses = [200, 204, 400, 404, 405], timeoutMs = 60000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (expectedStatuses.includes(response.status)) {
        return;
      }
    } catch {}

    await sleep(1000);
  }

  throw new Error(`Timeout waiting for ${url}`);
}

function spawnProcess(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr
  };
}

async function apiJson(path, payload) {
  const response = await fetch(`${backendUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();

  return {
    status: response.status,
    json: text ? JSON.parse(text) : null
  };
}

async function cleanupUser(userId) {
  await supabase.from('mastercrm_user_owner_links').delete().eq('mastercrm_user_id', userId);
  await supabase.from('mastercrm_users').delete().eq('id', userId);
}

function normalizeOwnerRelation(value) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

async function main() {
  const backend = spawnProcess('npm.cmd', ['start', '--', 'server'], backendCwd, {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: supabaseServiceKey,
    MASTERCRM_STAFF_LINK_PASSWORD: staffPassword
  });
  const frontend = spawnProcess('npm.cmd', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'], frontendCwd, {
    VITE_API_BASE_URL: backendUrl
  });

  let browser = null;
  let userId = null;

  try {
    await waitForHttp(`${backendUrl}/mastercrm-login`);
    await waitForHttp(frontendUrl, [200]);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(frontendUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Registrarse' }).click();
    await page.getByLabel('Nombre de usuario').fill(username);
    await page.getByLabel('Contrasena').fill(password);
    await page.getByLabel('Nombre completo').fill(nombre);
    await page.getByLabel('Telefono').fill(telefono);
    await page.getByRole('button', { name: 'Crear usuario' }).click();
    await page.getByText('Usuario creado correctamente. Inicia sesion con tus nuevas credenciales.').waitFor({
      timeout: 15000
    });

    await page.getByLabel('Contrasena').fill(password);
    await page.getByRole('button', { name: 'Entrar al panel' }).click();
    await page.getByText('Sin cajero vinculado').waitFor({ timeout: 15000 });

    const loginResult = await apiJson('/mastercrm-login', {
      usuario: username,
      contrasena: password
    });
    assert(loginResult.status === 200, 'Backend login failed after UI registration');
    userId = loginResult.json.id;

    const initialClients = await apiJson('/mastercrm-clients', { user_id: userId });
    assert(initialClients.status === 200, 'Initial clients request failed');
    assert(initialClients.json.linkedOwner === null, 'User should start without linked owner');
    assert(initialClients.json.summary === null, 'User without owner should have null summary');
    assert(Array.isArray(initialClients.json.clientes) && initialClients.json.clientes.length === 0, 'User without owner should have no clients');

    await page.getByRole('button', { name: 'Conectar con cajero' }).click();
    await page.locator('#cashier-access-password').fill(staffPassword);
    await page.locator('#cashier-owner-key').fill(ownerWithReport);
    await page.getByRole('button', { name: 'Vincular cajero' }).click();
    await page.getByText('Cajero vinculado correctamente.').waitFor({ timeout: 15000 });
    await page.getByText('Lucas10').waitFor({ timeout: 15000 });

    const firstClients = await apiJson('/mastercrm-clients', { user_id: userId });
    assert(firstClients.status === 200, 'Clients request after first link failed');
    assert(firstClients.json.linkedOwner?.ownerKey === ownerWithReport, 'Linked owner after first link is wrong');
    assert(firstClients.json.summary?.hasReport === true, 'Expected report data for Lucas10');
    assert((firstClients.json.summary?.totalClients ?? 0) > 0, 'Expected roster for Lucas10');
    assert((firstClients.json.clientes ?? []).length > 0, 'Expected clients for Lucas10');
    assert((firstClients.json.summary?.cargadoHoyTotal ?? 0) > 0, 'Expected non-zero daily total for Lucas10');

    const firstLinkCount = await supabase
      .from('mastercrm_user_owner_links')
      .select('id', { count: 'exact', head: true })
      .eq('mastercrm_user_id', userId);
    assert(firstLinkCount.count === 1, 'Expected exactly one owner link after first link');

    await page.getByRole('button', { name: 'Actualizar cajero' }).click();
    await page.locator('#cashier-access-password').fill(staffPassword);
    await page.locator('#cashier-owner-key').fill(ownerWithoutReport);
    await page.getByRole('button', { name: 'Vincular cajero' }).click();
    await page.getByText('Cajero vinculado correctamente.').waitFor({ timeout: 15000 });
    await page.getByText('Vicky').waitFor({ timeout: 15000 });
    await page.getByText('Sin reporte').first().waitFor({ timeout: 15000 });

    const secondClients = await apiJson('/mastercrm-clients', { user_id: userId });
    assert(secondClients.status === 200, 'Clients request after relink failed');
    assert(secondClients.json.linkedOwner?.ownerKey === ownerWithoutReport, 'Linked owner after relink is wrong');
    assert(secondClients.json.summary?.hasReport === false, 'Expected no report data for Vicky');
    assert(secondClients.json.summary?.reportDate === null, 'Expected null report date for Vicky');
    assert((secondClients.json.summary?.totalClients ?? 0) > 0, 'Expected roster for Vicky');
    assert((secondClients.json.clientes ?? []).length > 0, 'Expected clients for Vicky');

    const secondLinkRows = await supabase
      .from('mastercrm_user_owner_links')
      .select('owner_id, owners!inner(owner_key)')
      .eq('mastercrm_user_id', userId);
    assert(!secondLinkRows.error, `Link row query failed: ${secondLinkRows.error?.message}`);
    assert((secondLinkRows.data ?? []).length === 1, 'Expected exactly one owner link row after relink');
    assert(normalizeOwnerRelation(secondLinkRows.data[0].owners)?.owner_key === ownerWithoutReport, 'Expected stored owner key to match relinked owner');

    const ownerRows = await supabase
      .from('owners')
      .select('id, owner_key')
      .in('owner_key', [ownerWithReport, ownerWithoutReport])
      .order('owner_key');
    assert(!ownerRows.error, `Owner query failed: ${ownerRows.error?.message}`);
    const ownerMap = new Map((ownerRows.data ?? []).map((row) => [row.owner_key, row.id]));

    const duplicateAttempt = await supabase.from('mastercrm_user_owner_links').insert([
      { mastercrm_user_id: userId, owner_id: ownerMap.get(ownerWithReport) },
      { mastercrm_user_id: userId, owner_id: ownerMap.get(ownerWithoutReport) }
    ]);
    assert(duplicateAttempt.error, 'Expected duplicate owner-link insert to fail under single-owner constraint');

    console.log(
      JSON.stringify(
        {
          ok: true,
          userId,
          username,
          firstLinkedOwner: firstClients.json.linkedOwner,
          firstSummary: firstClients.json.summary,
          secondLinkedOwner: secondClients.json.linkedOwner,
          secondSummary: secondClients.json.summary,
          duplicateInsertCode: duplicateAttempt.error.code ?? null
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          message: error.message,
          backendStdout: backend.getStdout().slice(-4000),
          backendStderr: backend.getStderr().slice(-4000),
          frontendStdout: frontend.getStdout().slice(-4000),
          frontendStderr: frontend.getStderr().slice(-4000)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }

    if (userId) {
      await cleanupUser(userId).catch(() => {});
    }

    backend.child.kill('SIGTERM');
    frontend.child.kill('SIGTERM');
    await sleep(1500);
    if (!backend.child.killed) {
      backend.child.kill('SIGKILL');
    }
    if (!frontend.child.killed) {
      frontend.child.kill('SIGKILL');
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }, null, 2));
  process.exit(1);
});
