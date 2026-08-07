import { describe, expect, it, vi } from 'vitest';
import { AsnUserCheckError } from '../src/asn-user-check';
import { buildAppConfig } from '../src/config';
import { createLogger } from '../src/logging';
import { WhatsappQrAutoAssignService } from '../src/whatsapp-qr-service';
import { createWhatsappQrStore } from '../src/whatsapp-qr-store';
import type {
  CreateWhatsappQrMatchInput,
  RecordWhatsappQrMessageInput,
  WhatsappQrMatchRecord,
  WhatsappQrMessageRecord,
  WhatsappQrOwner,
  WhatsappQrSessionRecord,
  WhatsappQrStore
} from '../src/whatsapp-qr-store';

const logger = createLogger('silent', false);
const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
const rdaOwner: WhatsappQrOwner = {
  ownerId: 'owner-rda',
  ownerKey: 'luqui10:luqui10',
  ownerLabel: 'Lucas10 RdA',
  pagina: 'RdA'
};
const asnOwner: WhatsappQrOwner = {
  ownerId: 'owner-asn',
  ownerKey: 'asnlucas10:lucas10',
  ownerLabel: 'Lucas10 ASN',
  pagina: 'ASN'
};
const session: WhatsappQrSessionRecord = {
  id: 'session-physical',
  ownerId: rdaOwner.ownerId,
  ownerKey: rdaOwner.ownerKey,
  ownerLabel: rdaOwner.ownerLabel,
  pagina: 'RdA',
  status: 'connected',
  runtimeSessionId: 'RdA-luqui10_luqui10',
  phoneE164: '+5493511111111',
  qrPayload: null,
  qrDataUrl: null,
  qrExpiresAt: null,
  lastHeartbeatAt: null,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
  botGroupKey: null,
  createdAt: '2026-08-07T12:00:00.000Z',
  updatedAt: '2026-08-07T12:00:00.000Z'
};

class SharedRouteStore {
  messages: WhatsappQrMessageRecord[] = [];
  matches: WhatsappQrMatchRecord[] = [];

  async listSessionRoutes() {
    return [
      { id: 'route-rda', sessionId: session.id, ...rdaOwner, status: 'active' as const, isPrimary: true, createdAt: session.createdAt, updatedAt: session.updatedAt },
      { id: 'route-asn', sessionId: session.id, ...asnOwner, status: 'active' as const, isPrimary: false, createdAt: session.createdAt, updatedAt: session.updatedAt }
    ];
  }

  async recordMessage(input: RecordWhatsappQrMessageInput): Promise<WhatsappQrMessageRecord> {
    const replay = input.messageId
      ? this.messages.find((message: any) => message.externalMessageId === input.messageId)
      : undefined;
    if (replay) return replay;
    const message = {
      id: `message-${this.messages.length + 1}`,
      externalMessageId: input.messageId,
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      direction: input.direction,
      clientPhoneE164: input.clientPhoneE164,
      contactName: input.contactName ?? null,
      pushName: input.pushName ?? null,
      textExcerpt: input.textExcerpt ?? null,
      candidateUsername: input.candidateUsername ?? null,
      matchSource: input.matchSource ?? null,
      messageTimestamp: input.messageTimestamp ?? null,
      eventAt: input.messageTimestamp ?? '2026-08-07T12:00:00.000Z',
      routeStatus: 'unrouted' as const,
      resolvedOwnerId: null,
      resolvedPagina: null,
      routeResolution: null,
      routeResolvedAt: null,
      sourceContext: input.sourceContext ?? null,
      createdAt: '2026-08-07T12:00:00.000Z'
    };
    this.messages.push(message);
    return message;
  }

  async setMessageRoute(input: any): Promise<WhatsappQrMessageRecord> {
    const message = this.messages.find((row) => row.id === input.messageId)!;
    Object.assign(message, {
      ownerId: input.status === 'resolved' ? input.ownerId : message.ownerId,
      routeStatus: input.status,
      resolvedOwnerId: input.status === 'resolved' ? input.ownerId : null,
      resolvedPagina:
        input.status === 'resolved' ? (input.ownerId === asnOwner.ownerId ? 'ASN' : 'RdA') : null,
      routeResolution: input.resolution,
      routeResolvedAt: input.status === 'resolved' ? '2026-08-07T12:01:00.000Z' : null
    });
    return message;
  }

