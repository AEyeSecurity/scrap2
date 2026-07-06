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

function getBuenosAiresMonthStart(input = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(input);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return year && month ? `${year}-${month}-01` : input.toISOString().slice(0, 7) + '-01';
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export class WhatsappQrAutoAssignService {
  constructor(private readonly options: WhatsappQrAutoAssignOptions) {}

  private async enqueueRecheck(
    event: WhatsappQrMessageEvent,
    clientPhoneE164: string,
    reason: 'outbound_candidate' | 'contact_seen' | 'technical_error'
  ): Promise<void> {
    const enqueueRecheck = (this.options.store as any).enqueueRecheck as
      | ((input: {
          ownerId: string;
          sessionId?: string | null;
          monthStart: string;
          phoneE164: string;
          reason: 'outbound_candidate' | 'contact_seen' | 'technical_error';
          nextRunAt?: string;
          expiresAt?: string;
        }) => Promise<unknown>)
      | undefined;
    if (!enqueueRecheck) {
      return;
    }

    const now = new Date();
    try {
      await enqueueRecheck({
        ownerId: event.owner.ownerId,
        sessionId: event.session.id,
        monthStart: getBuenosAiresMonthStart(now),
        phoneE164: clientPhoneE164,
        reason,
        nextRunAt: addMinutes(now, reason === 'technical_error' ? 60 : 15).toISOString(),
        expiresAt: addMinutes(now, 7 * 24 * 60).toISOString()
      });
    } catch (error) {
      this.options.logger.warn({ error, ownerKey: event.owner.ownerKey, clientPhoneE164 }, 'Could not enqueue QR recheck');
    }
  }

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

    await this.enqueueRecheck(
      event,
      clientPhoneE164,
      matchSource === 'outbound_message' ? 'outbound_candidate' : 'contact_seen'
    );

    let match = await this.options.store.createMatch({
      sessionId: event.session.id,
      ownerId: event.owner.ownerId,
      messageId: message.id,
      clientPhoneE164,
      username: candidateUsername,
      source: matchSource
    });

    let credentials;
    try {
      credentials = await this.options.store.getRdaCredential(event.owner.ownerId);
    } catch (error) {
      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'rda_credentials_unavailable'
      });
      await this.enqueueRecheck(event, clientPhoneE164, 'technical_error');
      return { message, match };
    }

    if (!credentials) {
      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        errorMessage: 'missing_rda_credentials'
      });
      await this.enqueueRecheck(event, clientPhoneE164, 'technical_error');
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
      await this.enqueueRecheck(event, clientPhoneE164, 'technical_error');
      return { message, match };
    }

    const validatedAt = new Date().toISOString();
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
      await this.enqueueRecheck(event, clientPhoneE164, 'technical_error');
      return { message, match };
    }
  }
}
