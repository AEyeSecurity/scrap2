import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsappQrManager } from '../src/whatsapp-qr-manager';
import { resolveMessageRemoteJid } from '../src/whatsapp-qr-parser';
import type { WhatsappQrOwner, WhatsappQrSessionRecord } from '../src/whatsapp-qr-store';

const owner: WhatsappQrOwner = {
  ownerId: 'owner-1',
  ownerKey: 'luqui10:luqui10',
  ownerLabel: 'Luqui10',
  pagina: 'RdA'
};

const PHONE_JID = '5493511111111@s.whatsapp.net';
const PHONE_E164 = '+5493511111111';
const NOW_ISO = new Date().toISOString();
const OLD_ISO = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();

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
    lastHeartbeatAt: NOW_ISO,
    lastConnectedAt: NOW_ISO,
    lastDisconnectedAt: null,
    lastError: null,
    botGroupKey: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
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
let activeManager: WhatsappQrManager | null = null;

afterEach(async () => {
  if (activeManager) {
    await activeManager.stop();
    activeManager = null;
  }
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
    tempRootDir = null;
  }
});

describe('resolveMessageRemoteJid', () => {
  it('passes through phone JIDs', () => {
    expect(resolveMessageRemoteJid({ remoteJid: PHONE_JID })).toBe(PHONE_JID);
  });

  it('uses remoteJidAlt for @lid chats', () => {
    expect(resolveMessageRemoteJid({ remoteJid: '123456789@lid', remoteJidAlt: PHONE_JID })).toBe(PHONE_JID);
  });

  it('returns null for @lid without a usable alt', () => {
    expect(resolveMessageRemoteJid({ remoteJid: '123456789@lid' })).toBeNull();
    expect(resolveMessageRemoteJid({ remoteJid: '123456789@lid', remoteJidAlt: '999@lid' })).toBeNull();
  });
});

interface Harness {
  handlers: any;
  store: Record<string, ReturnType<typeof vi.fn>>;
  processMessage: ReturnType<typeof vi.fn>;
  intakePendingCliente: ReturnType<typeof vi.fn>;
}

async function startManager(storeOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const connected = buildSession('session-connected', 'connected');
  tempRootDir = await mkdtemp(join(tmpdir(), 'qr-gate-'));
  const sessionDir = join(tempRootDir, connected.runtimeSessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'creds.json'), '{"noiseKey":{}}');

  let handlers: any = null;
  const runtimeStart = vi.fn(async (_owner: unknown, _id: unknown, h: unknown) => {
    handlers = h;
    return { stop: vi.fn(async () => undefined) };
  });
  const processMessage = vi.fn(async () => ({ message: null, match: null }));
  const intakePendingCliente = vi.fn(async () => ({
    cajeroId: 'c',
    jugadorId: 'j',
    linkId: 'l',
    estado: 'pending',
    ownerId: owner.ownerId
  }));

  const store: Record<string, ReturnType<typeof vi.fn>> = {
    listReconnectableSessions: vi.fn(async () => [connected]),
    updateSession: vi.fn(async (_id: string, patch: Partial<WhatsappQrSessionRecord>) => ({ ...connected, ...patch })),
    listSessions: vi.fn(async () => []),
    listMatches: vi.fn(async () => []),
    listCredentialOwnerIds: vi.fn(async () => new Set<string>()),
    listStaleSessions: vi.fn(async () => []),
    markAlerted: vi.fn(),
    upsertContact: vi.fn(async () => ({})),
    listContactsByPhones: vi.fn(async () => []),
    listIgnoredPhonesForMonth: vi.fn(async () => new Set<string>()),
    recordChatMessage: vi.fn(async (input: { messageAt: string; direction: string }) => ({
      firstMessageAt: input.messageAt,
      firstMessageDirection: input.direction,
      intakeRecordedAt: null
    })),
    markIntakeRecorded: vi.fn(async () => NOW_ISO),
    getLatestBackfillRun: vi.fn(async () => null),
    createBackfillRun: vi.fn(async () => ({ id: 'run-1' })),
    ...(storeOverrides as Record<string, ReturnType<typeof vi.fn>>)
  };

  const manager = new WhatsappQrManager({
    store: store as any,
    autoAssignService: { processMessage } as any,
    playerPhoneStore: { intakePendingCliente } as any,
    telegramAlerts: { send: vi.fn(async () => undefined) } as any,
    logger: createLogger() as any,
    runtime: { start: runtimeStart },
    authRootDir: tempRootDir,
    alertPollMs: 60_000
  });
  await manager.start();
  activeManager = manager;
  expect(handlers).not.toBeNull();
  return { handlers, store, processMessage, intakePendingCliente };
}

