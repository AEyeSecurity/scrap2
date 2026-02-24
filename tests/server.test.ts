import { describe, expect, it } from 'vitest';
import { buildAppConfig } from '../src/config';
import { createServer } from '../src/server';
import { createLogger } from '../src/logging';
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
      expect(queued.options.headless).toBe(false);
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
      expect(queued.options.headless).toBe(false);
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

  it('POST /users/deposit returns 501 for ASN funds operations', async () => {
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

    expect(response.statusCode).toBe(501);
    expect(response.json().message).toMatch(/ASN funds operations/i);
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
});


