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
        operacion: 'carga',
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
      expect(queued.options.headless).toBe(false);
      expect(queued.options.debug).toBe(true);
      expect(queued.options.slowMo).toBe(55);
      expect(queued.options.timeoutMs).toBe(28_000);
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

    const badOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        operacion: 'retiro',
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
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 0
      }
    });

    expect(badAmountResponse.statusCode).toBe(400);

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