describe('WhatsappQrManager month gate + intake', () => {
  it('processes current-month chats and records the intake once', async () => {
    const { handlers, store, processMessage, intakePendingCliente } = await startManager();

    await handlers.onMessage({ direction: 'inbound', remoteJid: PHONE_JID, messageTimestamp: NOW_ISO, text: 'hola' });
    await handlers.onMessage({ direction: 'outbound', remoteJid: PHONE_JID, messageTimestamp: NOW_ISO, text: 'Usuario: juan123' });

    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(processMessage).toHaveBeenCalledWith(expect.objectContaining({ clientPhoneE164: PHONE_E164 }));
    expect(intakePendingCliente).toHaveBeenCalledTimes(1);
    expect(intakePendingCliente).toHaveBeenCalledWith(
      expect.objectContaining({
        pagina: 'RdA',
        telefono: PHONE_E164,
        sourceContext: expect.objectContaining({ receivedAt: NOW_ISO })
      })
    );
    expect(store.markIntakeRecorded).toHaveBeenCalledTimes(1);
  });

  it('skips chats whose first message is from a previous month', async () => {
    const { handlers, processMessage, intakePendingCliente } = await startManager({
      recordChatMessage: vi.fn(async () => ({
        firstMessageAt: OLD_ISO,
        firstMessageDirection: 'inbound',
        intakeRecordedAt: null
      }))
    });

    await handlers.onMessage({ direction: 'inbound', remoteJid: PHONE_JID, messageTimestamp: NOW_ISO, text: 'hola' });

    expect(processMessage).not.toHaveBeenCalled();
    expect(intakePendingCliente).not.toHaveBeenCalled();
  });

  it('does not record intake for outbound-first or ignored chats', async () => {
    const outboundFirst = await startManager();
    await outboundFirst.handlers.onMessage({
      direction: 'outbound',
      remoteJid: PHONE_JID,
      messageTimestamp: NOW_ISO,
      text: 'hola'
    });
    expect(outboundFirst.processMessage).toHaveBeenCalledTimes(1);
    expect(outboundFirst.intakePendingCliente).not.toHaveBeenCalled();
    await activeManager!.stop();
    activeManager = null;
    await rm(tempRootDir!, { recursive: true, force: true });
    tempRootDir = null;

    const ignored = await startManager({
      listIgnoredPhonesForMonth: vi.fn(async () => new Set([PHONE_E164]))
    });
    await ignored.handlers.onMessage({ direction: 'inbound', remoteJid: PHONE_JID, messageTimestamp: NOW_ISO, text: 'hola' });
    expect(ignored.processMessage).toHaveBeenCalledTimes(1);
    expect(ignored.intakePendingCliente).not.toHaveBeenCalled();
  });

  it('gates contact_sync by the persisted first message month', async () => {
    const withState = await startManager({
      listContactsByPhones: vi.fn(async () => [
        {
          phoneE164: PHONE_E164,
          firstMessageAt: NOW_ISO,
          firstMessageDirection: 'inbound',
          intakeRecordedAt: NOW_ISO
        }
      ])
    });
    await withState.handlers.onContact({ remoteJid: PHONE_JID, contactName: 'juan123' });
    expect(withState.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'contact_sync', clientPhoneE164: PHONE_E164, contactName: 'juan123' })
    );
    expect(withState.intakePendingCliente).not.toHaveBeenCalled();
    await activeManager!.stop();
    activeManager = null;
    await rm(tempRootDir!, { recursive: true, force: true });
    tempRootDir = null;

    const withoutState = await startManager();
    await withoutState.handlers.onContact({ remoteJid: PHONE_JID, contactName: 'juan123' });
    expect(withoutState.store.upsertContact).toHaveBeenCalled();
    expect(withoutState.processMessage).not.toHaveBeenCalled();
  });
});
