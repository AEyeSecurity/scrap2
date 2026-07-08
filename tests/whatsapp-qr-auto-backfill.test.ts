import { describe, expect, it, vi } from 'vitest';
import { WhatsappQrAutoBackfillRunner } from '../src/whatsapp-qr-auto-backfill';
import type {
  WhatsappQrBackfillRunRecord,
  WhatsappQrMatchRecord,
  WhatsappQrMessageRecord,
  WhatsappQrMonthClientRecord,
  WhatsappQrOwner,
  WhatsappQrSessionRecord,
  WhatsappQrStore
} from '../src/whatsapp-qr-store';

const owner: WhatsappQrOwner = {
  ownerId: 'owner-1',
  ownerKey: 'luqui10:luqui10',
  ownerLabel: 'Luqui10',
  pagina: 'RdA'
};

const session: WhatsappQrSessionRecord = {
  id: 'session-1',
  ownerId: owner.ownerId,
  ownerKey: owner.ownerKey,
  ownerLabel: owner.ownerLabel,
  pagina: owner.pagina,
  status: 'connected',
  runtimeSessionId: 'runtime-1',
  phoneE164: '+5493510000000',
  qrPayload: null,
  qrDataUrl: null,
  qrExpiresAt: null,
  lastHeartbeatAt: '2026-07-06T12:00:00.000Z',
  lastConnectedAt: '2026-07-06T12:00:00.000Z',
  lastDisconnectedAt: null,
  lastError: null,
  botGroupKey: null,
  createdAt: '2026-07-06T12:00:00.000Z',
  updatedAt: '2026-07-06T12:00:00.000Z'
};

function buildMonthClient(phoneE164: string, assignedUsername: string | null = null): WhatsappQrMonthClientRecord {
  return {
    clientId: `client-${phoneE164}`,
    linkId: `link-${phoneE164}`,
    phoneE164,
    assignedUsername
  };
}

function buildMessage(overrides: Partial<WhatsappQrMessageRecord>): WhatsappQrMessageRecord {
  return {
    id: 'message-1',
    sessionId: session.id,
    ownerId: owner.ownerId,
    direction: 'contact_sync',
    clientPhoneE164: '+5493511111111',
    contactName: 'player_1',
    pushName: null,
    textExcerpt: null,
    candidateUsername: 'player_1',
    matchSource: 'contact_name',
    messageTimestamp: '2026-07-06T12:00:00.000Z',
    createdAt: '2026-07-06T12:00:00.000Z',
    ...overrides
  };
}

function buildMatch(overrides: Partial<WhatsappQrMatchRecord>): WhatsappQrMatchRecord {
  return {
    id: 'match-1',
    sessionId: session.id,
    ownerId: owner.ownerId,
    messageId: null,
    pagina: 'RdA',
    clientPhoneE164: '+5493511111111',
    username: 'player_1',
    source: 'contact_name',
    status: 'candidate',
    rdaValidatedAt: null,
    assignedAt: null,
    errorMessage: null,
    createdAt: '2026-07-06T12:00:00.000Z',
    updatedAt: '2026-07-06T12:00:00.000Z',
    ...overrides
  };
}

function buildBackfillRun(status: WhatsappQrBackfillRunRecord['status'], lastCompletedAt: string | null): WhatsappQrBackfillRunRecord {
  return {
    id: 'run-1',
    ownerId: owner.ownerId,
    sessionId: session.id,
    monthStart: '2026-07-01',
    triggerSource: 'resume_connected',
    status,
    startedAt: '2026-07-06T12:00:00.000Z',
    finishedAt: lastCompletedAt,
    lastCompletedAt,
    lastError: null,
    summaryJson: null,
    createdAt: '2026-07-06T12:00:00.000Z',
    updatedAt: '2026-07-06T12:00:00.000Z'
  };
}

function createStore(overrides: Partial<WhatsappQrStore> = {}): WhatsappQrStore {
  return {
    listReconnectableSessions: vi.fn(async () => []),
    listOwners: vi.fn(async () => []),
    getOwnerById: vi.fn(async () => null),
    getOwnerByKey: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    getSessionByOwner: vi.fn(async () => null),
    upsertSession: vi.fn(async () => session),
    updateSession: vi.fn(async () => session),
    listMonthClients: vi.fn(async () => []),
    listIgnoredPhonesForMonth: vi.fn(async () => new Set<string>()),
    listOwnerClientPhonesForMonth: vi.fn(async () => new Set<string>()),
    insertMessage: vi.fn(async () => buildMessage({})),
    listMessagesForMonth: vi.fn(async () => []),
    listMatchesForMonth: vi.fn(async () => []),
    upsertMatch: vi.fn(async () => buildMatch({})),
    getLatestBackfillRun: vi.fn(async () => null),
    createBackfillRun: vi.fn(async () => buildBackfillRun('running', null)),
    updateBackfillRun: vi.fn(async () => undefined),
    enqueueRecheck: vi.fn(async (input) => ({
      id: `recheck-${input.phoneE164}`,
      ownerId: input.ownerId,
      sessionId: input.sessionId ?? null,
      monthStart: input.monthStart,
      phoneE164: input.phoneE164,
      reason: input.reason,
      status: 'pending',
      attempts: 0,
      nextRunAt: input.nextRunAt ?? '2026-07-06T12:00:00.000Z',
      expiresAt: '2026-07-13T12:00:00.000Z',
      lastError: null,
      createdAt: '2026-07-06T12:00:00.000Z',
      updatedAt: '2026-07-06T12:00:00.000Z'
    })),
    getQueuedRechecksDue: vi.fn(async () => []),
    markRecheckStatus: vi.fn(async () => undefined),
    ignorePhoneForMonth: vi.fn(async () => undefined),
    listContactsByPhones: vi.fn(async () => []),
    upsertContact: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    getLatestMessageForPhone: vi.fn(async () => null),
    getLatestMatchForPhone: vi.fn(async () => null),
    getRdaCredential: vi.fn(async () => null),
    upsertRdaCredential: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    listCredentialOwnerIds: vi.fn(async () => new Set<string>()),
    listStaleSessions: vi.fn(async () => []),
    markAlerted: vi.fn(async () => undefined),
    ...overrides
  } as WhatsappQrStore;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn()
  } as any;
}

