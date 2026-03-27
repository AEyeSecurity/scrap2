import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging';
import { JobManager } from '../src/jobs';
import type { JobRequest, JobStepResult, LoginJobRequest } from '../src/types';

function makeLoginRequest(id = randomUUID()): LoginJobRequest {
  return {
    id,
    jobType: 'login',
    createdAt: new Date().toISOString(),
    payload: {
      username: 'user',
      password: 'pass'
    },
    options: {
      headless: true,
      debug: false,
      slowMo: 0,
      timeoutMs: 5_000
    }
  };
}

function makeStep(name: string): JobStepResult {
  const now = new Date().toISOString();
  return {
    name,
    status: 'ok',
    startedAt: now,
    finishedAt: now
  };
}

async function waitForTerminalState(manager: JobManager, id: string): Promise<string | undefined> {
  for (let i = 0; i < 20; i += 1) {
    const status = manager.getById(id)?.status;
    if (status && ['succeeded', 'failed', 'expired'].includes(status)) {
      return status;
    }
    await sleep(20);
  }

  return manager.getById(id)?.status;
}

describe('JobManager', () => {
  it('transitions a successful job to succeeded', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async () => {
        await sleep(10);
        return { artifactPaths: ['/tmp/trace.zip'], steps: [makeStep('login')] };
      }
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('succeeded');
    expect(manager.getById(id)?.jobType).toBe('login');
    expect(manager.getById(id)?.artifactPaths).toEqual(['/tmp/trace.zip']);
    expect(manager.getById(id)?.steps).toHaveLength(1);
    await manager.shutdown();
  });

  it('transitions a failed job to failed and preserves attached context', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async (_request: JobRequest) => {
        const error = new Error('invalid login');
        (error as Error & { artifactPaths?: string[]; steps?: JobStepResult[] }).artifactPaths = [
          '/tmp/error.png'
        ];
        (error as Error & { artifactPaths?: string[]; steps?: JobStepResult[] }).steps = [
          {
            name: 'login',
            status: 'failed',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            error: 'invalid login'
          }
        ];
        throw error;
      }
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('failed');
    expect(manager.getById(id)?.error).toContain('invalid login');
    expect(manager.getById(id)?.artifactPaths).toEqual(['/tmp/error.png']);
    expect(manager.getById(id)?.steps[0]?.status).toBe('failed');
    await manager.shutdown();
  });

  it('marks finished jobs as expired after ttl', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 0.0001,
      logger: createLogger('silent', false),
      executor: async () => ({ artifactPaths: [], steps: [makeStep('login')] })
    });

    const id = manager.enqueue(makeLoginRequest());
    await waitForTerminalState(manager, id);
    await sleep(20);

    expect(manager.getById(id)?.status).toBe('expired');
    await manager.shutdown();
  });

  it('stores and returns job result payload when executor succeeds', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async () => ({
        artifactPaths: [],
        steps: [makeStep('read-balance')],
        result: {
          kind: 'balance',
          pagina: 'RdA',
          operacion: 'consultar_saldo',
          usuario: 'pruebita',
          saldoTexto: '1.234,56',
          saldoNumero: 1234.56
        }
      })
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('succeeded');
    const entry = manager.getById(id);
    expect(entry?.result).toEqual({
      kind: 'balance',
      pagina: 'RdA',
      operacion: 'consultar_saldo',
      usuario: 'pruebita',
      saldoTexto: '1.234,56',
      saldoNumero: 1234.56
    });

    await manager.shutdown();
  });

  it('stores and returns RDA funds operation result payload when executor succeeds', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async () => ({
        artifactPaths: [],
        steps: [makeStep('rda-funds')],
        result: {
          kind: 'rda-funds-operation',
          pagina: 'RdA',
          operacion: 'descarga',
          usuario: 'pepito47',
          montoSolicitado: 500,
          montoAplicado: 500,
          montoAplicadoTexto: '500,00',
          saldoAntesNumero: 1500,
          saldoAntesTexto: '1.500,00',
          saldoDespuesNumero: 1000,
          saldoDespuesTexto: '1.000,00'
        }
      })
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('succeeded');
    const entry = manager.getById(id);
    expect(entry?.result).toEqual({
      kind: 'rda-funds-operation',
      pagina: 'RdA',
      operacion: 'descarga',
      usuario: 'pepito47',
      montoSolicitado: 500,
      montoAplicado: 500,
      montoAplicadoTexto: '500,00',
      saldoAntesNumero: 1500,
      saldoAntesTexto: '1.500,00',
      saldoDespuesNumero: 1000,
      saldoDespuesTexto: '1.000,00'
    });

    await manager.shutdown();
  });

  it('stores and returns create-player result payload when executor succeeds', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async () => ({
        artifactPaths: [],
        steps: [makeStep('create-player')],
        result: {
          kind: 'create-player',
          pagina: 'ASN',
          requestedUsername: 'Pepito47',
          createdUsername: 'Pepito471',
          createdPassword: 'PepitoPass123',
          attempts: 2
        }
      })
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('succeeded');
    const entry = manager.getById(id);
    expect(entry?.result).toEqual({
      kind: 'create-player',
      pagina: 'ASN',
      requestedUsername: 'Pepito47',
      createdUsername: 'Pepito471',
      createdPassword: 'PepitoPass123',
      attempts: 2
    });

    await manager.shutdown();
  });

  it('stores and returns ASN report result payload when executor succeeds', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async () => ({
        artifactPaths: [],
        steps: [makeStep('read-asn-month-total')],
        result: {
          kind: 'asn-reporte-cargado-mes',
          pagina: 'ASN',
          usuario: 'Ariel728',
          mesActual: '2026-03',
          fechaActual: '2026-03-09',
          cargadoTexto: '40.000,00',
          cargadoNumero: 40000,
          cargadoHoyTexto: '0,00',
          cargadoHoyNumero: 0
        }
      })
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('succeeded');
    const entry = manager.getById(id);
    expect(entry?.result).toEqual({
      kind: 'asn-reporte-cargado-mes',
      pagina: 'ASN',
      usuario: 'Ariel728',
      mesActual: '2026-03',
      fechaActual: '2026-03-09',
      cargadoTexto: '40.000,00',
      cargadoNumero: 40000,
      cargadoHoyTexto: '0,00',
      cargadoHoyNumero: 0
    });

    await manager.shutdown();
  });

  it('stores and returns ASN funds operation result payload when executor succeeds', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async () => ({
        artifactPaths: [],
        steps: [makeStep('asn-funds')],
        result: {
          kind: 'asn-funds-operation',
          pagina: 'ASN',
          operacion: 'descarga_total',
          usuario: 'Monica626',
          montoSolicitado: 1234.56,
          montoAplicado: 1234.56,
          montoAplicadoTexto: '1.234,56',
          saldoAntesNumero: 1234.56,
          saldoAntesTexto: '1.234,56',
          saldoDespuesNumero: 0,
          saldoDespuesTexto: '0,00'
        }
      })
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('succeeded');
    const entry = manager.getById(id);
    expect(entry?.result).toEqual({
      kind: 'asn-funds-operation',
      pagina: 'ASN',
      operacion: 'descarga_total',
      usuario: 'Monica626',
      montoSolicitado: 1234.56,
      montoAplicado: 1234.56,
      montoAplicadoTexto: '1.234,56',
      saldoAntesNumero: 1234.56,
      saldoAntesTexto: '1.234,56',
      saldoDespuesNumero: 0,
      saldoDespuesTexto: '0,00'
    });

    await manager.shutdown();
  });

  it('stores and returns ASN balance result payload when executor succeeds', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async () => ({
        artifactPaths: [],
        steps: [makeStep('asn-balance')],
        result: {
          kind: 'asn-balance',
          pagina: 'ASN',
          operacion: 'consultar_saldo',
          usuario: 'Carolina225',
          saldoTexto: '30.525,35',
          saldoNumero: 30525.35
        }
      })
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('succeeded');
    const entry = manager.getById(id);
    expect(entry?.result).toEqual({
      kind: 'asn-balance',
      pagina: 'ASN',
      operacion: 'consultar_saldo',
      usuario: 'Carolina225',
      saldoTexto: '30.525,35',
      saldoNumero: 30525.35
    });

    await manager.shutdown();
  });
});
