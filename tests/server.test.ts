import { describe, expect, it } from 'vitest';
import { buildAppConfig } from '../src/config';
import { createLogger } from '../src/logging';
import { PlayerPhoneStoreError, type PlayerPhoneStore } from '../src/player-phone-store';
import { createServer } from '../src/server';
import type { JobRequest, JobStoreEntry } from '../src/types';

class FakeQueue {
  public readonly entries = new Map<string, JobStoreEntry>();
  public readonly requests: JobRequest[] = [];

  enqueue(request: JobRequest): string {
    this.requests.push(request);
    this.entries.set(request.id, {
      id: request.id,
      jobType: request.jobType,
      status: 'queued',
      createdAt: request.createdAt,
      artifactPaths: [],
      steps: []
    });
    return request.id;
  }

  getById(id: string): JobStoreEntry | undefined {
    return this.entries.get(id);
  }

  async shutdown(): Promise<void> {
    // no-op for tests
  }
}

class FakePlayerPhoneStore implements PlayerPhoneStore {
  public readonly syncInputs: Array<{
    pagina: 'RdA' | 'ASN';
    cajeroUsername: string;
    jugadorUsername: string;
    telefono?: string;
  }> = [];

  public readonly assignInputs: Array<{
    pagina: 'RdA' | 'ASN';
    cajeroUsername: string;
    jugadorUsername: string;
    telefono: string;
  }> = [];

  public assignBehavior: () => Promise<void> = async () => undefined;

  async syncCreatePlayerLink(input: {
    pagina: 'RdA' | 'ASN';
    cajeroUsername: string;
    jugadorUsername: string;
    telefono?: string;
  }): Promise<void> {
    this.syncInputs.push(input);
  }

  async assignPhone(input: {
    pagina: 'RdA' | 'ASN';
    cajeroUsername: string;
    jugadorUsername: string;
    telefono: string;
  }): Promise<void> {
    this.assignInputs.push(input);
    await this.assignBehavior();
  }
}

