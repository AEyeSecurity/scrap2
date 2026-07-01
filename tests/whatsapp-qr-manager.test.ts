import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsappQrManager } from '../src/whatsapp-qr-manager';
import type { WhatsappQrOwner, WhatsappQrSessionRecord } from '../src/whatsapp-qr-store';

const owner: WhatsappQrOwner = {
  ownerId: 'owner-1',
  ownerKey: 'luqui10:luqui10',
  ownerLabel: 'Luqui10',
  pagina: 'RdA'
};

function buildSession(id: string, status: WhatsappQrSessionRecord['status']): WhatsappQrSessionRecord {
  return {
    id,
    ownerId: owner.ownerId,
    ownerKey: owner.ownerKey,
    ownerLabel: owner.ownerLabel,
    pagina: owner.pagina,
    status,
    runtimeSessionId: `${owner.pagina}-${owner.ownerKey}`.replace(/[^a-zA-Z0-9._-]+/g, '_') + `-${id}`,
    phoneE164: '+5493516549344',
    qrPayload: null,
    qrDataUrl: null,
    qrExpiresAt: null,
    lastHeartbeatAt: '2026-07-01T03:00:00.000Z',
    lastConnectedAt: '2026-07-01T03:00:00.000Z',
    lastDisconnectedAt: null,
    lastError: null,
    botGroupKey: null,
    createdAt: '2026-07-01T03:00:00.000Z',
    updatedAt: '2026-07-01T03:00:00.000Z'
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

let tempRootDir: string | null = null;

afterEach(async () => {
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
    tempRootDir = null;
  }
});

async function createAuthState(session: WhatsappQrSessionRecord): Promise<string> {
  tempRootDir = await mkdtemp(join(tmpdir(), 'qr-manager-'));
  const sessionDir = join(tempRootDir, session.runtimeSessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'creds.json'), '{"noiseKey":{}}');
  return tempRootDir;
}

describe('WhatsappQrManager startup reattach', () => {
  it('reattaches only connected sessions on boot', async () => {
    const connected = buildSession('session-connected', 'connected');
    const waiting = buildSession('session-waiting', 'waiting_qr');
    const disconnected = buildSession('session-disconnected', 'disconnected');
    const failed = buildSession('session-error', 'error');
    const authRootDir = await createAuthState(connected);
    const runtimeStop = vi.fn(async () => undefined);
    const runtimeStart = vi.fn(async () => ({ stop: runtimeStop }));

    const manager = new WhatsappQrManager({
      store: {
        listReconnectableSessions: vi.fn(async () => [connected, waiting, disconnected, failed]),
        updateSession: vi.fn(),
        listOwnerClientPhonesForMonth: vi.fn(async () => new Set<string>()),
        listSessions: vi.fn(async () => []),
        listMatches: vi.fn(async () => []),
        listCredentialOwnerIds: vi.fn(async () => new Set<string>()),
        listStaleSessions: vi.fn(async () => []),
        markAlerted: vi.fn()
      } as any,
      autoAssignService: { processMessage: vi.fn() } as any,
      telegramAlerts: { send: vi.fn(async () => undefined) } as any,
      logger: createLogger() as any,
      runtime: { start: runtimeStart },
      authRootDir,
      alertPollMs: 60_000
    });

    await manager.start();
    await manager.stop();

    expect(runtimeStart).toHaveBeenCalledTimes(1);
    expect(runtimeStart).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: owner.ownerId, ownerKey: owner.ownerKey }),
      connected.runtimeSessionId,
      expect.any(Object),
      { resumeOnly: true }
    );
    expect(runtimeStop).toHaveBeenCalledTimes(1);
  });

  it('marks reconnectable sessions as disconnected when auth state is missing', async () => {
    tempRootDir = await mkdtemp(join(tmpdir(), 'qr-manager-'));
    const connected = buildSession('session-connected', 'connected');
    const updateSession = vi.fn(async (_id: string, patch: Partial<WhatsappQrSessionRecord>) => ({
      ...connected,
      ...patch
    }));
    const runtimeStart = vi.fn();

    const manager = new WhatsappQrManager({
      store: {
        listReconnectableSessions: vi.fn(async () => [connected]),
        updateSession,
        listOwnerClientPhonesForMonth: vi.fn(async () => new Set<string>()),
        listSessions: vi.fn(async () => []),
        listMatches: vi.fn(async () => []),
        listCredentialOwnerIds: vi.fn(async () => new Set<string>()),
        listStaleSessions: vi.fn(async () => []),
        markAlerted: vi.fn()
      } as any,
      autoAssignService: { processMessage: vi.fn() } as any,
      telegramAlerts: { send: vi.fn(async () => undefined) } as any,
      logger: createLogger() as any,
      runtime: { start: runtimeStart as any },
      authRootDir: tempRootDir,
      alertPollMs: 60_000
    });

    await manager.start();
    await manager.stop();

    expect(runtimeStart).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      connected.id,
      expect.objectContaining({
        status: 'disconnected',
        lastError: 'qr_auth_state_missing'
      })
    );
  });

  it('marks reconnectable sessions as disconnected when stored auth cannot be resumed', async () => {
    const connected = buildSession('session-connected', 'connected');
    const authRootDir = await createAuthState(connected);
    const updateSession = vi.fn(async (_id: string, patch: Partial<WhatsappQrSessionRecord>) => ({
      ...connected,
      ...patch
    }));

    const manager = new WhatsappQrManager({
      store: {
        listReconnectableSessions: vi.fn(async () => [connected]),
        updateSession,
        listOwnerClientPhonesForMonth: vi.fn(async () => new Set<string>()),
        listSessions: vi.fn(async () => []),
        listMatches: vi.fn(async () => []),
        listCredentialOwnerIds: vi.fn(async () => new Set<string>()),
        listStaleSessions: vi.fn(async () => []),
        markAlerted: vi.fn()
      } as any,
      autoAssignService: { processMessage: vi.fn() } as any,
      telegramAlerts: { send: vi.fn(async () => undefined) } as any,
      logger: createLogger() as any,
      runtime: {
        start: vi.fn(async () => {
          throw new Error('qr_auth_state_invalid');
        })
      },
      authRootDir,
      alertPollMs: 60_000
    });

    await manager.start();
    await manager.stop();

    expect(updateSession).toHaveBeenCalledWith(
      connected.id,
      expect.objectContaining({
        status: 'disconnected',
        lastError: 'qr_auth_state_invalid'
      })
    );
  });
});
