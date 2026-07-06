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
      summary: {
        totalPhones: 3,
        assigned: 2,
        review: 1,
        ignored: 0,
        noSignal: 0,
        detectedUnassigned: 1,
        notFound: 0,
        conflict: 0,
        technicalError: 0
      },
      queue: [
        {
          clientId: 'client-1',
          linkId: 'link-1',
          phoneE164: '+5493515555555',
          status: 'review',
          reviewReason: 'detected_unassigned',
          assignedUsername: null,
          suggestedUsername: 'player_123',
          contactCandidateUsername: 'player_123',
          outboundCandidateUsername: null,
          primarySignalSource: 'contact_name',
          lastSignalAt: '2026-06-30T12:00:00.000Z',
          lastAttemptAt: '2026-06-30T12:00:00.000Z',
          lastError: null
        }
      ]
    })),
    getAdminOverview: vi.fn(async (owner) => ({
      isAdmin: true,
      runtimeEnabled: true,
      sessions: [
        {
          id: 'session-admin',
          ownerId: owner.ownerId,
          ownerKey: owner.ownerKey,
          ownerLabel: owner.ownerLabel,
          pagina: owner.pagina,
          status: 'connected',
          runtimeSessionId: 'runtime-admin',
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
        },
        {
          id: 'session-lea',
          ownerId: 'owner-lea',
          ownerKey: 'luqui10:lear',
          ownerLabel: 'Lea Riqueza',
          pagina: 'RdA',
          status: 'connected',
          runtimeSessionId: 'runtime-lea',
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
          updatedAt: '2026-06-30T12:00:00.000Z',
          hasRdaCredentials: false
        }
      ],
      summary: {
        totalPhones: 4,
        assigned: 2,
        review: 2,
        ignored: 0,
        noSignal: 1,
        detectedUnassigned: 1,
        notFound: 0,
        conflict: 0,
        technicalError: 0
      },
      queue: [],
      ownerSummaries: [
        {
          owner,
          session: null,
          summary: {
            totalPhones: 3,
            assigned: 2,
            review: 1,
            ignored: 0,
            noSignal: 0,
            detectedUnassigned: 1,
            notFound: 0,
            conflict: 0,
            technicalError: 0
          }
        }
      ]
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
    playerPhoneStore: (overrides.playerPhoneStore as any) ?? ({
      assignUsernameByPhone: vi.fn(async () => ({
        previousUsername: null,
        currentUsername: 'player_123',
        overwritten: false,
        createdClient: false,
        createdLink: false,
        movedFromPhone: null,
        deletedOldPhone: false
      }))
    } as any),
    whatsappQrStore: (overrides.whatsappQrStore as any) ?? ({
      getRdaCredential: vi.fn(async () => ({
        ownerId: 'owner-admin',
        ownerKey: 'luqui10:luqui10',
        pagina: 'RdA',
        loginUsername: 'agente',
        loginPassword: 'clave',
        source: 'n8n',
        sourceRef: 'fixture',
        syncedAt: '2026-06-30T12:00:00.000Z'
      })),
      ignorePhoneForMonth: vi.fn(async () => undefined),
      listSessions: vi.fn(async (ownerIds?: string[] | null) => {
        const rows = [
          {
            id: 'session-admin',
            ownerId: 'owner-admin',
            ownerKey: 'luqui10:luqui10',
            ownerLabel: 'Luqui10',
            pagina: 'RdA',
            status: 'connected',
            runtimeSessionId: 'runtime-admin',
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
            updatedAt: '2026-06-30T12:00:00.000Z'
          },
          {
            id: 'session-lea',
            ownerId: 'owner-lea',
            ownerKey: 'luqui10:lear',
            ownerLabel: 'Lea Riqueza',
            pagina: 'RdA',
            status: 'connected',
            runtimeSessionId: 'runtime-lea',
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
          }
        ];
        return ownerIds && ownerIds.length > 0 ? rows.filter((row) => ownerIds.includes(row.ownerId)) : rows;
      }),
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
    } as any),
    whatsappQrManager: (overrides.whatsappQrManager as any) ?? (whatsappQrManager as any),
    rdaUserExistsChecker: (overrides.rdaUserExistsChecker as any) ?? (vi.fn(async () => undefined) as any)
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
        payload: { user_id: 1, month: '2026-07' }
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        isAdmin: false,
        linkedOwner: { ownerId: 'owner-juan', ownerKey: 'juan:juan' },
        sessions: [{ ownerId: 'owner-juan' }],
        summary: { totalPhones: 3, review: 1 },
        queue: [{ phoneE164: '+5493515555555', status: 'review' }]
      });
      expect(body.sessions[0]).not.toHaveProperty('qrPayload');
      expect(whatsappQrManager.getDashboard).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-juan' }),
        false,
        '2026-07'
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
        payload: { user_id: 2, month: '2026-07' }
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isAdmin).toBe(true);
      expect(body.scope).toBe('own');
      expect(body.sessions).toEqual([expect.objectContaining({ ownerId: 'owner-admin' })]);
      expect(body.availableOwners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ownerId: 'owner-admin' }),
          expect.objectContaining({ ownerId: 'owner-lea' })
        ])
      );
      expect(whatsappQrManager.getDashboard).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-admin' }),
        true,
        '2026-07'
      );
    });
  });

  it('lets QR admins switch to another owner explicitly', async () => {
    await withEnv({ MASTERCRM_QR_ADMIN_OWNER_KEYS: 'luqui10:luqui10' }, async () => {
      const { app, whatsappQrManager } = buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/mastercrm-whatsapp-qr/status',
        headers: authHeader(2, 'luqui'),
        payload: { user_id: 2, month: '2026-07', scope: 'owner', owner_id: 'owner-lea' }
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        scope: 'owner',
        selectedOwner: { ownerId: 'owner-lea', ownerKey: 'luqui10:lear' },
        sessions: [{ ownerId: 'owner-lea' }]
      });
      expect(whatsappQrManager.getDashboard).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-lea', ownerKey: 'luqui10:lear' }),
        true,
        '2026-07'
      );
    });
  });

  it('returns admin overview without a mixed operational queue', async () => {
    await withEnv({ MASTERCRM_QR_ADMIN_OWNER_KEYS: 'luqui10:luqui10' }, async () => {
      const { app, whatsappQrManager } = buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/mastercrm-whatsapp-qr/status',
        headers: authHeader(2, 'luqui'),
        payload: { user_id: 2, month: '2026-07', scope: 'all' }
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        scope: 'all',
        queue: [],
        ownerSummaries: [expect.objectContaining({ owner: expect.objectContaining({ ownerId: 'owner-admin' }) })]
      });
      expect(whatsappQrManager.getAdminOverview).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-admin' }),
        '2026-07'
      );
    });
  });

  it('blocks non-admin QR users from selecting other owners', async () => {
    await withEnv({ MASTERCRM_QR_ADMIN_OWNER_KEYS: 'luqui10:luqui10' }, async () => {
      const { app, whatsappQrManager } = buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/mastercrm-whatsapp-qr/status',
        headers: authHeader(1, 'juan'),
        payload: { user_id: 1, month: '2026-07', scope: 'owner', owner_id: 'owner-lea' }
      });
      await app.close();

      expect(response.statusCode).toBe(403);
      expect(whatsappQrManager.getDashboard).not.toHaveBeenCalled();
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

  it('validates and assigns a reviewed phone inside the QR queue', async () => {
    await withEnv({ MASTERCRM_QR_ADMIN_OWNER_KEYS: 'luqui10:luqui10' }, async () => {
      const assignUsernameByPhone = vi.fn(async () => ({
        previousUsername: null,
        currentUsername: 'player_manual',
        overwritten: false,
        createdClient: false,
        createdLink: false,
        movedFromPhone: null,
        deletedOldPhone: false
      }));
      const rdaUserExistsChecker = vi.fn(async () => undefined);
      const whatsappQrManager = {
        start: vi.fn(async () => undefined),
        getDashboard: vi.fn(async (_owner, isAdmin, month) => ({
          isAdmin,
          runtimeEnabled: true,
          sessions: [],
          summary: {
            totalPhones: 3,
            assigned: 3,
            review: 0,
            ignored: 0,
            noSignal: 0,
            detectedUnassigned: 0,
            notFound: 0,
            conflict: 0,
            technicalError: 0
          },
          queue: [
            {
              clientId: 'client-1',
              linkId: 'link-1',
              phoneE164: '+5493515555555',
              status: 'assigned',
              reviewReason: null,
              assignedUsername: 'player_manual',
              suggestedUsername: 'player_manual',
              contactCandidateUsername: 'player_manual',
              outboundCandidateUsername: null,
              primarySignalSource: 'contact_name',
              lastSignalAt: '2026-07-01T12:00:00.000Z',
              lastAttemptAt: '2026-07-01T12:05:00.000Z',
              lastError: null,
              month
            }
          ]
        })),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      };

      const { app } = buildApp({
        playerPhoneStore: { assignUsernameByPhone },
        rdaUserExistsChecker,
        whatsappQrManager
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mastercrm-whatsapp-qr/assign',
        headers: authHeader(2, 'luqui'),
        payload: {
          user_id: 2,
          month: '2026-07',
          phone_e164: '+5493515555555',
          username: 'player_manual'
        }
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      expect(rdaUserExistsChecker).toHaveBeenCalledWith(
        expect.objectContaining({
          usuario: 'player_manual',
          agente: 'agente',
          contrasenaAgente: 'clave'
        })
      );
      expect(assignUsernameByPhone).toHaveBeenCalledWith(
        expect.objectContaining({
          pagina: 'RdA',
          jugadorUsername: 'player_manual',
          telefono: '+5493515555555',
          ownerContext: expect.objectContaining({ ownerKey: 'luqui10:luqui10' })
        })
      );
      expect(whatsappQrManager.getDashboard).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-admin' }),
        true,
        '2026-07'
      );
      expect(response.json()).toMatchObject({
        row: {
          phoneE164: '+5493515555555',
          status: 'assigned',
          assignedUsername: 'player_manual'
        },
        summary: {
          assigned: 3
        }
      });
    });
  });

  it('ignores a reviewed phone inside the QR queue for the selected month', async () => {
    await withEnv({ MASTERCRM_QR_ADMIN_OWNER_KEYS: 'luqui10:luqui10' }, async () => {
      const ignorePhoneForMonth = vi.fn(async () => undefined);
      const whatsappQrManager = {
        start: vi.fn(async () => undefined),
        getDashboard: vi
          .fn()
          .mockResolvedValueOnce({
            isAdmin: true,
            runtimeEnabled: true,
            sessions: [],
            summary: {
              totalPhones: 3,
              assigned: 2,
              review: 1,
              ignored: 0,
              noSignal: 0,
              detectedUnassigned: 1,
              notFound: 0,
              conflict: 0,
              technicalError: 0
            },
            queue: [
              {
                clientId: 'client-1',
                linkId: 'link-1',
                phoneE164: '+5493515555555',
                status: 'review',
                reviewReason: 'detected_unassigned',
                assignedUsername: null,
                suggestedUsername: 'player_123',
                contactCandidateUsername: 'player_123',
                outboundCandidateUsername: null,
                primarySignalSource: 'contact_name',
                lastSignalAt: '2026-07-01T12:00:00.000Z',
                lastAttemptAt: '2026-07-01T12:00:00.000Z',
                lastError: null
              }
            ]
          })
          .mockResolvedValueOnce({
            isAdmin: true,
            runtimeEnabled: true,
            sessions: [],
            summary: {
              totalPhones: 3,
              assigned: 2,
              review: 0,
              ignored: 1,
              noSignal: 0,
              detectedUnassigned: 0,
              notFound: 0,
              conflict: 0,
              technicalError: 0
            },
            queue: []
          }),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      };

      const { app } = buildApp({
        whatsappQrManager,
        whatsappQrStore: {
          getRdaCredential: vi.fn(async () => ({
            ownerId: 'owner-admin',
            ownerKey: 'luqui10:luqui10',
            pagina: 'RdA',
            loginUsername: 'agente',
            loginPassword: 'clave',
            source: 'n8n',
            sourceRef: 'fixture',
            syncedAt: '2026-06-30T12:00:00.000Z'
          })),
          getSessionByOwner: vi.fn(async () => null),
          ignorePhoneForMonth
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mastercrm-whatsapp-qr/ignore',
        headers: authHeader(2, 'luqui'),
        payload: {
          user_id: 2,
          month: '2026-07',
          phone_e164: '+5493515555555'
        }
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      expect(ignorePhoneForMonth).toHaveBeenCalledWith({
        ownerId: 'owner-admin',
        monthStart: '2026-07-01',
        phoneE164: '+5493515555555',
        ignoredByUserId: 2
      });
      expect(whatsappQrManager.getDashboard).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ ownerId: 'owner-admin' }),
        true,
        '2026-07'
      );
      expect(whatsappQrManager.getDashboard).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ ownerId: 'owner-admin' }),
        true,
        '2026-07'
      );
      expect(response.json()).toMatchObject({
        ignoredPhoneE164: '+5493515555555',
        summary: {
          ignored: 1,
          review: 0
        }
      });
    });
  });
});
