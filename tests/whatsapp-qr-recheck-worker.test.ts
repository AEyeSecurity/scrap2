import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAppConfig } from '../src/config';
import { createLogger } from '../src/logging';
import { WhatsappQrRecheckWorker } from '../src/whatsapp-qr-recheck-worker';
import type { WhatsappQrMatchRecord, WhatsappQrRecheckQueueRecord, WhatsappQrSessionRecord } from '../src/whatsapp-qr-store';

const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
const logger = createLogger('silent', false);

const session: WhatsappQrSessionRecord = {
  id: 'session-1',
  ownerId: 'owner-1',
  ownerKey: 'luqui10:luqui10',
  ownerLabel: 'Lucas10',
  pagina: 'RdA',
  status: 'connected',
  runtimeSessionId: 'RdA-luqui10_luqui10',
  phoneE164: '+5493516549344',
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

function buildRecheck(overrides: Partial<WhatsappQrRecheckQueueRecord> = {}): WhatsappQrRecheckQueueRecord {
  return {
    id: 'recheck-1',
    ownerId: 'owner-1',
    sessionId: 'session-1',
    monthStart: '2026-07-01',
    phoneE164: '+5493511234567',
    reason: 'technical_error',
    status: 'pending',
    attempts: 0,
    nextRunAt: '2026-07-06T12:00:00.000Z',
    expiresAt: '2026-07-13T12:00:00.000Z',
    lastError: null,
    createdAt: '2026-07-06T12:00:00.000Z',
    updatedAt: '2026-07-06T12:00:00.000Z',
    ...overrides
  };
}

function buildMatch(overrides: Partial<WhatsappQrMatchRecord> = {}): WhatsappQrMatchRecord {
  return {
    id: 'match-1',
    sessionId: 'session-1',
    ownerId: 'owner-1',
    messageId: 'message-1',
    pagina: 'RdA',
    clientPhoneE164: '+5493511234567',
    username: 'player_123',
    source: 'outbound_message',
    status: 'error',
    platformValidatedAt: null,
    assignedAt: null,
    errorMessage: 'Could not refresh owner monthly facts',
    createdAt: '2026-07-06T12:00:00.000Z',
    updatedAt: '2026-07-06T12:00:00.000Z',
    ...overrides
  };
}

describe('WhatsappQrRecheckWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-06T12:05:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries an existing technical-error match without creating duplicate matches', async () => {
    const recheck = buildRecheck();
    const match = buildMatch();
    const updateRecheck = vi.fn(async (_id: string, patch: Partial<WhatsappQrRecheckQueueRecord>) => ({
      ...recheck,
      ...patch
    }));
    const updateMatch = vi.fn(async (_id: string, patch: Partial<WhatsappQrMatchRecord>) => ({
      ...match,
      ...patch
    }));
    const assignUsernameByPhoneFromQr = vi.fn(async () => ({
      previousUsername: null,
      currentUsername: 'player_123',
      overwritten: false,
      createdClient: false,
      createdLink: false,
      movedFromPhone: null,
      deletedOldPhone: false
    }));

    const store = {
      listDueRechecks: vi.fn(async () => [recheck]),
      getSessionByOwner: vi.fn(async () => session),
      listMonthClients: vi.fn(async () => [
        {
          clientId: 'client-1',
          linkId: 'link-1',
          phoneE164: '+5493511234567',
          assignedUsername: null
        }
      ]),
      listContactsByPhones: vi.fn(async () => []),
      listMessagesForMonth: vi.fn(async () => []),
      listMatchesForMonth: vi.fn(async () => [match]),
      getPlatformCredential: vi.fn(async () => ({
        ownerId: 'owner-1',
        ownerKey: 'luqui10:luqui10',
        pagina: 'RdA',
        loginUsername: 'agente',
        loginPassword: 'clave',
        source: 'n8n',
        sourceRef: null,
        syncedAt: '2026-07-06T12:00:00.000Z'
      })),
      updateMatch,
      updateRecheck
    };

    const worker = new WhatsappQrRecheckWorker(
      store as any,
      { assignUsernameByPhoneFromQr } as any,
      vi.fn(async () => undefined),
      appConfig,
      logger,
      { pollMs: 60_000, batchSize: 10, runOnStart: false }
    );

    await worker.pump();

    expect(assignUsernameByPhoneFromQr).toHaveBeenCalledWith(
      expect.objectContaining({
        pagina: 'RdA',
        jugadorUsername: 'player_123',
        telefono: '+5493511234567'
      })
    );
    expect(updateMatch).toHaveBeenCalledWith('match-1', expect.objectContaining({ status: 'assigned' }));
    expect(updateRecheck).toHaveBeenCalledWith('recheck-1', expect.objectContaining({ status: 'done', attempts: 1 }));
  });

  it('expires stale recheck rows without touching assignment services', async () => {
    const recheck = buildRecheck({ expiresAt: '2026-07-01T12:00:00.000Z' });
    const updateRecheck = vi.fn(async (_id: string, patch: Partial<WhatsappQrRecheckQueueRecord>) => ({
      ...recheck,
      ...patch
    }));
    const assignUsernameByPhoneFromQr = vi.fn();
    const store = {
      listDueRechecks: vi.fn(async () => [recheck]),
      updateRecheck
    };
    const worker = new WhatsappQrRecheckWorker(
      store as any,
      { assignUsernameByPhoneFromQr } as any,
      vi.fn(async () => undefined),
      appConfig,
      logger,
      { pollMs: 60_000, batchSize: 10, runOnStart: false }
    );

    await worker.pump();

    expect(updateRecheck).toHaveBeenCalledWith('recheck-1', expect.objectContaining({ status: 'expired', attempts: 1 }));
    expect(assignUsernameByPhoneFromQr).not.toHaveBeenCalled();
  });

  it('closes rechecks for phones that are not September portfolio clients', async () => {
    const recheck = buildRecheck({ monthStart: '2026-09-01' });
    const updateRecheck = vi.fn(async (_id: string, patch: Partial<WhatsappQrRecheckQueueRecord>) => ({
      ...recheck,
      ...patch
    }));
    const assignUsernameByPhoneFromQr = vi.fn();
    const store = {
      listDueRechecks: vi.fn(async () => [recheck]),
      getSessionByOwner: vi.fn(async () => session),
      listMonthClients: vi.fn(async () => []),
      listContactsByPhones: vi.fn(async () => []),
      listMessagesForMonth: vi.fn(async () => []),
      listMatchesForMonth: vi.fn(async () => []),
      updateRecheck
    };

    const worker = new WhatsappQrRecheckWorker(
      store as any,
      { assignUsernameByPhoneFromQr } as any,
      vi.fn(),
      appConfig,
      logger,
      { pollMs: 60_000, batchSize: 10, runOnStart: false }
    );

    await worker.pump();

    expect(updateRecheck).toHaveBeenCalledWith(
      'recheck-1',
      expect.objectContaining({ status: 'done', lastError: 'phone_not_in_month_portfolio' })
    );
    expect(assignUsernameByPhoneFromQr).not.toHaveBeenCalled();
  });

  it('uses the secondary ASN route instead of the physical RdA session during rechecks', async () => {
    const recheck = buildRecheck({ ownerId: 'owner-asn' });
    const match = buildMatch({ ownerId: 'owner-asn', pagina: 'ASN' });
    const updateRecheck = vi.fn(async (_id: string, patch: Partial<WhatsappQrRecheckQueueRecord>) => ({ ...recheck, ...patch }));
    const updateMatch = vi.fn(async (_id: string, patch: Partial<WhatsappQrMatchRecord>) => ({ ...match, ...patch }));
    const assignUsernameByPhoneFromQr = vi.fn(async () => ({}));
    const asnUserExistsChecker = vi.fn(async () => undefined);
    const store = {
      listDueRechecks: vi.fn(async () => [recheck]),
      getSessionByOwner: vi.fn(async () => session),
      listSessionRoutes: vi.fn(async () => [
        {
          id: 'route-asn',
          sessionId: session.id,
          ownerId: 'owner-asn',
          ownerKey: 'asnlucas10:lucas10',
          ownerLabel: 'Lucas10',
          pagina: 'ASN',
          status: 'active',
          isPrimary: false,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        }
      ]),
      listMonthClients: vi.fn(async () => [{ clientId: 'client-asn', linkId: 'link-asn', phoneE164: recheck.phoneE164, assignedUsername: null }]),
      listContactsByPhones: vi.fn(async () => []),
      listMessagesForMonth: vi.fn(async () => []),
      listMatchesForMonth: vi.fn(async () => [match]),
      getPlatformCredential: vi.fn(async () => ({
        ownerId: 'owner-asn', ownerKey: 'asnlucas10:lucas10', pagina: 'ASN',
        loginUsername: 'asn-agent', loginPassword: 'asn-password', source: 'test', sourceRef: null, syncedAt: session.updatedAt
      })),
      updateMatch,
      updateRecheck
    };
    const worker = new WhatsappQrRecheckWorker(
      store as any,
      { assignUsernameByPhoneFromQr } as any,
      vi.fn(async () => { throw new Error('RdA validator must not run'); }),
      appConfig,
      logger,
      { pollMs: 60_000, batchSize: 10, runOnStart: false },
      asnUserExistsChecker
    );

    await worker.pump();

    expect(asnUserExistsChecker).toHaveBeenCalledTimes(1);
    expect(assignUsernameByPhoneFromQr).toHaveBeenCalledWith(expect.objectContaining({ pagina: 'ASN', ownerContext: expect.objectContaining({ ownerKey: 'asnlucas10:lucas10' }) }));
    expect(updateRecheck).toHaveBeenCalledWith('recheck-1', expect.objectContaining({ status: 'done' }));
  });
});
