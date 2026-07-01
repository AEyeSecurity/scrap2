import type { Logger } from 'pino';
import type { AssertRdaUserExistsInput } from './rda-user-check';
import {
  ownerContextFromWhatsappQrOwner,
  type WhatsappQrMatchRecord,
  type WhatsappQrMessageRecord,
  type WhatsappQrOwner,
  type WhatsappQrSessionRecord,
  type WhatsappQrStore
} from './whatsapp-qr-store';
import {
  buildMessageExcerpt,
  extractUsernameFromContactName,
  extractUsernameFromOutboundMessage,
  normalizeWhatsappJidPhone
} from './whatsapp-qr-parser';
import { PlayerPhoneStoreError, type PlayerPhoneStore } from './player-phone-store';
import { RdaUserCheckError } from './rda-user-check';
import type { AppConfig } from './types';

export interface WhatsappQrMessageEvent {
  owner: WhatsappQrOwner;
  session: WhatsappQrSessionRecord;
  direction: 'inbound' | 'outbound' | 'contact_sync';
  remoteJid?: string | null;
  messageId?: string | null;
  clientPhoneE164?: string | null;
  contactName?: string | null;
  pushName?: string | null;
  text?: string | null;
  messageTimestamp?: string | null;
}

export interface WhatsappQrProcessResult {
  message: WhatsappQrMessageRecord | null;
  match: WhatsappQrMatchRecord | null;
}

export interface WhatsappQrAutoAssignOptions {
  appConfig: AppConfig;
  logger: Logger;
  store: WhatsappQrStore;
  playerPhoneStore: PlayerPhoneStore;
  rdaUserExistsChecker: (input: AssertRdaUserExistsInput) => Promise<void>;
}

export class WhatsappQrAutoAssignService {
  constructor(private readonly options: WhatsappQrAutoAssignOptions) {}

  async processMessage(event: WhatsappQrMessageEvent): Promise<WhatsappQrProcessResult> {
    const clientPhoneE164 = event.clientPhoneE164 ?? normalizeWhatsappJidPhone(event.remoteJid);
    if (!clientPhoneE164) {
      this.options.logger.warn({ remoteJid: event.remoteJid, ownerKey: event.owner.ownerKey }, 'QR message ignored without phone');
      return { message: null, match: null };
    }

    const contactCandidate =
      event.direction === 'inbound' || event.direction === 'contact_sync'
        ? extractUsernameFromContactName(event.contactName)
        : null;
    const outboundCandidate =
      event.direction === 'outbound' ? extractUsernameFromOutboundMessage(event.text) : null;
    const candidateUsername = contactCandidate ?? outboundCandidate;
    const matchSource = contactCandidate ? 'contact_name' : outboundCandidate ? 'outbound_message' : null;

    const message = await this.options.store.recordMessage({
      sessionId: event.session.id,
      ownerId: event.owner.ownerId,
      direction: event.direction,
      remoteJid: event.remoteJid ?? null,
      messageId: event.messageId ?? null,
      clientPhoneE164,
      contactName: event.contactName ?? null,
      pushName: event.pushName ?? null,
      textExcerpt: buildMessageExcerpt(event.text),
      candidateUsername,
      matchSource,
      messageTimestamp: event.messageTimestamp ?? null
    });

    if (!candidateUsername || !matchSource) {
      return { message, match: null };
    }

    let match = await this.options.store.createMatch({
      sessionId: event.session.id,
      ownerId: event.owner.ownerId,
      messageId: message.id,
      clientPhoneE164,
      username: candidateUsername,
      source: matchSource
    });

    const credentials = await this.options.store.getRdaCredential(event.owner.ownerId);
    if (!credentials) {
      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        errorMessage: 'missing_rda_credentials'
      });
      return { message, match };
    }

    try {
      await this.options.rdaUserExistsChecker({
        usuario: candidateUsername,
        agente: credentials.loginUsername,
        contrasenaAgente: credentials.loginPassword,
        appConfig: this.options.appConfig,
        logger: this.options.logger
      });
    } catch (error) {
      if (error instanceof RdaUserCheckError && error.code === 'NOT_FOUND') {
        match = await this.options.store.updateMatch(match.id, {
          status: 'not_found',
          rdaValidatedAt: new Date().toISOString(),
          errorMessage: error.message
        });
        return { message, match };
      }

      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'rda_validation_failed'
      });
      return { message, match };
    }

    const validatedAt = new Date().toISOString();
    match = await this.options.store.updateMatch(match.id, {
      status: 'validated',
      rdaValidatedAt: validatedAt,
      errorMessage: null
    });

    try {
      await this.options.playerPhoneStore.assignUsernameByPhone({
        pagina: 'RdA',
        jugadorUsername: candidateUsername,
        telefono: clientPhoneE164,
        ownerContext: ownerContextFromWhatsappQrOwner(event.owner, event.session.phoneE164)
      });
      match = await this.options.store.updateMatch(match.id, {
        status: 'assigned',
        rdaValidatedAt: validatedAt,
        assignedAt: new Date().toISOString(),
        errorMessage: null
      });
      return { message, match };
    } catch (error) {
      if (error instanceof PlayerPhoneStoreError && error.code === 'CONFLICT') {
        match = await this.options.store.updateMatch(match.id, {
          status: 'conflict',
          rdaValidatedAt: validatedAt,
          errorMessage: error.message
        });
        return { message, match };
      }

      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        rdaValidatedAt: validatedAt,
        errorMessage: error instanceof Error ? error.message : 'assignment_failed'
      });
      return { message, match };
    }
  }
}
