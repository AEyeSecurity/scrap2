import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetaConversionLease, MetaConversionsStore } from '../src/meta-conversions-store';
import { MetaConversionsWorker } from '../src/meta-conversions-worker';
import { createLogger } from '../src/logging';
import type { ReportRunLease, ReportRunRecord, ReportRunStore } from '../src/report-run-store';
import { ReportRunWorker } from '../src/report-worker';

class FakeReportRunStore implements ReportRunStore {
  public leases: ReportRunLease[] = [];
  public completed: string[] = [];
  public snapshotted: string[] = [];
  public outbox: string[] = [];

  async createRun(): Promise<ReportRunRecord> {
    throw new Error('not used');
  }

  async deleteRun(): Promise<void> {
    throw new Error('not used');
  }

  async enqueueRunItemsFromPrincipal(): Promise<number> {
    throw new Error('not used');
  }

  async leaseNextRunItem(): Promise<ReportRunLease | null> {
    return this.leases.shift() ?? null;
  }

  async completeRunItem(lease: ReportRunLease): Promise<void> {
    this.completed.push(lease.itemId);
  }

  async failRunItem(): Promise<void> {
    throw new Error('not used');
  }

  async upsertDailySnapshot(lease: ReportRunLease): Promise<void> {
    this.snapshotted.push(lease.itemId);
  }

  async refreshRunStatus(runId: string): Promise<ReportRunRecord> {
    return {
      id: runId,
      pagina: 'ASN',
      principalKey: 'owner-1',
      reportDate: '2026-04-16',
      status: 'completed',
      agente: 'agent',
      requestedAt: '2026-04-16T00:00:00.000Z',
      startedAt: '2026-04-16T00:00:01.000Z',
      finishedAt: '2026-04-16T00:00:02.000Z',
      totalItems: 1,
      doneItems: 1,
      failedItems: 0,
      metadata: {}
    };
  }

  async createOutboxEntry(runId: string): Promise<void> {
    this.outbox.push(runId);
  }

  async getRunById(): Promise<ReportRunRecord> {
    throw new Error('not used');
  }

  async listRunItems(): Promise<{ items: never[]; total: number }> {
    throw new Error('not used');
  }
}

class FakeMetaStore implements MetaConversionsStore {
  public leases: MetaConversionLease[] = [];
  public scanResults: number[] = [];
  public sent: string[] = [];

  async enqueueLead(): Promise<void> {
    throw new Error('not used');
  }

  async scanForValueSignals(): Promise<number> {
    return this.scanResults.shift() ?? 0;
  }

  async leaseNextEvent(): Promise<MetaConversionLease | null> {
    return this.leases.shift() ?? null;
  }

  async markSent(input: { id: string }): Promise<void> {
    this.sent.push(input.id);
  }

  async markRetry(): Promise<void> {
    throw new Error('not used');
  }

  async markFailed(): Promise<void> {
    throw new Error('not used');
  }
}

function buildReportLease(overrides: Partial<ReportRunLease> = {}): ReportRunLease {
  return {
    itemId: 'item-1',
    runId: 'run-1',
    pagina: 'ASN',
    principalKey: 'owner-1',
    reportDate: '2026-04-16',
    agente: 'agent',
    contrasenaAgente: 'secret',
    ownerId: 'owner-id',
    identityId: 'identity-id',
    clientId: 'client-id',
    linkId: 'link-id',
    username: 'player-1',
    ownerKey: 'owner-1',
    ownerLabel: 'Owner 1',
    attempts: 1,
    maxAttempts: 3,
    ...overrides
  };
}

function buildMetaLease(overrides: Partial<MetaConversionLease> = {}): MetaConversionLease {
  return {
    id: 'meta-1',
    ownerId: 'owner-1',
    clientId: 'client-1',
    eventStage: 'lead',
    metaEventName: 'Lead',
    eventId: 'lead:test',
    eventTime: '2026-04-16T00:00:00.000Z',
    phoneE164: '+5491122334455',
    username: null,
    sourcePayload: {},
    attempts: 1,
    maxAttempts: 5,
    ...overrides
  };
}

describe('adaptive worker polling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('processes report leases and writes the snapshot/outbox flow', async () => {
    vi.useFakeTimers();
    const store = new FakeReportRunStore();
    store.leases.push(buildReportLease());
    const logger = createLogger('info', false);
    const worker = new ReportRunWorker(
      store,
      logger,
      { concurrency: 1, pollMs: 100, maxPollMs: 400, leaseSeconds: 60, maxAttempts: 3 },
      vi.fn().mockResolvedValue({
        kind: 'asn-reporte-cargado-mes',
        pagina: 'ASN',
        usuario: 'player-1',
        mesActual: 'abril',
        fechaActual: '2026-04-16',
        cargadoTexto: '$0',
        cargadoNumero: 0,
        cargadoHoyTexto: '$0',
        cargadoHoyNumero: 0
      })
    );

    worker.start();
    await vi.advanceTimersByTimeAsync(25);
    await worker.stop();

    expect(store.completed).toEqual(['item-1']);
    expect(store.snapshotted).toEqual(['item-1']);
    expect(store.outbox).toEqual(['run-1']);
  });

  it('backs off idle report polling when no work is available', async () => {
    vi.useFakeTimers();
    const store = new FakeReportRunStore();
    const logger = createLogger('info', false);
    const infoSpy = vi.spyOn(logger, 'info');
    const worker = new ReportRunWorker(
      store,
      logger,
      { concurrency: 1, pollMs: 100, maxPollMs: 400, leaseSeconds: 60, maxAttempts: 3 },
      vi.fn()
    );

    worker.start();
    await vi.advanceTimersByTimeAsync(750);
    await worker.stop();

    expect(infoSpy).toHaveBeenCalledWith({ nextPollMs: 200 }, 'Report run worker idle; backing off polling');
    expect(infoSpy).toHaveBeenCalledWith({ nextPollMs: 400 }, 'Report run worker idle; backing off polling');
  });

  it('backs off idle meta polling when no work is available', async () => {
    vi.useFakeTimers();
    const store = new FakeMetaStore();
    const logger = createLogger('info', false);
    const infoSpy = vi.spyOn(logger, 'info');
    const worker = new MetaConversionsWorker(
      store,
      {
        dispatch: vi.fn()
      },
      logger,
      { concurrency: 1, pollMs: 100, maxPollMs: 400, leaseSeconds: 60, maxAttempts: 5, scanLimit: 10 }
    );

    worker.start();
    await vi.advanceTimersByTimeAsync(750);
    await worker.stop();

    expect(infoSpy).toHaveBeenCalledWith({ nextPollMs: 200 }, 'Meta conversions worker idle; backing off polling');
    expect(infoSpy).toHaveBeenCalledWith({ nextPollMs: 400 }, 'Meta conversions worker idle; backing off polling');
  });
});
