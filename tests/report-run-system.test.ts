import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { buildAppConfig } from '../src/config';
import { createLogger } from '../src/logging';
import {
  ReportRunStoreError,
  type CreateReportRunInput,
  type ReportRunItemsPage,
  type ReportRunLease,
  type ReportRunRecord,
  type ReportRunStore,
  type ReportRunStatus,
  type ReportRunItemRecord
} from '../src/report-run-store';
import { createServer } from '../src/server';
import type { AsnReportJobResult } from '../src/types';

type SeedOwner = {
  id: string;
  ownerKey: string;
  ownerLabel: string;
};

type SeedClient = {
  id: string;
  phone: string;
  username: string;
};

type SeedLink = {
  id: string;
  ownerId: string;
  clientId: string;
  status: 'assigned';
};

type OutboxEntry = {
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'consumed';
  consumedAt: string | null;
};

function formatAmount(value: number): string {
  const [integerPart, decimalPart] = value.toFixed(2).split('.');
  const withThousands = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${withThousands},${decimalPart}`;
}

class FakeReportRunStore implements ReportRunStore {
  public readonly owners = new Map<string, SeedOwner>();
  public readonly clients = new Map<string, SeedClient>();
  public readonly links = new Map<string, SeedLink>();
  public readonly runs = new Map<string, ReportRunRecord & { contrasenaAgente: string }>();
  public readonly items = new Map<string, ReportRunItemRecord>();
  public readonly snapshots = new Map<string, Record<string, unknown>>();
  public readonly outbox: OutboxEntry[] = [];

  private runSequence = 0;
  private itemSequence = 0;

  constructor(seed: { owners: SeedOwner[]; clients: SeedClient[]; links: SeedLink[] }) {
    for (const owner of seed.owners) {
      this.owners.set(owner.id, owner);
    }
    for (const client of seed.clients) {
      this.clients.set(client.id, client);
    }
    for (const link of seed.links) {
      this.links.set(link.id, link);
    }
  }

  async createRun(input: CreateReportRunInput): Promise<ReportRunRecord> {
    for (const run of this.runs.values()) {
      if (run.principalKey === input.principalKey && run.reportDate === input.reportDate) {
        throw new ReportRunStoreError('CONFLICT', 'Could not create report run');
      }
    }

    this.runSequence += 1;
    const id = `run-${this.runSequence}`;
    const record: ReportRunRecord & { contrasenaAgente: string } = {
      id,
      pagina: 'ASN',
      principalKey: input.principalKey.toLowerCase(),
      reportDate: input.reportDate,
      status: 'queued',
      agente: input.agente,
      contrasenaAgente: input.contrasenaAgente,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      totalItems: 0,
      doneItems: 0,
      failedItems: 0,
      metadata: input.metadata ?? {}
    };
    this.runs.set(id, record);
    return this.toRun(record);
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    for (const [itemId, item] of this.items.entries()) {
      if (item.runId === runId) {
        this.items.delete(itemId);
      }
    }
  }

  async enqueueRunItemsFromPrincipal(runId: string, principalKey: string): Promise<number> {
    const run = this.requireRun(runId);
    const normalizedPrincipal = principalKey.toLowerCase();
    let inserted = 0;

    for (const link of this.links.values()) {
      if (link.status !== 'assigned') {
        continue;
      }
      const owner = this.owners.get(link.ownerId);
      const client = this.clients.get(link.clientId);
      if (!owner || !client) {
        continue;
      }
      if (!owner.ownerKey.startsWith(`${normalizedPrincipal}:`)) {
        continue;
      }
      if (!client.username) {
        continue;
      }
      const exists = Array.from(this.items.values()).some((item) => item.runId === runId && item.username === client.username);
      if (exists) {
        continue;
      }

      this.itemSequence += 1;
      const item: ReportRunItemRecord = {
        id: `item-${this.itemSequence}`,
        runId,
        ownerId: owner.id,
        clientId: client.id,
        linkId: link.id,
        username: client.username,
        ownerKey: owner.ownerKey,
        ownerLabel: owner.ownerLabel,
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        leaseUntil: null,
        nextRetryAt: null,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        cargadoHoy: null,
        cargadoMes: null,
        rawResult: null,
        createdAt: new Date(Date.now() + this.itemSequence).toISOString(),
        updatedAt: new Date(Date.now() + this.itemSequence).toISOString()
      };
      this.items.set(item.id, item);
      inserted += 1;
    }

    if (inserted === 0) {
      throw new ReportRunStoreError('NOT_FOUND', 'No report users found for principalKey');
    }

    run.totalItems = Array.from(this.items.values()).filter((item) => item.runId === runId).length;
    return inserted;
  }

  async leaseNextRunItem(leaseSeconds: number, maxAttempts: number): Promise<ReportRunLease | null> {
    const now = Date.now();
    const candidates = Array.from(this.items.values())
      .filter((item) => {
        const run = this.runs.get(item.runId);
        if (!run || !['queued', 'running'].includes(run.status)) {
          return false;
        }
        if (item.attempts >= Math.min(item.maxAttempts, maxAttempts)) {
          return false;
        }
        return (
          item.status === 'pending' ||
          (item.status === 'retry_wait' && (!item.nextRetryAt || Date.parse(item.nextRetryAt) <= now)) ||
          (item.status === 'leased' && (!item.leaseUntil || Date.parse(item.leaseUntil) <= now))
        );
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const item = candidates[0];
    if (!item) {
      return null;
    }

    const run = this.requireRun(item.runId);
    item.status = 'leased';
    item.attempts += 1;
    item.startedAt ??= new Date().toISOString();
    item.leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();
    item.nextRetryAt = null;
    item.updatedAt = new Date().toISOString();
    if (run.status === 'queued') {
      run.status = 'running';
      run.startedAt ??= new Date().toISOString();
    }

    return {
      itemId: item.id,
      runId: item.runId,
      pagina: 'ASN',
      principalKey: run.principalKey,
      reportDate: run.reportDate,
      agente: run.agente,
      contrasenaAgente: run.contrasenaAgente,
      ownerId: item.ownerId,
      clientId: item.clientId,
      linkId: item.linkId,
      username: item.username,
      ownerKey: item.ownerKey,
      ownerLabel: item.ownerLabel,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts
    };
  }

  async completeRunItem(lease: ReportRunLease, result: AsnReportJobResult): Promise<void> {
    const item = this.requireItem(lease.itemId);
    item.status = 'done';
    item.leaseUntil = null;
    item.nextRetryAt = null;
    item.finishedAt = new Date().toISOString();
    item.lastError = null;
    item.cargadoHoy = result.cargadoHoyNumero;
    item.cargadoMes = result.cargadoNumero;
    item.rawResult = result;
    item.updatedAt = new Date().toISOString();
  }

  async failRunItem(lease: ReportRunLease, error: string): Promise<void> {
    const item = this.requireItem(lease.itemId);
    const terminal = lease.attempts >= lease.maxAttempts;
    item.status = terminal ? 'failed' : 'retry_wait';
    item.leaseUntil = null;
    item.nextRetryAt = terminal ? null : new Date(Date.now() + (lease.attempts >= lease.maxAttempts - 1 ? 300 : 60) * 1000).toISOString();
    item.finishedAt = terminal ? new Date().toISOString() : null;
    item.lastError = error;
    item.updatedAt = new Date().toISOString();
  }

  async upsertDailySnapshot(lease: ReportRunLease, result: AsnReportJobResult): Promise<void> {
    const key = `${lease.reportDate}:${lease.username}`;
    this.snapshots.set(key, {
      pagina: lease.pagina,
      reportDate: lease.reportDate,
      principalKey: lease.principalKey,
      ownerId: lease.ownerId,
      clientId: lease.clientId,
      linkId: lease.linkId,
      username: lease.username,
      ownerKey: lease.ownerKey,
      ownerLabel: lease.ownerLabel,
      cargadoHoy: result.cargadoHoyNumero,
      cargadoMes: result.cargadoNumero,
      rawResult: result
    });
  }

  async refreshRunStatus(runId: string): Promise<ReportRunRecord> {
    const run = this.requireRun(runId);
    const runItems = Array.from(this.items.values()).filter((item) => item.runId === runId);
    const total = runItems.length;
    const done = runItems.filter((item) => item.status === 'done').length;
    const failed = runItems.filter((item) => item.status === 'failed').length;
    const pending = runItems.filter((item) => ['pending', 'leased', 'retry_wait'].includes(item.status)).length;
    let status: ReportRunStatus = 'queued';

    if (total === 0) {
      status = 'queued';
    } else if (pending > 0) {
      status = 'running';
    } else if (done === total) {
      status = 'completed';
    } else if (done > 0) {
      status = 'completed_with_errors';
    } else {
      status = 'failed';
    }

    run.status = status;
    run.totalItems = total;
    run.doneItems = done;
    run.failedItems = failed;
    if (status !== 'queued' && !run.startedAt) {
      run.startedAt = new Date().toISOString();
    }
    run.finishedAt = ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status)
      ? run.finishedAt ?? new Date().toISOString()
      : null;

    return this.toRun(run);
  }

  async createOutboxEntry(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (!['completed', 'completed_with_errors', 'failed'].includes(run.status)) {
      return;
    }
    if (this.outbox.some((entry) => entry.runId === runId && entry.kind === 'asn_report_run_completed')) {
      return;
    }

    const items = (await this.listRunItems(runId, 500, 0)).items;
    this.outbox.push({
      runId,
      kind: 'asn_report_run_completed',
      status: 'consumed',
      consumedAt: new Date().toISOString(),
      payload: {
        runId,
        principalKey: run.principalKey,
        reportDate: run.reportDate,
        totalItems: run.totalItems,
        doneItems: run.doneItems,
        failedItems: run.failedItems,
        items: items.map((item) => ({
          username: item.username,
          ownerKey: item.ownerKey,
          ownerLabel: item.ownerLabel,
          cargadoHoy: item.cargadoHoy,
          cargadoMes: item.cargadoMes,
          status: item.status
        }))
      }
    });
    run.contrasenaAgente = '[redacted]';
  }

  async getRunById(runId: string): Promise<ReportRunRecord> {
    return this.toRun(this.requireRun(runId));
  }

  async listRunItems(runId: string, limit: number, offset: number): Promise<ReportRunItemsPage> {
    const all = Array.from(this.items.values())
      .filter((item) => item.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      items: all.slice(offset, offset + limit).map((item) => ({ ...item })),
      total: all.length
    };
  }

  private requireRun(runId: string): ReportRunRecord & { contrasenaAgente: string } {
    const run = this.runs.get(runId);
    if (!run) {
      throw new ReportRunStoreError('NOT_FOUND', 'Report run not found');
    }
    return run;
  }

  private requireItem(itemId: string): ReportRunItemRecord {
    const item = this.items.get(itemId);
    if (!item) {
      throw new ReportRunStoreError('NOT_FOUND', 'Report run item not found');
    }
    return item;
  }

  private toRun(run: ReportRunRecord & { contrasenaAgente: string }): ReportRunRecord {
    return {
      id: run.id,
      pagina: run.pagina,
      principalKey: run.principalKey,
      reportDate: run.reportDate,
      status: run.status,
      agente: run.agente,
      requestedAt: run.requestedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      totalItems: run.totalItems,
      doneItems: run.doneItems,
      failedItems: run.failedItems,
      metadata: run.metadata
    };
  }
}

function createSeededStore(): FakeReportRunStore {
  const owners: SeedOwner[] = [
    { id: 'owner-lucas10', ownerKey: 'asnlucas10:lucas10', ownerLabel: 'Lucas 10' },
    { id: 'owner-vicky', ownerKey: 'asnlucas10:vicky', ownerLabel: 'Vicky' }
  ];

  const rawUsers = [
    ['VAndrea487', 'owner-lucas10'],
    ['Juanchy707', 'owner-lucas10'],
    ['VVale4011', 'owner-lucas10'],
    ['Vmiriam391', 'owner-lucas10'],
    ['Mili984', 'owner-lucas10'],
    ['jalena175', 'owner-vicky'],
    ['vmirian410', 'owner-vicky'],
    ['gladis2359', 'owner-vicky'],
    ['Dai731', 'owner-vicky'],
    ['vnaty893', 'owner-vicky']
  ] as const;

  const clients: SeedClient[] = rawUsers.map(([username], index) => ({
    id: `client-${index + 1}`,
    phone: `+54935190000${String(index + 1).padStart(2, '0')}`,
    username: username.toLowerCase()
  }));
  const links: SeedLink[] = rawUsers.map(([, ownerId], index) => ({
    id: `link-${index + 1}`,
    ownerId,
    clientId: `client-${index + 1}`,
    status: 'assigned'
  }));

  return new FakeReportRunStore({ owners, clients, links });
}

function createExecutor() {
  return async (lease: ReportRunLease): Promise<AsnReportJobResult> => {
    const index = Number(lease.clientId.split('-')[1] ?? 1);
    const cargadoMes = index * 1000;
    const cargadoHoy = index * 100;
    return {
      kind: 'asn-reporte-cargado-mes',
      pagina: 'ASN',
      usuario: lease.username,
      mesActual: '2026-03',
      fechaActual: '2026-03-10',
      cargadoTexto: formatAmount(cargadoMes),
      cargadoNumero: cargadoMes,
      cargadoHoyTexto: formatAmount(cargadoHoy),
      cargadoHoyNumero: cargadoHoy
    };
  };
}

describe('report run system', () => {
  it('creates a report run and lists seeded users from the current owner model', async () => {
    const store = createSeededStore();
    const logger = createLogger('silent', false);
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      undefined,
      { reportRunStore: store, reportWorkerEnabled: false }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/reports/asn/run',
      payload: {
        pagina: 'ASN',
        principalKey: 'asnlucas10',
        agente: 'Pity24',
        contrasena_agente: 'pityboca1509',
        reportDate: '2026-03-10'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');
    expect(body.runId).toBeTypeOf('string');

    const itemsResponse = await server.inject({
      method: 'GET',
      url: `/reports/asn/run/${body.runId}/items`
    });

    expect(itemsResponse.statusCode).toBe(200);
    const itemsBody = itemsResponse.json();
    expect(itemsBody.total).toBe(10);
    expect(itemsBody.items).toHaveLength(10);
    expect(itemsBody.items.map((item: { username: string }) => item.username)).toEqual([
      'vandrea487',
      'juanchy707',
      'vvale4011',
      'vmiriam391',
      'mili984',
      'jalena175',
      'vmirian410',
      'gladis2359',
      'dai731',
      'vnaty893'
    ]);

    await server.close();
  });

  it('processes a full run end-to-end and persists snapshots plus outbox', async () => {
    const store = createSeededStore();
    const logger = createLogger('silent', false);
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      undefined,
      {
        reportRunStore: store,
        reportWorkerEnabled: true,
        reportWorkerPollMs: 5,
        reportWorkerConcurrency: 3,
        reportWorkerLeaseSeconds: 60,
        reportWorkerMaxAttempts: 3,
        reportJobExecutor: createExecutor()
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/reports/asn/run',
      payload: {
        pagina: 'ASN',
        principalKey: 'asnlucas10',
        agente: 'Pity24',
        contrasena_agente: 'pityboca1509',
        reportDate: '2026-03-10'
      }
    });

    expect(response.statusCode).toBe(202);
    const { runId } = response.json() as { runId: string };

    let runStatus = 'queued';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runResponse = await server.inject({ method: 'GET', url: `/reports/asn/run/${runId}` });
      expect(runResponse.statusCode).toBe(200);
      runStatus = runResponse.json().status;
      if (runStatus === 'completed') {
        break;
      }
      await delay(10);
    }

    expect(runStatus).toBe('completed');
    expect(store.snapshots.size).toBe(10);
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]?.status).toBe('consumed');
    expect(store.outbox[0]?.consumedAt).toBeTypeOf('string');
    expect(store.runs.get(runId)?.contrasenaAgente).toBe('[redacted]');

    const grouped = Array.from(store.snapshots.values()).reduce<Record<string, { hoy: number; mes: number; count: number }>>(
      (acc, snapshot) => {
        const ownerKey = String(snapshot.ownerKey);
        if (!acc[ownerKey]) {
          acc[ownerKey] = { hoy: 0, mes: 0, count: 0 };
        }
        acc[ownerKey].hoy += Number(snapshot.cargadoHoy);
        acc[ownerKey].mes += Number(snapshot.cargadoMes);
        acc[ownerKey].count += 1;
        return acc;
      },
      {}
    );

    expect(grouped['asnlucas10:lucas10']).toEqual({ hoy: 1500, mes: 15000, count: 5 });
    expect(grouped['asnlucas10:vicky']).toEqual({ hoy: 4000, mes: 40000, count: 5 });

    await server.close();
  });

  it('retries a failed username and finishes the run without losing state', async () => {
    const store = createSeededStore();
    const logger = createLogger('silent', false);
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const failures = new Set<string>();
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      undefined,
      {
        reportRunStore: store,
        reportWorkerEnabled: true,
        reportWorkerPollMs: 5,
        reportWorkerConcurrency: 2,
        reportWorkerLeaseSeconds: 60,
        reportWorkerMaxAttempts: 3,
        reportJobExecutor: async (lease) => {
          if (lease.username === 'gladis2359' && !failures.has(lease.username)) {
            failures.add(lease.username);
            throw new Error('temporary ASN failure');
          }
          return createExecutor()(lease);
        }
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/reports/asn/run',
      payload: {
        pagina: 'ASN',
        principalKey: 'asnlucas10',
        agente: 'Pity24',
        contrasena_agente: 'pityboca1509',
        reportDate: '2026-03-11'
      }
    });

    const { runId } = response.json() as { runId: string };

    const gladisItem = Array.from(store.items.values()).find((item) => item.username === 'gladis2359');
    expect(gladisItem).toBeDefined();
    if (gladisItem) {
      gladisItem.nextRetryAt = new Date(Date.now() - 1_000).toISOString();
    }

    let finalStatus = 'queued';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runResponse = await server.inject({ method: 'GET', url: `/reports/asn/run/${runId}` });
      finalStatus = runResponse.json().status;
      if (finalStatus === 'completed') {
        break;
      }
      const mutableGladis = Array.from(store.items.values()).find((item) => item.username === 'gladis2359');
      if (mutableGladis?.status === 'retry_wait') {
        mutableGladis.nextRetryAt = new Date(Date.now() - 1_000).toISOString();
      }
      await delay(10);
    }

    expect(finalStatus).toBe('completed');
    const completedGladis = Array.from(store.items.values()).find((item) => item.username === 'gladis2359');
    expect(completedGladis?.attempts).toBe(2);
    expect(completedGladis?.status).toBe('done');

    await server.close();
  });

  it('rejects duplicate runs for the same principal and date', async () => {
    const store = createSeededStore();
    const logger = createLogger('silent', false);
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      undefined,
      { reportRunStore: store, reportWorkerEnabled: false }
    );

    const payload = {
      pagina: 'ASN',
      principalKey: 'asnlucas10',
      agente: 'Pity24',
      contrasena_agente: 'pityboca1509',
      reportDate: '2026-03-10'
    };

    const first = await server.inject({ method: 'POST', url: '/reports/asn/run', payload });
    expect(first.statusCode).toBe(202);

    const second = await server.inject({ method: 'POST', url: '/reports/asn/run', payload });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toBe('Could not create report run');

    await server.close();
  });
});
