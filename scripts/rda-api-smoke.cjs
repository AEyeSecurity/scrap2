const { spawn } = require('child_process');

const repoRoot = require('path').resolve(__dirname, '..');

function printUsage() {
  console.log(`RDA API smoke

Uso:
  node scripts/rda-api-smoke.cjs
  npm run smoke:rda-api

Variables requeridas:
  RDA_AGENTE=mi_agente
  RDA_CONTRASENA=mi_password
  RDA_USUARIO_TEST=usuario_existente

Variables opcionales:
  RDA_API_BASE_URL=http://127.0.0.1:3000
  RDA_ACTION=balance|deposit|create-player
  RDA_OPERACION=consultar_saldo|carga|descarga|descarga_total
  RDA_CANTIDAD=500
  RDA_NEW_USERNAME=usuario_nuevo
  RDA_NEW_PASSWORD=clave_nueva
  RDA_HEADLESS=true|false
  RDA_DEBUG=true|false
  RDA_SLOW_MO=0
  RDA_TIMEOUT_MS=15000
  RDA_POLL_MS=1500
  RDA_POLL_TIMEOUT_MS=120000
  RDA_SPAWN_SERVER=true|false

Ejemplos:
  $env:RDA_AGENTE="agent_user"
  $env:RDA_CONTRASENA="agent_pass"
  $env:RDA_USUARIO_TEST="player_1"
  npm run smoke:rda-api

  $env:RDA_OPERACION="carga"
  $env:RDA_CANTIDAD="500"
  npm run smoke:rda-api

  $env:RDA_ACTION="create-player"
  $env:RDA_NEW_USERNAME="codexrda123"
  $env:RDA_NEW_PASSWORD="Secret123!"
  npm run smoke:rda-api
`);
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

function parseNumber(name, value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number`);
  }

  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.status > 0) {
        return response.status;
      }
    } catch {}

    await sleep(1000);
  }

  throw new Error(`Timeout waiting for backend at ${url}`);
}

function spawnServer(envOverrides) {
  const child = spawn('npm.cmd', ['start', '--', 'server'], {
    cwd: repoRoot,
    env: { ...process.env, ...envOverrides },
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

async function apiJson(baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
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

async function fetchJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null
  };
}

function buildSmokeConfig(env) {
  const action = (env.RDA_ACTION || 'balance').trim().toLowerCase();
  const operation = (env.RDA_OPERACION || 'consultar_saldo').trim().toLowerCase();

  return {
    baseUrl: (env.RDA_API_BASE_URL || env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    action,
    operation,
    agente: env.RDA_AGENTE || env.AGENT_USERNAME,
    contrasena: env.RDA_CONTRASENA || env.AGENT_PASSWORD,
    usuario: env.RDA_USUARIO_TEST,
    newUsername: env.RDA_NEW_USERNAME,
    newPassword: env.RDA_NEW_PASSWORD,
    cantidad: parseNumber('RDA_CANTIDAD', env.RDA_CANTIDAD, undefined),
    headless: parseBoolean(env.RDA_HEADLESS, true),
    debug: parseBoolean(env.RDA_DEBUG, false),
    slowMo: parseNumber('RDA_SLOW_MO', env.RDA_SLOW_MO, 0),
    timeoutMs: parseNumber('RDA_TIMEOUT_MS', env.RDA_TIMEOUT_MS, 15000),
    pollMs: parseNumber('RDA_POLL_MS', env.RDA_POLL_MS, 1500),
    pollTimeoutMs: parseNumber('RDA_POLL_TIMEOUT_MS', env.RDA_POLL_TIMEOUT_MS, 120000),
    spawnServer: parseBoolean(env.RDA_SPAWN_SERVER, false)
  };
}

function validateConfig(config) {
  if (!['balance', 'deposit', 'create-player'].includes(config.action)) {
    throw new Error(`Unsupported RDA_ACTION: ${config.action}`);
  }

  if (!config.agente) {
    throw new Error('RDA_AGENTE or AGENT_USERNAME is required');
  }
  if (!config.contrasena) {
    throw new Error('RDA_CONTRASENA or AGENT_PASSWORD is required');
  }

  if (config.action === 'create-player') {
    if (!config.newUsername) {
      throw new Error('RDA_NEW_USERNAME is required when RDA_ACTION=create-player');
    }
    if (!config.newPassword) {
      throw new Error('RDA_NEW_PASSWORD is required when RDA_ACTION=create-player');
    }
    return;
  }

  if (!config.usuario) {
    throw new Error('RDA_USUARIO_TEST is required for balance/deposit smoke tests');
  }

  if (config.action === 'deposit') {
    if (!['carga', 'descarga', 'descarga_total', 'consultar_saldo'].includes(config.operation)) {
      throw new Error(`Unsupported RDA_OPERACION for deposit smoke: ${config.operation}`);
    }
    if ((config.operation === 'carga' || config.operation === 'descarga') && !(config.cantidad > 0)) {
      throw new Error('RDA_CANTIDAD must be > 0 for carga/descarga');
    }
  }
}

function buildRequestPayload(config) {
  if (config.action === 'create-player') {
    return {
      endpoint: '/users/create-player',
      payload: {
        pagina: 'RdA',
        loginUsername: config.agente,
        loginPassword: config.contrasena,
        newUsername: config.newUsername,
        newPassword: config.newPassword,
        headless: config.headless,
        debug: config.debug,
        slowMo: config.slowMo,
        timeoutMs: config.timeoutMs
      }
    };
  }

  const operation = config.action === 'balance' ? 'consultar_saldo' : config.operation;
  return {
    endpoint: '/users/deposit',
    payload: {
      pagina: 'RdA',
      operacion: operation,
      usuario: config.usuario,
      agente: config.agente,
      contrasena_agente: config.contrasena,
      ...(typeof config.cantidad === 'number' ? { cantidad: config.cantidad } : {}),
      headless: config.headless,
      debug: config.debug,
      slowMo: config.slowMo,
      timeoutMs: config.timeoutMs
    }
  };
}

async function waitForJob(baseUrl, jobId, pollMs, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchJson(baseUrl, `/jobs/${jobId}`);
    if (response.status === 200 && response.json) {
      const status = response.json.status;
      if (['succeeded', 'failed', 'expired'].includes(status)) {
        return response.json;
      }
    }

    await sleep(pollMs);
  }

  throw new Error(`Timeout waiting for job ${jobId}`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  const config = buildSmokeConfig(process.env);
  validateConfig(config);

  let backend = null;

  try {
    if (config.spawnServer) {
      backend = spawnServer({});
    }

    await waitForHttp(`${config.baseUrl}/jobs/health-check-smoke`, 60000);

    const request = buildRequestPayload(config);
    const enqueue = await apiJson(config.baseUrl, request.endpoint, request.payload);

    if (enqueue.status !== 202 || !enqueue.json?.jobId) {
      throw new Error(
        `Unexpected enqueue response (${enqueue.status}): ${JSON.stringify(enqueue.json, null, 2)}`
      );
    }

    const job = await waitForJob(config.baseUrl, enqueue.json.jobId, config.pollMs, config.pollTimeoutMs);
    const output = {
      ok: job.status === 'succeeded',
      action: config.action,
      operation: config.action === 'create-player' ? 'create-player' : request.payload.operacion,
      endpoint: request.endpoint,
      jobId: enqueue.json.jobId,
      status: job.status,
      result: job.result ?? null,
      error: job.error ?? null,
      steps: Array.isArray(job.steps)
        ? job.steps.map((step) => ({
            name: step.name,
            status: step.status,
            error: step.error ?? null
          }))
        : [],
      artifactPaths: Array.isArray(job.artifactPaths) ? job.artifactPaths : []
    };

    console.log(JSON.stringify(output, null, 2));

    if (job.status !== 'succeeded') {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          backendStdout: backend ? backend.getStdout().slice(-4000) : null,
          backendStderr: backend ? backend.getStderr().slice(-4000) : null
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    if (backend) {
      backend.child.kill('SIGTERM');
      await sleep(1500);
      if (!backend.child.killed) {
        backend.child.kill('SIGKILL');
      }
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