async function waitForCalls(assertion: () => void, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (index === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe('WhatsappQrAutoBackfillRunner', () => {
  it('runs backfill and enqueues no-signal rechecks including ignored rows', async () => {
    const enqueueRecheck = vi.fn(async (input) => ({
      id: `recheck-${input.phoneE164}`,
      ownerId: input.ownerId,
      sessionId: input.sessionId ?? null,
      monthStart: input.monthStart,
      phoneE164: input.phoneE164,
      reason: input.reason,
      status: 'pending',
      attempts: 0,
      nextRunAt: input.nextRunAt ?? '2026-07-06T12:00:00.000Z',
      expiresAt: '2026-07-13T12:00:00.000Z',
      lastError: null,
      createdAt: '2026-07-06T12:00:00.000Z',
      updatedAt: '2026-07-06T12:00:00.000Z'
    }));
    const updateBackfillRun = vi.fn(async () => undefined);
    const store = createStore({
      listMonthClients: vi.fn(async () => [
        buildMonthClient('+5493511111111'),
        buildMonthClient('+5493512222222')
      ]),
      listMessagesForMonth: vi.fn(async () => []),
      listMatchesForMonth: vi.fn(async () => []),
      listIgnoredPhonesForMonth: vi.fn(async () => new Set(['+5493511111111'])),
      enqueueRecheck,
      updateBackfillRun
    });
    const runner = new WhatsappQrAutoBackfillRunner(store, createLogger(), {
      now: () => new Date('2026-07-06T12:00:00.000Z'),
      runBackfill: vi.fn(async () => ({
        ownerKey: owner.ownerKey,
        monthStart: '2026-07-01',
        summary: {
          phonesScanned: 2,
          contactsUpserted: 0,
          messagesCaptured: 0,
          matchesCreated: 0,
          matchesUpdated: 0,
          assignedLinked: 0,
          notFoundMarked: 0,
          technicalErrors: 0
        }
      }))
    });

    const result = await runner.run(owner, session, 'resume_connected');

    expect(result).toEqual({
      status: 'completed',
      monthStart: '2026-07-01',
      rechecksEnqueued: 2,
      noSignalRows: 2
    });
    expect(enqueueRecheck).toHaveBeenCalledTimes(2);
    expect(enqueueRecheck).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ownerId: owner.ownerId,
        sessionId: session.id,
        monthStart: '2026-07-01',
        phoneE164: '+5493511111111',
        reason: 'backfill_no_signal'
      })
    );
    expect(enqueueRecheck).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phoneE164: '+5493512222222',
        reason: 'backfill_no_signal'
      })
    );
    expect(updateBackfillRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'completed',
        summaryJson: expect.objectContaining({
          noSignalRows: 2,
          rechecksEnqueued: 2
        })
      })
    );
  });

  it('skips execution when a completed run exists inside the six-hour throttle window', async () => {
    const createBackfillRun = vi.fn();
    const runBackfill = vi.fn();
    const store = createStore({
      getLatestBackfillRun: vi.fn(async () => buildBackfillRun('completed', '2026-07-06T11:30:00.000Z')),
      createBackfillRun
    });
    const runner = new WhatsappQrAutoBackfillRunner(store, createLogger(), {
      now: () => new Date('2026-07-06T12:00:00.000Z'),
      runBackfill
    });

    const result = await runner.run(owner, session, 'resume_connected');

    expect(result).toEqual({
      status: 'skipped',
      reason: 'throttled',
      monthStart: '2026-07-01',
      rechecksEnqueued: 0,
      noSignalRows: 0
    });
    expect(createBackfillRun).not.toHaveBeenCalled();
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it('avoids overlapping runs for the same owner and month', async () => {
    let resolveBackfill: (() => void) | null = null;
    const runBackfill = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveBackfill = () =>
            resolve({
              ownerKey: owner.ownerKey,
              monthStart: '2026-07-01',
              summary: {
                phonesScanned: 0,
                contactsUpserted: 0,
                messagesCaptured: 0,
                matchesCreated: 0,
                matchesUpdated: 0,
                assignedLinked: 0,
                notFoundMarked: 0,
                technicalErrors: 0
              }
            });
        })
    );
    const store = createStore({
      listMonthClients: vi.fn(async () => []),
      listMessagesForMonth: vi.fn(async () => []),
      listMatchesForMonth: vi.fn(async () => []),
      createBackfillRun: vi.fn(async () => buildBackfillRun('running', null))
    });
    const runner = new WhatsappQrAutoBackfillRunner(store, createLogger(), {
      now: () => new Date('2026-07-06T12:00:00.000Z'),
      runBackfill
    });

    const firstRun = runner.run(owner, session, 'resume_connected');
    await waitForCalls(() => {
      expect(runBackfill).toHaveBeenCalledTimes(1);
    });
    const secondRun = await runner.run(owner, session, 'resume_connected');
    resolveBackfill?.();
    await firstRun;

    expect(secondRun).toEqual({
      status: 'skipped',
      reason: 'already_running',
      monthStart: '2026-07-01',
      rechecksEnqueued: 0,
      noSignalRows: 0
    });
    expect((store.createBackfillRun as any)).toHaveBeenCalledTimes(1);
  });
});