describe('server routes', () => {
  it('POST /login returns 202 with job id', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/login',
      payload: {
        username: 'user',
        password: 'pass'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');
    expect(body.jobId).toMatch(/[0-9a-f-]{36}/i);
    expect(body.statusUrl).toBe(`/jobs/${body.jobId}`);
    expect(queue.getById(body.jobId)?.jobType).toBe('login');

    await server.close();
  });

  it('POST /users/create-player returns 202 with job id', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        pagina: 'RdA',
        loginUsername: 'agent',
        loginPassword: 'secret',
        newUsername: 'player_1',
        newPassword: 'player_secret'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');
    expect(body.statusUrl).toBe(`/jobs/${body.jobId}`);
    expect(queue.getById(body.jobId)?.jobType).toBe('create-player');
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('create-player');
    if (queued?.jobType === 'create-player') {
      expect(queued.payload.pagina).toBe('RdA');
    }

    await server.close();
  });

  it('POST /users/create-player validates payload', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: { loginUsername: 'agent' }
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('POST /users/create-player accepts optional telefono', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        pagina: 'RdA',
        loginUsername: 'agent',
        loginPassword: 'secret',
        newUsername: 'player_with_phone',
        newPassword: 'player_secret',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(202);
    const queued = queue.requests.find((item) => item.id === response.json().jobId);
    expect(queued?.jobType).toBe('create-player');
    if (queued?.jobType === 'create-player') {
      expect(queued.payload.telefono).toBe('+5491122334455');
    }

    await server.close();
  });

  it('POST /users/create-player normalizes pagina aliases', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        pagina: 'asn',
        loginUsername: 'Abigail759',
        loginPassword: 'abigail123',
        newUsername: 'player_asn_alias',
        newPassword: 'player_secret'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('create-player');
    if (queued?.jobType === 'create-player') {
      expect(queued.payload.pagina).toBe('ASN');
    }

    await server.close();
  });

  it('POST /users/create-player requires pagina', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        loginUsername: 'Abigail759',
        loginPassword: 'abigail123',
        newUsername: 'player_missing_pagina',
        newPassword: 'player_secret'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues.some((issue: { path: string }) => issue.path === 'pagina')).toBe(true);
    await server.close();
  });

  it('POST /users/assign-phone returns 200 when assignment succeeds', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
        usuario: 'player_1',
        agente: 'agent_1',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(store.assignInputs).toEqual([
      {
        pagina: 'RdA',
        jugadorUsername: 'player_1',
        cajeroUsername: 'agent_1',
        telefono: '+5491122334455'
      }
    ]);

    await server.close();
  });

  it('POST /users/assign-phone validates payload', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
        usuario: 'player_1',
        agente: 'agent_1'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(store.assignInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /users/assign-phone returns 404 when jugador does not exist', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignBehavior = async () => {
      throw new PlayerPhoneStoreError('NOT_FOUND', 'jugador does not exist');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
        usuario: 'missing_player',
        agente: 'agent_1',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(404);

    await server.close();
  });

  it('POST /users/assign-phone returns 409 for conflict errors', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignBehavior = async () => {
      throw new PlayerPhoneStoreError('CONFLICT', 'jugador belongs to another cajero');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
        usuario: 'player_1',
        agente: 'other_agent',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(409);

    await server.close();
  });

  it('POST /users/assign-phone returns 409 when jugador link is missing', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignBehavior = async () => {
      throw new PlayerPhoneStoreError('CONFLICT', 'jugador link does not exist');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
        usuario: 'player_1',
        agente: 'agent_1',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(409);

    await server.close();
  });

  it('POST /users/assign-phone returns 409 for duplicated phone in cajero', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignBehavior = async () => {
      throw new PlayerPhoneStoreError('CONFLICT', 'duplicated phone for cajero');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
        usuario: 'player_2',
        agente: 'agent_1',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(409);

    await server.close();
  });

  it('POST /users/assign-phone returns 400 for invalid phone format', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignBehavior = async () => {
      throw new PlayerPhoneStoreError('VALIDATION', 'telefono must follow strict E.164 format');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
        usuario: 'player_1',
        agente: 'agent_1',
        telefono: 'abc'
      }
    });

    expect(response.statusCode).toBe(400);

    await server.close();
  });

  it('POST /users/deposit returns 202 with job id', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 500
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');
    expect(body.statusUrl).toBe(`/jobs/${body.jobId}`);
    expect(queue.getById(body.jobId)?.jobType).toBe('deposit');
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('deposit');
    if (queued?.jobType === 'deposit') {
      expect(queued.payload.pagina).toBe('RdA');
      expect(queued.payload.operacion).toBe('carga');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
    }

    await server.close();
  });

  it('POST /users/deposit enqueues balance job for consultar_saldo', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'consultar_saldo',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('balance');
    if (queued?.jobType === 'balance') {
      expect(queued.payload.pagina).toBe('RdA');
      expect(queued.payload.operacion).toBe('consultar_saldo');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
    }

    await server.close();
  });

  it('POST /users/deposit enqueues ASN report job for reporte', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'reporte',
        usuario: 'Ariel728',
        agente: 'luuucas10',
        contrasena_agente: 'australopitecus12725'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('report');
    if (queued?.jobType === 'report') {
      expect(queued.payload.pagina).toBe('ASN');
      expect(queued.payload.operacion).toBe('reporte');
      expect(queued.payload.usuario).toBe('Ariel728');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
    }

    await server.close();
  });

  it('POST /users/deposit keeps explicit execution overrides', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: ' DescARGA ',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 500,
        headless: false,
        debug: true,
        slowMo: 55,
        timeoutMs: 28_000
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('deposit');
    if (queued?.jobType === 'deposit') {
      expect(queued.payload.operacion).toBe('descarga');
      expect(queued.options.headless).toBe(false);
      expect(queued.options.debug).toBe(true);
      expect(queued.options.slowMo).toBe(55);
      expect(queued.options.timeoutMs).toBe(28_000);
    }

    await server.close();
  });

  it('POST /users/deposit enqueues ASN deposit job for carga', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 10
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('deposit');
    if (queued?.jobType === 'deposit') {
      expect(queued.payload.pagina).toBe('ASN');
      expect(queued.payload.operacion).toBe('carga');
      expect(queued.payload.cantidad).toBe(10);
    }

    await server.close();
  });

  it('POST /users/deposit enqueues ASN deposit and balance jobs for remaining operations', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const descargaResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'descarga',
        usuario: 'usuario1',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 5
      }
    });

    const descargaTotalResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'descarga_total',
        usuario: 'usuario1',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    const balanceResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'consultar_saldo',
        usuario: 'usuario1',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(descargaResponse.statusCode).toBe(202);
    expect(descargaTotalResponse.statusCode).toBe(202);
    expect(balanceResponse.statusCode).toBe(202);

    const descargaJob = queue.requests.find((item) => item.id === descargaResponse.json().jobId);
    const descargaTotalJob = queue.requests.find((item) => item.id === descargaTotalResponse.json().jobId);
    const balanceJob = queue.requests.find((item) => item.id === balanceResponse.json().jobId);

    expect(descargaJob?.jobType).toBe('deposit');
    if (descargaJob?.jobType === 'deposit') {
      expect(descargaJob.payload.pagina).toBe('ASN');
      expect(descargaJob.payload.operacion).toBe('descarga');
      expect(descargaJob.payload.cantidad).toBe(5);
    }

    expect(descargaTotalJob?.jobType).toBe('deposit');
    if (descargaTotalJob?.jobType === 'deposit') {
      expect(descargaTotalJob.payload.pagina).toBe('ASN');
      expect(descargaTotalJob.payload.operacion).toBe('descarga_total');
      expect(descargaTotalJob.payload.cantidad).toBeUndefined();
    }

    expect(balanceJob?.jobType).toBe('balance');
    if (balanceJob?.jobType === 'balance') {
      expect(balanceJob.payload.pagina).toBe('ASN');
      expect(balanceJob.payload.operacion).toBe('consultar_saldo');
    }

    await server.close();
  });

  it('POST /users/deposit returns 501 for reporte on non-ASN pagina', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'reporte',
        usuario: 'Ariel728',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().message).toMatch(/only for ASN/i);
    expect(queue.requests).toHaveLength(0);

    await server.close();
  });

  it('POST /users/deposit keeps explicit execution overrides for consultar_saldo', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'consultar saldo',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        headless: true,
        debug: true,
        slowMo: 33,
        timeoutMs: 18_000
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('balance');
    if (queued?.jobType === 'balance') {
      expect(queued.payload.operacion).toBe('consultar_saldo');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(true);
      expect(queued.options.slowMo).toBe(33);
      expect(queued.options.timeoutMs).toBe(18_000);
    }

    await server.close();
  });

  it('POST /users/deposit validates payload', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const aliasOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'retiro',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 500
      }
    });

    expect(aliasOperationResponse.statusCode).toBe(202);
    const aliasBody = aliasOperationResponse.json();
    const aliasQueued = queue.requests.find((item) => item.id === aliasBody.jobId);
    expect(aliasQueued?.jobType).toBe('deposit');
    if (aliasQueued?.jobType === 'deposit') {
      expect(aliasQueued.payload.operacion).toBe('descarga');
    }

    const totalOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'descarga_total',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(totalOperationResponse.statusCode).toBe(202);
    const totalBody = totalOperationResponse.json();
    const totalQueued = queue.requests.find((item) => item.id === totalBody.jobId);
    expect(totalQueued?.jobType).toBe('deposit');
    if (totalQueued?.jobType === 'deposit') {
      expect(totalQueued.payload.operacion).toBe('descarga_total');
      expect(totalQueued.payload.cantidad).toBeUndefined();
    }

    const totalAliasOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'retiro_total',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(totalAliasOperationResponse.statusCode).toBe(202);
    const totalAliasBody = totalAliasOperationResponse.json();
    const totalAliasQueued = queue.requests.find((item) => item.id === totalAliasBody.jobId);
    expect(totalAliasQueued?.jobType).toBe('deposit');
    if (totalAliasQueued?.jobType === 'deposit') {
      expect(totalAliasQueued.payload.operacion).toBe('descarga_total');
      expect(totalAliasQueued.payload.cantidad).toBeUndefined();
    }

    const balanceOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'consultar_saldo',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(balanceOperationResponse.statusCode).toBe(202);
    const balanceBody = balanceOperationResponse.json();
    const balanceQueued = queue.requests.find((item) => item.id === balanceBody.jobId);
    expect(balanceQueued?.jobType).toBe('balance');
    if (balanceQueued?.jobType === 'balance') {
      expect(balanceQueued.payload.operacion).toBe('consultar_saldo');
    }

    const balanceAliasOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'consultar saldo',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(balanceAliasOperationResponse.statusCode).toBe(202);
    const balanceAliasBody = balanceAliasOperationResponse.json();
    const balanceAliasQueued = queue.requests.find((item) => item.id === balanceAliasBody.jobId);
    expect(balanceAliasQueued?.jobType).toBe('balance');
    if (balanceAliasQueued?.jobType === 'balance') {
      expect(balanceAliasQueued.payload.operacion).toBe('consultar_saldo');
    }

    const reportOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'report',
        usuario: 'Ariel728',
        agente: 'luuucas10',
        contrasena_agente: 'australopitecus12725'
      }
    });

    expect(reportOperationResponse.statusCode).toBe(202);
    const reportBody = reportOperationResponse.json();
    const reportQueued = queue.requests.find((item) => item.id === reportBody.jobId);
    expect(reportQueued?.jobType).toBe('report');
    if (reportQueued?.jobType === 'report') {
      expect(reportQueued.payload.operacion).toBe('reporte');
    }

    const badOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'transferencia',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 500
      }
    });

    expect(badOperationResponse.statusCode).toBe(400);

    const badAmountResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 0
      }
    });

    expect(badAmountResponse.statusCode).toBe(400);

    const missingAmountForDescargaResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'descarga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(missingAmountForDescargaResponse.statusCode).toBe(400);

    const missingAmountForCargaResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(missingAmountForCargaResponse.statusCode).toBe(400);

    await server.close();
  });

  it('POST /users/deposit normalizes pagina aliases', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'rda',
        operacion: 'consultar_saldo',
        usuario: 'pruebita',
        agente: 'monchi30',
        contrasena_agente: '123mon'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('balance');
    if (queued?.jobType === 'balance') {
      expect(queued.payload.pagina).toBe('RdA');
    }

    await server.close();
  });

  it('POST /users/deposit requires pagina', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'monchi30',
        contrasena_agente: '123mon',
        cantidad: 100
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues.some((issue: { path: string }) => issue.path === 'pagina')).toBe(true);
    await server.close();
  });

  it('GET /jobs/:id returns 404 when missing', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'GET',
      url: '/jobs/missing'
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('GET /jobs/:id returns create-player result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-create-player-result';
    queue.entries.set(id, {
      id,
      jobType: 'create-player',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'create-player',
        pagina: 'ASN',
        requestedUsername: 'Pepito47',
        createdUsername: 'Pepito471',
        createdPassword: 'PepitoPass123',
        attempts: 2
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'create-player',
      pagina: 'ASN',
      requestedUsername: 'Pepito47',
      createdUsername: 'Pepito471',
      createdPassword: 'PepitoPass123',
      attempts: 2
    });

    await server.close();
  });

  it('GET /jobs/:id returns ASN report result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-asn-report-result';
    queue.entries.set(id, {
      id,
      jobType: 'report',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'asn-reporte-cargado-mes',
        pagina: 'ASN',
        usuario: 'Ariel728',
        mesActual: '2026-03',
        cargadoTexto: '40.000,00',
        cargadoNumero: 40000
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'asn-reporte-cargado-mes',
      pagina: 'ASN',
      usuario: 'Ariel728',
      mesActual: '2026-03',
      cargadoTexto: '40.000,00',
      cargadoNumero: 40000
    });

    await server.close();
  });

  it('GET /jobs/:id returns ASN funds operation result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-asn-funds-result';
    queue.entries.set(id, {
      id,
      jobType: 'deposit',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'asn-funds-operation',
        pagina: 'ASN',
        operacion: 'carga',
        usuario: 'Monica626',
        montoSolicitado: 500,
        montoAplicado: 500,
        montoAplicadoTexto: '500,00',
        saldoAntesNumero: 1000,
        saldoAntesTexto: '1.000,00',
        saldoDespuesNumero: 1500,
        saldoDespuesTexto: '1.500,00'
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'asn-funds-operation',
      pagina: 'ASN',
      operacion: 'carga',
      usuario: 'Monica626',
      montoSolicitado: 500,
      montoAplicado: 500,
      montoAplicadoTexto: '500,00',
      saldoAntesNumero: 1000,
      saldoAntesTexto: '1.000,00',
      saldoDespuesNumero: 1500,
      saldoDespuesTexto: '1.500,00'
    });

    await server.close();
  });

  it('GET /jobs/:id returns ASN balance result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-asn-balance-result';
    queue.entries.set(id, {
      id,
      jobType: 'balance',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'asn-balance',
        pagina: 'ASN',
        operacion: 'consultar_saldo',
        usuario: 'Carolina225',
        saldoTexto: '30.525,35',
        saldoNumero: 30525.35
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'asn-balance',
      pagina: 'ASN',
      operacion: 'consultar_saldo',
      usuario: 'Carolina225',
      saldoTexto: '30.525,35',
      saldoNumero: 30525.35
    });

    await server.close();
  });
});
