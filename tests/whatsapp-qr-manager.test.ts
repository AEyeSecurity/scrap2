import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWhatsappQrRuntimeFromEnv, WhatsappQrManager } from '../src/whatsapp-qr-manager';
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

describe('WhatsappQrManager runtime hardening', () => {
  it('does not reject heartbeat when Supabase heartbeat update fails', async () => {
    const session = buildSession('session-connected', 'connected');
    let handlers: any = null;
    const logger = createLogger();
    const touchSessionHeartbeat = vi.fn(async () => {
      throw new Error('exceed_egress_quota');
    });

    const manager = new WhatsappQrManager({
      store: {
        upsertSession: vi.fn(async () => session),
        updateSession: vi.fn(),
        touchSessionHeartbeat
      } as any,
      autoAssignService: { processMessage: vi.fn() } as any,
      playerPhoneStore: { intakePendingCliente: vi.fn() } as any,
      telegramAlerts: { send: vi.fn(async () => undefined) } as any,
      logger: logger as any,
      runtime: {
        start: vi.fn(async (_owner, _runtimeSessionId, runtimeHandlers) => {
          handlers = runtimeHandlers;
          return { stop: vi.fn(async () => undefined) };
        })
      },
      alertPollMs: 60_000
    });

    await manager.connect(owner);

    await expect(handlers.onHeartbeat()).resolves.toBeUndefined();
    expect(touchSessionHeartbeat).toHaveBeenCalledWith(session.id, expect.any(String));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error), ownerKey: owner.ownerKey, sessionId: session.id }),
      'WhatsApp QR heartbeat update failed'
    );
  });

  it('does not reject contact processing when Supabase contact persistence fails', async () => {
    const session = buildSession('session-connected', 'connected');
    let handlers: any = null;
    const logger = createLogger();

    const manager = new WhatsappQrManager({
      store: {
        upsertSession: vi.fn(async () => session),
        updateSession: vi.fn(),
        upsertContact: vi.fn(async () => {
          throw new Error('exceed_egress_quota');
        })
      } as any,
      autoAssignService: { processMessage: vi.fn() } as any,
      playerPhoneStore: { intakePendingCliente: vi.fn() } as any,
      telegramAlerts: { send: vi.fn(async () => undefined) } as any,
      logger: logger as any,
      runtime: {
        start: vi.fn(async (_owner, _runtimeSessionId, runtimeHandlers) => {
          handlers = runtimeHandlers;
          return { stop: vi.fn(async () => undefined) };
        })
      },
      alertPollMs: 60_000
    });

    await manager.connect(owner);

    await expect(
      handlers.onContact({
        remoteJid: '5493516549344@s.whatsapp.net',
        clientPhoneE164: '+5493516549344',
        contactName: 'Cliente Test'
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error), ownerKey: owner.ownerKey, sessionId: session.id }),
      'WhatsApp QR contact processing failed'
    );
  });

  it('uses WHATSAPP_QR_SYNC_FULL_HISTORY=false by default for Baileys runtime', async () => {
    const previousRuntime = process.env.WHATSAPP_QR_RUNTIME;
    const previousSync = process.env.WHATSAPP_QR_SYNC_FULL_HISTORY;
    const previousAuthDir = process.env.WHATSAPP_QR_AUTH_DIR;
    const baileysDefault = vi.fn(() => ({
      ev: { on: vi.fn() },
      end: vi.fn(),
      ws: { close: vi.fn() }
    }));
    vi.doMock('@whiskeysockets/baileys', () => ({
      default: baileysDefault,
      useMultiFileAuthState: vi.fn(async () => ({ state: {}, saveCreds: vi.fn() })),
      DisconnectReason: { loggedOut: 401 }
    }));

    try {
      process.env.WHATSAPP_QR_RUNTIME = 'baileys';
      delete process.env.WHATSAPP_QR_SYNC_FULL_HISTORY;
      tempRootDir = await mkdtemp(join(tmpdir(), 'qr-runtime-'));
      process.env.WHATSAPP_QR_AUTH_DIR = tempRootDir;
      const runtime = buildWhatsappQrRuntimeFromEnv(createLogger() as any);
      await runtime.start(
        owner,
        'session-env',
        {
          onQr: vi.fn(),
          onConnected: vi.fn(),
          onDisconnected: vi.fn(),
          onHeartbeat: vi.fn(),
          onMessage: vi.fn(),
          onContact: vi.fn()
        },
        { resumeOnly: true }
      );

      const config = baileysDefault.mock.calls[0][0];
      expect(config.syncFullHistory).toBe(false);
      expect(config.shouldSyncHistoryMessage).toBeUndefined();
    } finally {
      if (previousRuntime === undefined) delete process.env.WHATSAPP_QR_RUNTIME;
      else process.env.WHATSAPP_QR_RUNTIME = previousRuntime;
      if (previousSync === undefined) delete process.env.WHATSAPP_QR_SYNC_FULL_HISTORY;
      else process.env.WHATSAPP_QR_SYNC_FULL_HISTORY = previousSync;
      if (previousAuthDir === undefined) delete process.env.WHATSAPP_QR_AUTH_DIR;
      else process.env.WHATSAPP_QR_AUTH_DIR = previousAuthDir;
      vi.doUnmock('@whiskeysockets/baileys');
    }
  });
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
