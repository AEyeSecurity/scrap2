import { describe, expect, it, vi } from 'vitest';
import { buildAppConfig } from '../src/config';
import { createLogger } from '../src/logging';
import { PlayerPhoneStoreError } from '../src/player-phone-store';
import { runN8nRdaCredentialSync, normalizeN8nRdaCredentialRows } from '../src/n8n-rda-credential-sync';
import { WhatsappQrAutoAssignService } from '../src/whatsapp-qr-service';
import {
  buildMessageExcerpt,
  extractUsernameFromContactName,
  extractUsernameFromOutboundMessage,
  normalizeWhatsappJidPhone
} from '../src/whatsapp-qr-parser';
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

const owner: WhatsappQrOwner = {
  ownerId: 'owner-1',
  ownerKey: 'luqui10:luqui10',
  ownerLabel: 'Lucas10',
  pagina: 'RdA',
  telefono: '+5493510000000'
};

const session: WhatsappQrSessionRecord = {
  id: 'session-1',
  ownerId: owner.ownerId,
  ownerKey: owner.ownerKey,
  ownerLabel: owner.ownerLabel,
  pagina: 'RdA',
  status: 'connected',
  runtimeSessionId: 'RdA-luqui10_luqui10',
  phoneE164: '+5493511111111',
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
};

class FakeWhatsappQrStore implements Partial<WhatsappQrStore> {
  public readonly messages: WhatsappQrMessageRecord[] = [];
  public readonly matches: WhatsappQrMatchRecord[] = [];
  public credentials = {
    ownerId: owner.ownerId,
    ownerKey: owner.ownerKey,
    pagina: 'RdA' as const,
    loginUsername: 'agente',
    loginPassword: 'clave-agente',
    source: 'n8n',
    sourceRef: 'fixture:1',
    syncedAt: '2026-06-30T12:00:00.000Z'
  };

  async recordMessage(input: RecordWhatsappQrMessageInput): Promise<WhatsappQrMessageRecord> {
    const message: WhatsappQrMessageRecord = {
      id: `message-${this.messages.length + 1}`,
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
      createdAt: '2026-06-30T12:00:00.000Z'
    };
    this.messages.push(message);
    return message;
  }

  async createMatch(input: CreateWhatsappQrMatchInput): Promise<WhatsappQrMatchRecord> {
    const match: WhatsappQrMatchRecord = {
      id: `match-${this.matches.length + 1}`,
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      messageId: input.messageId ?? null,
      pagina: 'RdA',
      clientPhoneE164: input.clientPhoneE164,
      username: input.username,
      source: input.source,
      status: input.status ?? 'candidate',
      rdaValidatedAt: null,
      assignedAt: null,
      errorMessage: input.errorMessage ?? null,
      createdAt: '2026-06-30T12:00:00.000Z',
      updatedAt: '2026-06-30T12:00:00.000Z'
    };
    this.matches.push(match);
    return match;
  }

  async updateMatch(
    id: string,
    patch: {
      status: WhatsappQrMatchRecord['status'];
      rdaValidatedAt?: string | null;
      assignedAt?: string | null;
      errorMessage?: string | null;
    }
  ): Promise<WhatsappQrMatchRecord> {
    const match = this.matches.find((item) => item.id === id);
    if (!match) throw new Error('match not found');

    Object.assign(match, {
      status: patch.status,
      rdaValidatedAt: patch.rdaValidatedAt ?? match.rdaValidatedAt,
      assignedAt: patch.assignedAt ?? match.assignedAt,
      errorMessage: patch.errorMessage ?? match.errorMessage,
      updatedAt: '2026-06-30T12:01:00.000Z'
    });
    return match;
  }

  async getRdaCredential(): Promise<typeof this.credentials | null> {
    return this.credentials;
  }
}

describe('WhatsApp QR parser', () => {
  it('extracts RdA usernames from contact names and outbound messages', () => {
    expect(extractUsernameFromContactName('Player_123')).toBe('player_123');
    expect(
      extractUsernameFromOutboundMessage(`Usuario: Player_123
Contrase\u00f1a: secreto

https://reydeases.com/`)
    ).toBe('player_123');
    expect(extractUsernameFromOutboundMessage('- Usuario: Andrea1201 - Contrase\u00f1a: secreto')).toBe('andrea1201');
    expect(extractUsernameFromOutboundMessage('Crear usuario 3Rosa648')).toBe('3rosa648');
    expect(normalizeWhatsappJidPhone('5493511234567@s.whatsapp.net')).toBe('+5493511234567');
    expect(normalizeWhatsappJidPhone('5493516549344:5@s.whatsapp.net')).toBe('+5493516549344');
    expect(normalizeWhatsappJidPhone('171606005538987@lid')).toBeNull();
  });

  it('redacts passwords from stored excerpts', () => {
    expect(buildMessageExcerpt('Usuario: player_123\nContrase\u00f1a: super-secreta')).toBe(
      'Usuario: player_123 Contrase\u00f1a: [redacted]'
    );
  });
});

