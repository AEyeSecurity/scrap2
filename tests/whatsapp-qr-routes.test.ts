import { describe, expect, it, vi } from 'vitest';
import { buildAppConfig } from '../src/config';
import { createLogger } from '../src/logging';
import { issueMastercrmSessionToken } from '../src/mastercrm-session';
import { createServer } from '../src/server';
import type { JobRequest, JobStoreEntry } from '../src/types';

const MASTERCRM_TEST_SESSION_SECRET = 'whatsapp-qr-route-session-secret-32';

class FakeQueue {
  enqueue(_request: JobRequest): string {
    return 'job-1';
  }

  getById(_id: string): JobStoreEntry | undefined {
    return undefined;
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}

async function withEnv<T>(values: Record<string, string | undefined>, callback: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function authHeader(userId: number, username: string): { authorization: string } {
  const session = issueMastercrmSessionToken(
    {
      id: userId,
      username,
      nombre: username,
      telefono: null,
      inversion: 0,
      isActive: true,
      createdAt: '2026-06-30T00:00:00.000Z'
    },
    MASTERCRM_TEST_SESSION_SECRET
  );

  return { authorization: `Bearer ${session.token}` };
}

function buildApp(overrides: Record<string, unknown> = {}) {
  const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
  const logger = createLogger('silent', false);
  const users = new Map([
    [
      1,
      {
        id: 1,
        username: 'juan',
        nombre: 'Juan',
        telefono: null,
        inversion: 0,
        isActive: true,
        createdAt: '2026-06-30T00:00:00.000Z'
      }
    ],
    [
      2,
      {
        id: 2,
        username: 'luqui',
        nombre: 'Luqui',
        telefono: null,
        inversion: 0,
        isActive: true,
        createdAt: '2026-06-30T00:00:00.000Z'
      }
    ]
  ]);
  const linkedOwners = new Map([
    [
      1,
      {
        ownerId: 'owner-juan',
        ownerKey: 'juan:juan',
        ownerLabel: 'Juan',
        pagina: 'RdA',
        telefono: '+5493511111111'
      }
    ],
    [
      2,
      {
        ownerId: 'owner-admin',
        ownerKey: 'luqui10:luqui10',
        ownerLabel: 'Luqui10',
        pagina: 'RdA',
        telefono: '+5493512222222'
      }
    ]
  ]);

  const whatsappQrManager = {
    start: vi.fn(async () => undefined),
    getDashboard: vi.fn(async (owner, isAdmin) => ({
      isAdmin,
      runtimeEnabled: true,
      sessions: [
        {
          id: 'session-1',
          ownerId: owner.ownerId,
          ownerKey: owner.ownerKey,
          ownerLabel: owner.ownerLabel,
          pagina: owner.pagina,
          status: 'connected',
          runtimeSessionId: 'runtime-1',
          phoneE164: '+5493513333333',
          qrPayload: null,
          qrDataUrl: null,
          qrExpiresAt: null,
          lastHeartbeatAt: '2026-06-30T12:00:00.000Z',
          lastConnectedAt: '2026-06-30T12:00:00.000Z',
          lastDisconnectedAt: null,
          lastError: null,
          botGroupKey: null,
          createdAt: '2026-06-30T12:00:00.000Z',
          updatedAt: '2026-06-30T12:00:00.000Z',
          hasRdaCredentials: true
        }
      ],
      matches: []
    })),
    connect: vi.fn(async (owner) => ({
      id: 'session-connect',
      ownerId: owner.ownerId,
      ownerKey: owner.ownerKey,
      ownerLabel: owner.ownerLabel,
      pagina: owner.pagina,
      status: 'waiting_qr',
      runtimeSessionId: 'runtime-connect',
      phoneE164: null,
      qrPayload: 'raw',
      qrDataUrl: 'data:image/png;base64,qr',
      qrExpiresAt: '2026-06-30T12:01:00.000Z',
      lastHeartbeatAt: '2026-06-30T12:00:00.000Z',
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastError: null,
      botGroupKey: null,
      createdAt: '2026-06-30T12:00:00.000Z',
      updatedAt: '2026-06-30T12:00:00.000Z'
    })),
    disconnect: vi.fn(async (owner) => ({
      id: 'session-disconnect',
      ownerId: owner.ownerId,
      ownerKey: owner.ownerKey,
      ownerLabel: owner.ownerLabel,
      pagina: owner.pagina,
      status: 'disconnected',
      runtimeSessionId: 'runtime-disconnect',
      phoneE164: null,
      qrPayload: null,
      qrDataUrl: null,
      qrExpiresAt: null,
      lastHeartbeatAt: '2026-06-30T12:00:00.000Z',
      lastConnectedAt: null,
      lastDisconnectedAt: '2026-06-30T12:00:00.000Z',
      lastError: null,
      botGroupKey: null,
      createdAt: '2026-06-30T12:00:00.000Z',
      updatedAt: '2026-06-30T12:00:00.000Z'
    })),
    stop: vi.fn(async () => undefined)
  };

  const app = createServer(appConfig, { host: '127.0.0.1', port: 0, loginConcurrency: 1, jobTtlMinutes: 10 }, logger, new FakeQueue(), {
    mastercrmSessionSecret: MASTERCRM_TEST_SESSION_SECRET,
    mastercrmUserStore: {
      getActiveUserById: vi.fn(async (id: number) => users.get(id)),
      getLinkedOwnerForUser: vi.fn(async (id: number) => linkedOwners.get(id) ?? null)
    } as any,
    whatsappQrStore: {
      getSessionByOwner: vi.fn(async (ownerId: string) => ({
        id: 'session-target',
        ownerId,
        ownerKey: 'otro:otro',
        ownerLabel: 'Otro',
        pagina: 'RdA',
        status: 'connected',
        runtimeSessionId: 'runtime-target',
        phoneE164: '+5493514444444',
        qrPayload: null,
        qrDataUrl: null,
        qrExpiresAt: null,
        lastHeartbeatAt: '2026-06-30T12:00:00.000Z',
        lastConnectedAt: '2026-06-30T12:00:00.000Z',
        lastDisconnectedAt: null,
        lastError: null,
        botGroupKey: null,
        createdAt: '2026-06-30T12:00:00.000Z',
        updatedAt: '2026-06-30T12:00:00.000Z'
      }))
    } as any,
    whatsappQrManager: (overrides.whatsappQrManager as any) ?? (whatsappQrManager as any)
  });

  return { app, whatsappQrManager };
}

describe('WhatsApp QR CRM routes', () => {
  it('returns a non-admin dashboard for a regular linked cashier', async () => {
    await withEnv({ MASTERCRM_QR_ADMIN_OWNER_KEYS: 'luqui10:luqui10' }, async () => {
      const { app, whatsappQrManager } = buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/mastercrm-whatsapp-qr/status',
        headers: authHeader(1, 'juan'),
        payload: { user_id: 1 }
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        isAdmin: false,
        linkedOwner: { ownerId: 'owner-juan', ownerKey: 'juan:juan' },
        sessions: [{ ownerId: 'owner-juan' }]
      });
      expect(body.sessions[0]).not.toHaveProperty('qrPayload');
      expect(whatsappQrManager.getDashboard).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-juan' }),
        false
      );
      expect(whatsappQrManager.start).toHaveBeenCalledTimes(1);
    });
  });

  it('enables admin dashboard access by owner allowlist', async () => {
    await withEnv({ MASTERCRM_QR_ADMIN_OWNER_KEYS: 'luqui10:luqui10' }, async () => {
      const { app, whatsappQrManager } = buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/mastercrm-whatsapp-qr/status',
        headers: authHeader(2, 'luqui'),
        payload: { user_id: 2 }
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      expect(response.json().isAdmin).toBe(true);
      expect(whatsappQrManager.getDashboard).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-admin' }),
        true
      );
    });
  });

  it('blocks a regular cashier from disconnecting another owner session', async () => {
    await withEnv({ MASTERCRM_QR_ADMIN_OWNER_KEYS: 'luqui10:luqui10' }, async () => {
      const { app, whatsappQrManager } = buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/mastercrm-whatsapp-qr/disconnect',
        headers: authHeader(1, 'juan'),
        payload: { user_id: 1, owner_id: 'owner-other' }
      });
      await app.close();

      expect(response.statusCode).toBe(403);
      expect(whatsappQrManager.disconnect).not.toHaveBeenCalled();
    });
  });
});