  async createMatch(input: CreateWhatsappQrMatchInput): Promise<WhatsappQrMatchRecord> {
    const replay = this.matches.find(
      (match) =>
        match.messageId === input.messageId &&
        match.ownerId === input.ownerId &&
        match.username === input.username &&
        match.source === input.source
    );
    if (replay) return replay;
    const match: WhatsappQrMatchRecord = {
      id: `match-${this.matches.length + 1}`,
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      messageId: input.messageId ?? null,
      pagina: input.pagina ?? 'RdA',
      clientPhoneE164: input.clientPhoneE164,
      username: input.username,
      source: input.source,
      status: input.status ?? 'candidate',
      rdaValidatedAt: null,
      platformValidatedAt: null,
      assignedAt: null,
      errorMessage: null,
      eventAt: input.eventAt ?? '2026-08-07T12:00:00.000Z',
      createdAt: '2026-08-07T12:00:00.000Z',
      updatedAt: '2026-08-07T12:00:00.000Z'
    };
    this.matches.push(match);
    return match;
  }

  async updateMatch(id: string, patch: any): Promise<WhatsappQrMatchRecord> {
    const match = this.matches.find((row) => row.id === id)!;
    Object.assign(match, {
      status: patch.status,
      ...(patch.platformValidatedAt !== undefined ? { platformValidatedAt: patch.platformValidatedAt } : {}),
      ...(patch.assignedAt !== undefined ? { assignedAt: patch.assignedAt } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      updatedAt: '2026-08-07T12:01:00.000Z'
    });
    return match;
  }

  async getPlatformCredential(ownerId: string, pagina: 'ASN' | 'RdA') {
    return {
      ownerId,
      ownerKey: ownerId === asnOwner.ownerId ? asnOwner.ownerKey : rdaOwner.ownerKey,
      pagina,
      loginUsername: `${pagina.toLowerCase()}-agent`,
      loginPassword: `${pagina.toLowerCase()}-password`,
      source: 'test',
      sourceRef: null,
      syncedAt: '2026-08-07T12:00:00.000Z'
    };
  }
}

function buildService(input: { rdaFound: boolean; asnFound: boolean; asnError?: boolean; existingPhonePagina?: 'ASN' | 'RdA' | 'both' }) {
  const store = new SharedRouteStore();
  const assignUsernameByPhone = vi.fn(async () => ({}));
  const service = new WhatsappQrAutoAssignService({
    appConfig,
    logger,
    store: store as unknown as WhatsappQrStore,
    playerPhoneStore: {
      assignUsernameByPhone,
      resolveOwnerContextByPhone: vi.fn(async ({ pagina }: { pagina: 'ASN' | 'RdA' }) => {
        if (input.existingPhonePagina !== pagina && input.existingPhonePagina !== 'both') return null;
        const routeOwner = pagina === 'ASN' ? asnOwner : rdaOwner;
        return { ownerKey: routeOwner.ownerKey, ownerLabel: routeOwner.ownerLabel, actorAlias: routeOwner.ownerLabel, actorPhone: null };
      })
    } as any,
    rdaUserExistsChecker: vi.fn(async ({ usuario }) => {
      if (!input.rdaFound) throw new (await import('../src/rda-user-check')).RdaUserCheckError('NOT_FOUND', `${usuario} missing`);
    }),
    asnUserExistsChecker: vi.fn(async ({ usuario }) => {
      if (input.asnError) throw new Error('ASN unavailable');
      if (!input.asnFound) throw new AsnUserCheckError('NOT_FOUND', `${usuario} missing`);
    })
  });
  return { service, store, assignUsernameByPhone };
}

describe('WhatsApp QR shared session routing', () => {
  it('finds the physical session through a secondary owner route', async () => {
    const sessionRow = {
      id: session.id,
      owner_id: rdaOwner.ownerId,
      owner_key: rdaOwner.ownerKey,
      owner_label: rdaOwner.ownerLabel,
      pagina: 'RdA',
      status: 'connected',
      runtime_session_id: session.runtimeSessionId,
      phone_e164: session.phoneE164,
      qr_payload: null,
      qr_data_url: null,
      qr_expires_at: null,
      last_heartbeat_at: null,
      last_connected_at: null,
      last_disconnected_at: null,
      last_error: null,
      bot_group_key: null,
      created_at: session.createdAt,
      updated_at: session.updatedAt
    };
    const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
    const client = {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const query: any = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return query;
          },
          maybeSingle: async () => {
            calls.push({ table, filters: { ...filters } });
            return table === 'mastercrm_whatsapp_qr_session_routes'
              ? { data: { session_id: session.id }, error: null }
              : { data: sessionRow, error: null };
          }
        };
        return query;
      }
    };
    const store = createWhatsappQrStore(client as any);

    const found = await store.getSessionByOwner(asnOwner.ownerId);

    expect(found?.id).toBe(session.id);
    expect(calls).toEqual([
      { table: 'mastercrm_whatsapp_qr_session_routes', filters: { owner_id: asnOwner.ownerId, status: 'active' } },
      { table: 'mastercrm_whatsapp_qr_sessions', filters: { id: session.id } }
    ]);
  });

  it('lists the shared physical session when filtering by a secondary owner', async () => {
    const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
    const sessionRow = {
      id: session.id,
      owner_id: rdaOwner.ownerId,
      owner_key: rdaOwner.ownerKey,
      owner_label: rdaOwner.ownerLabel,
      pagina: 'RdA',
      status: 'connected',
      runtime_session_id: session.runtimeSessionId,
      phone_e164: session.phoneE164,
      created_at: session.createdAt,
      updated_at: session.updatedAt
    };
    const client = {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const query: any = {
          select: () => query,
          order: () => query,
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return query;
          },
          in: (column: string, value: unknown) => {
            filters[column] = value;
            return query;
          },
          then: (resolve: (value: unknown) => unknown) => {
            calls.push({ table, filters: { ...filters } });
            return Promise.resolve(
              table === 'mastercrm_whatsapp_qr_session_routes'
                ? { data: [{ session_id: session.id }], error: null }
                : { data: [sessionRow], error: null }
            ).then(resolve);
          }
        };
        return query;
      }
    };
    const store = createWhatsappQrStore(client as any);

    const found = await store.listSessions([asnOwner.ownerId]);

    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(session.id);
    expect(calls).toEqual([
      { table: 'mastercrm_whatsapp_qr_session_routes', filters: { owner_id: [asnOwner.ownerId], status: 'active' } },
      { table: 'mastercrm_whatsapp_qr_sessions', filters: { id: [session.id] } }
    ]);
  });

  it('assigns exactly once when the username exists in only one active platform route', async () => {
    const { service, store, assignUsernameByPhone } = buildService({ rdaFound: true, asnFound: false });
    const result = await service.processMessage({
      owner: rdaOwner,
      session,
      direction: 'outbound',
      remoteJid: '5493512222222@s.whatsapp.net',
      messageId: 'wamid-unique',
      text: 'Usuario: player_123 Contraseña: secret'
    });

    expect(result.routeStatus).toBe('resolved');
    expect(result.resolvedOwner).toEqual(rdaOwner);
    expect(result.message?.ownerId).toBe(rdaOwner.ownerId);
    expect(store.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerId: rdaOwner.ownerId, status: 'assigned' }),
        expect.objectContaining({ ownerId: asnOwner.ownerId, status: 'not_found' })
      ])
    );
    expect(assignUsernameByPhone).toHaveBeenCalledTimes(1);
    expect(assignUsernameByPhone).toHaveBeenCalledWith(expect.objectContaining({ pagina: 'RdA' }));
  });

  it('returns QR_ROUTE_CONFLICT and never assigns when both routes validate', async () => {
    const { service, store, assignUsernameByPhone } = buildService({ rdaFound: true, asnFound: true });
    const event = {
      owner: rdaOwner,
      session,
      direction: 'outbound' as const,
      remoteJid: '5493512222222@s.whatsapp.net',
      messageId: 'wamid-conflict',
      text: 'Usuario: player_123 Contraseña: secret'
    };
    const first = await service.processMessage(event);
    const replay = await service.processMessage(event);

    expect(first.routeStatus).toBe('conflict');
    expect(first.matches).toHaveLength(2);
    expect(first.matches.every((match) => match.errorMessage?.startsWith('QR_ROUTE_CONFLICT'))).toBe(true);
    expect(replay.routeStatus).toBe('conflict');
    expect(store.messages).toHaveLength(1);
    expect(store.matches).toHaveLength(2);
    expect(assignUsernameByPhone).not.toHaveBeenCalled();
  });

  it('does not choose the healthy route when another route validation fails', async () => {
    const { service, assignUsernameByPhone } = buildService({ rdaFound: true, asnFound: false, asnError: true });
    const result = await service.processMessage({
      owner: rdaOwner,
      session,
      direction: 'outbound',
      remoteJid: '5493512222222@s.whatsapp.net',
      messageId: 'wamid-error',
      text: 'Usuario: player_123 Contraseña: secret'
    });

    expect(result.routeStatus).toBe('error');
    expect(result.resolvedOwner).toBeNull();
    expect(assignUsernameByPhone).not.toHaveBeenCalled();
  });

  it('keeps a message without routing evidence unrouted in a shared session', async () => {
    const { service, store, assignUsernameByPhone } = buildService({ rdaFound: true, asnFound: true });
    const result = await service.processMessage({
      owner: rdaOwner,
      session,
      direction: 'inbound',
      remoteJid: '5493512222222@s.whatsapp.net',
      messageId: 'wamid-organic',
      text: 'Hola'
    });

    expect(result.routeStatus).toBe('unrouted');
    expect(result.message?.routeResolution).toBe('candidate_required_for_shared_session');
    expect(store.matches).toHaveLength(0);
    expect(assignUsernameByPhone).not.toHaveBeenCalled();
  });

  it('stores a replayed contact sync without a WhatsApp message id exactly once', async () => {
    const { service, store, assignUsernameByPhone } = buildService({ rdaFound: true, asnFound: true });
    const event = {
      owner: rdaOwner,
      session,
      direction: 'contact_sync' as const,
      remoteJid: '5493513333333@s.whatsapp.net',
      contactName: null,
      pushName: 'Contacto sin usuario',
      text: null
    };

    const first = await service.processMessage(event);
    const replay = await service.processMessage(event);

    expect(first.routeStatus).toBe('unrouted');
    expect(replay.routeStatus).toBe('unrouted');
    expect(store.messages).toHaveLength(1);
    expect((store.messages[0] as any).externalMessageId).toBe('contact_sync:+5493513333333');
    expect(assignUsernameByPhone).not.toHaveBeenCalled();
  });

  it('uses an exact existing phone link before requiring a username candidate', async () => {
    const { service } = buildService({ rdaFound: false, asnFound: false, existingPhonePagina: 'ASN' });
    const result = await service.processMessage({
      owner: rdaOwner,
      session,
      direction: 'inbound',
      remoteJid: '5493512222222@s.whatsapp.net',
      messageId: 'wamid-known-phone',
      text: 'Hola de nuevo'
    });

    expect(result.routeStatus).toBe('resolved');
    expect(result.resolvedOwner).toEqual(asnOwner);
    expect(result.message?.ownerId).toBe(asnOwner.ownerId);
    expect(result.message?.routeResolution).toBe('existing_phone_link');
  });

  it('keeps an exact phone linked in both platforms as a deterministic conflict', async () => {
    const { service, assignUsernameByPhone } = buildService({ rdaFound: true, asnFound: true, existingPhonePagina: 'both' });
    const result = await service.processMessage({
      owner: rdaOwner,
      session,
      direction: 'inbound',
      remoteJid: '5493512222222@s.whatsapp.net',
      messageId: 'wamid-phone-conflict',
      text: 'Hola'
    });

    expect(result.routeStatus).toBe('conflict');
    expect(result.message?.routeResolution).toBe('phone_linked_to_multiple_active_routes');
    expect(assignUsernameByPhone).not.toHaveBeenCalled();
  });
});