describe('WhatsApp QR autoassign', () => {
  it('validates outbound Usuario messages and assigns the phone without storing the password', async () => {
    const store = new FakeWhatsappQrStore();
    const assignUsernameByPhone = vi.fn(async () => ({
      previousUsername: null,
      currentUsername: 'player_123',
      overwritten: false,
      createdClient: true,
      createdLink: true,
      movedFromPhone: null,
      deletedOldPhone: false
    }));
    const rdaUserExistsChecker = vi.fn(async () => undefined);
    const service = new WhatsappQrAutoAssignService({
      appConfig,
      logger,
      store: store as WhatsappQrStore,
      playerPhoneStore: { assignUsernameByPhone } as any,
      rdaUserExistsChecker
    });

    const result = await service.processMessage({
      owner,
      session,
      direction: 'outbound',
      remoteJid: '5493511234567@s.whatsapp.net',
      text: 'Usuario: player_123\nContrase\u00f1a: super-secreta\n\nhttps://reydeases.com/'
    });

    expect(result.match?.status).toBe('assigned');
    expect(rdaUserExistsChecker).toHaveBeenCalledWith(
      expect.objectContaining({
        usuario: 'player_123',
        agente: 'agente',
        contrasenaAgente: 'clave-agente'
      })
    );
    expect(assignUsernameByPhone).toHaveBeenCalledWith(
      expect.objectContaining({
        pagina: 'RdA',
        jugadorUsername: 'player_123',
        telefono: '+5493511234567',
        ownerContext: expect.objectContaining({ ownerKey: 'luqui10:luqui10' })
      })
    );
    expect(store.messages[0]?.textExcerpt).not.toContain('super-secreta');
  });

  it('leaves conflicts for review and does not overwrite ownership', async () => {
    const store = new FakeWhatsappQrStore();
    const assignUsernameByPhone = vi.fn(async () => {
      throw new PlayerPhoneStoreError('CONFLICT', 'username already linked to another phone');
    });
    const service = new WhatsappQrAutoAssignService({
      appConfig,
      logger,
      store: store as WhatsappQrStore,
      playerPhoneStore: { assignUsernameByPhone } as any,
      rdaUserExistsChecker: vi.fn(async () => undefined)
    });

    const result = await service.processMessage({
      owner,
      session,
      direction: 'inbound',
      remoteJid: '5493511234567@s.whatsapp.net',
      contactName: 'player_123',
      text: 'hola'
    });

    expect(result.match?.status).toBe('conflict');
    expect(assignUsernameByPhone).toHaveBeenCalledTimes(1);
  });

  it('matches saved contact names during QR contact sync', async () => {
    const store = new FakeWhatsappQrStore();
    const assignUsernameByPhone = vi.fn(async () => ({
      previousUsername: null,
      currentUsername: 'player_123',
      overwritten: false,
      createdClient: false,
      createdLink: false,
      movedFromPhone: null,
      deletedOldPhone: false
    }));
    const service = new WhatsappQrAutoAssignService({
      appConfig,
      logger,
      store: store as WhatsappQrStore,
      playerPhoneStore: { assignUsernameByPhone } as any,
      rdaUserExistsChecker: vi.fn(async () => undefined)
    });

    const result = await service.processMessage({
      owner,
      session,
      direction: 'contact_sync',
      remoteJid: '5493511234567@s.whatsapp.net',
      contactName: 'player_123'
    });

    expect(result.message?.direction).toBe('contact_sync');
    expect(result.match?.source).toBe('contact_name');
    expect(result.match?.status).toBe('assigned');
  });

  it('does not autoassign generic push names without a saved contact name', async () => {
    const store = new FakeWhatsappQrStore();
    const assignUsernameByPhone = vi.fn(async () => ({
      previousUsername: null,
      currentUsername: 'juan',
      overwritten: false,
      createdClient: false,
      createdLink: false,
      movedFromPhone: null,
      deletedOldPhone: false
    }));
    const service = new WhatsappQrAutoAssignService({
      appConfig,
      logger,
      store: store as WhatsappQrStore,
      playerPhoneStore: { assignUsernameByPhone } as any,
      rdaUserExistsChecker: vi.fn(async () => undefined)
    });

    const result = await service.processMessage({
      owner,
      session,
      direction: 'contact_sync',
      remoteJid: '5493511234567@s.whatsapp.net',
      contactName: null,
      pushName: 'Juan'
    });

    expect(result.match).toBeNull();
    expect(assignUsernameByPhone).not.toHaveBeenCalled();
    expect(store.messages[0]?.pushName).toBe('Juan');
    expect(store.messages[0]?.candidateUsername).toBeNull();
  });
});

describe('n8n RdA credential sync', () => {
  it('normalizes fixture rows and blocks unknown owners in dry-run', async () => {
    const normalized = normalizeN8nRdaCredentialRows([
      {
        table: 'data_table_user_fixture',
        rowid: 1,
        owner_key: 'Luqui10:Luqui10',
        usuario: 'agente',
        clave: 'clave-agente',
        Sede: 'RdA',
        Permiso: 'si'
      },
      {
        table: 'data_table_user_fixture',
        rowid: 2,
        owner_key: 'desconocido:desconocido',
        usuario: 'otro',
        clave: 'otra-clave',
        Sede: 'RdA'
      }
    ]);

    const upsertRdaCredential = vi.fn(async () => normalized.rows[0] as any);
    const result = await runN8nRdaCredentialSync({
      rows: normalized.rows,
      dryRun: true,
      store: {
        resolveOwnerByKey: vi.fn(async (_pagina, ownerKey) =>
          ownerKey === 'luqui10:luqui10' ? owner : null
        ),
        upsertRdaCredential
      } as any
    });

    expect(result.synced).toBe(1);
    expect(result.skippedMissingOwner).toEqual([
      { ownerKey: 'desconocido:desconocido', sourceRef: 'data_table_user_fixture:2' }
    ]);
    expect(upsertRdaCredential).not.toHaveBeenCalled();
  });
});
