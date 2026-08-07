import type { Logger } from 'pino';
import type { AssertRdaUserExistsInput } from './rda-user-check';
import { AsnUserCheckError, type AssertAsnUserExistsInput } from './asn-user-check';
import {
  ownerContextFromWhatsappQrOwner,
  type WhatsappQrMatchRecord,
  type WhatsappQrMessageRecord,
  type WhatsappQrOwner,
  type WhatsappQrSessionRouteRecord,
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
import { getPlatformUserValidator } from './platform-user-validator';

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
  sourceContext?: import('./types').MetaSourceContext | null;
}

export interface WhatsappQrProcessResult {
  message: WhatsappQrMessageRecord | null;
  match: WhatsappQrMatchRecord | null;
  matches: WhatsappQrMatchRecord[];
  resolvedOwner: WhatsappQrOwner | null;
  routeStatus: import('./whatsapp-qr-store').WhatsappQrMessageRouteStatus | null;
}

export interface WhatsappQrAutoAssignOptions {
  appConfig: AppConfig;
  logger: Logger;
  store: WhatsappQrStore;
  playerPhoneStore: PlayerPhoneStore;
  rdaUserExistsChecker: (input: AssertRdaUserExistsInput) => Promise<void>;
  asnUserExistsChecker?: (input: AssertAsnUserExistsInput) => Promise<void>;
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
    owner: WhatsappQrOwner,
    clientPhoneE164: string,
    reason: 'outbound_candidate' | 'contact_seen' | 'technical_error'
  ): Promise<void> {
    const recheckStore = this.options.store as {
      enqueueRecheck?: (input: {
        ownerId: string;
        sessionId?: string | null;
        monthStart: string;
        phoneE164: string;
        reason: 'outbound_candidate' | 'contact_seen' | 'technical_error';
        nextRunAt?: string;
        expiresAt?: string;
      }) => Promise<unknown>;
    };
    if (typeof recheckStore.enqueueRecheck !== 'function') {
      return;
    }

    const now = new Date();
    try {
      await recheckStore.enqueueRecheck({
        ownerId: owner.ownerId,
        sessionId: event.session.id,
        monthStart: getBuenosAiresMonthStart(now),
        phoneE164: clientPhoneE164,
        reason,
        nextRunAt: addMinutes(now, reason === 'technical_error' ? 60 : 15).toISOString(),
        expiresAt: addMinutes(now, 7 * 24 * 60).toISOString()
      });
    } catch (error) {
      this.options.logger.warn({ error, ownerKey: owner.ownerKey, clientPhoneE164 }, 'Could not enqueue QR recheck');
    }
  }

  private async routesFor(event: WhatsappQrMessageEvent): Promise<WhatsappQrOwner[]> {
    if (typeof this.options.store.listSessionRoutes !== 'function') {
      return [event.owner];
    }
    const routes = await this.options.store.listSessionRoutes(event.session.id, true);
    return routes.length > 0 ? routes.map((route) => this.ownerFromRoute(route)) : [event.owner];
  }

  private ownerFromRoute(route: WhatsappQrSessionRouteRecord): WhatsappQrOwner {
    return {
      ownerId: route.ownerId,
      ownerKey: route.ownerKey,
      ownerLabel: route.ownerLabel,
      pagina: route.pagina
    };
  }

  private async routeFromExistingPhone(
    routes: WhatsappQrOwner[],
    clientPhoneE164: string
  ): Promise<{ status: 'none' | 'resolved' | 'conflict' | 'error'; owner: WhatsappQrOwner | null }> {
    if (routes.length <= 1 || typeof this.options.playerPhoneStore.resolveOwnerContextByPhone !== 'function') {
      return { status: 'none', owner: null };
    }
    try {
      const contexts = await Promise.all(
        [...new Set(routes.map((route) => route.pagina))].map(async (pagina) => ({
          pagina,
          context: await this.options.playerPhoneStore.resolveOwnerContextByPhone({ pagina, telefono: clientPhoneE164 })
        }))
      );
      const matched = routes.filter((route) =>
        contexts.some(
          ({ pagina, context }) => pagina === route.pagina && context?.ownerKey === route.ownerKey
        )
      );
      if (matched.length === 1) return { status: 'resolved', owner: matched[0] };
      if (matched.length > 1) return { status: 'conflict', owner: null };
      return { status: 'none', owner: null };
    } catch {
      return { status: 'error', owner: null };
    }
  }

  private async setRoute(
    message: WhatsappQrMessageRecord,
    status: import('./whatsapp-qr-store').WhatsappQrMessageRouteStatus,
    owner: WhatsappQrOwner | null,
    resolution: string
  ): Promise<WhatsappQrMessageRecord> {
    if (typeof this.options.store.setMessageRoute !== 'function') {
      return {
        ...message,
        routeStatus: status,
        resolvedOwnerId: status === 'resolved' ? owner?.ownerId ?? null : null,
        resolvedPagina: status === 'resolved' ? owner?.pagina ?? null : null,
        routeResolution: resolution,
        routeResolvedAt: status === 'resolved' ? new Date().toISOString() : null
      };
    }
    return this.options.store.setMessageRoute({
      messageId: message.id,
      status,
      ownerId: owner?.ownerId ?? null,
      resolution
    });
  }

  private async validateRoute(
    event: WhatsappQrMessageEvent,
    owner: WhatsappQrOwner,
    message: WhatsappQrMessageRecord,
    clientPhoneE164: string,
    candidateUsername: string,
    matchSource: import('./whatsapp-qr-store').WhatsappQrMatchSource
  ): Promise<{ owner: WhatsappQrOwner; match: WhatsappQrMatchRecord; outcome: 'validated' | 'not_found' | 'error' }> {
    let match = await this.options.store.createMatch({
      sessionId: event.session.id,
      ownerId: owner.ownerId,
      pagina: owner.pagina,
      messageId: message.id,
      clientPhoneE164,
      username: candidateUsername,
      source: matchSource,
      eventAt: message.eventAt
    });

    let credentials;
    try {
      credentials = this.options.store.getPlatformCredential
        ? await this.options.store.getPlatformCredential(owner.ownerId, owner.pagina)
        : null;
    } catch (error) {
      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'platform_credentials_unavailable'
      });
      await this.enqueueRecheck(event, owner, clientPhoneE164, 'technical_error');
      return { owner, match, outcome: 'error' };
    }

    if (!credentials) {
      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        errorMessage: `missing_${owner.pagina.toLowerCase()}_credentials`
      });
      await this.enqueueRecheck(event, owner, clientPhoneE164, 'technical_error');
      return { owner, match, outcome: 'error' };
    }

    try {
      const validator = getPlatformUserValidator(owner.pagina, {
        RdA: this.options.rdaUserExistsChecker,
        ASN: this.options.asnUserExistsChecker
      });
      await validator.validate({
        usuario: candidateUsername,
        agente: credentials.loginUsername,
        contrasenaAgente: credentials.loginPassword,
        appConfig: this.options.appConfig,
        logger: this.options.logger
      });
    } catch (error) {
      if ((error instanceof RdaUserCheckError || error instanceof AsnUserCheckError) && error.code === 'NOT_FOUND') {
        match = await this.options.store.updateMatch(match.id, {
          status: 'not_found',
          platformValidatedAt: new Date().toISOString(),
          errorMessage: error.message
        });
        return { owner, match, outcome: 'not_found' };
      }
      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'platform_validation_failed'
      });
      await this.enqueueRecheck(event, owner, clientPhoneE164, 'technical_error');
      return { owner, match, outcome: 'error' };
    }

    match = await this.options.store.updateMatch(match.id, {
      status: 'validated',
      platformValidatedAt: new Date().toISOString(),
      errorMessage: null
    });
    return { owner, match, outcome: 'validated' };
  }

  async processMessage(event: WhatsappQrMessageEvent): Promise<WhatsappQrProcessResult> {
    const clientPhoneE164 = event.clientPhoneE164 ?? normalizeWhatsappJidPhone(event.remoteJid);
    if (!clientPhoneE164) {
      this.options.logger.warn({ remoteJid: event.remoteJid, ownerKey: event.owner.ownerKey }, 'QR message ignored without phone');
      return { message: null, match: null, matches: [], resolvedOwner: null, routeStatus: null };
    }

    const contactCandidate =
      event.direction === 'inbound' || event.direction === 'contact_sync'
        ? extractUsernameFromContactName(event.contactName)
        : null;
    const outboundCandidate =
      event.direction === 'outbound' ? extractUsernameFromOutboundMessage(event.text) : null;
    const candidateUsername = contactCandidate ?? outboundCandidate;
    const matchSource = contactCandidate ? 'contact_name' : outboundCandidate ? 'outbound_message' : null;
    // Baileys contact-sync events do not carry a WhatsApp message id and may be
    // replayed after every reconnect. Use a stable per-session contact key so
    // the existing (session_id, message_id) constraint also makes them
    // idempotent while preserving the first event_at as the acquisition time.
    const messageId =
      event.messageId ?? (event.direction === 'contact_sync' ? `contact_sync:${clientPhoneE164}` : null);

    let message = await this.options.store.recordMessage({
      sessionId: event.session.id,
      ownerId: event.owner.ownerId,
      direction: event.direction,
      remoteJid: event.remoteJid ?? null,
      messageId,
      clientPhoneE164,
      contactName: event.contactName ?? null,
      pushName: event.pushName ?? null,
      textExcerpt: buildMessageExcerpt(event.text),
      candidateUsername,
      matchSource,
      messageTimestamp: event.messageTimestamp ?? null,
      sourceContext: event.sourceContext ?? null
    });

    const routes = await this.routesFor(event);
    const phoneRoute = await this.routeFromExistingPhone(routes, clientPhoneE164);
    if (phoneRoute.status === 'conflict') {
      message = await this.setRoute(message, 'conflict', null, 'phone_linked_to_multiple_active_routes');
      return { message, match: null, matches: [], resolvedOwner: null, routeStatus: 'conflict' };
    }
    if (phoneRoute.status === 'error') {
      message = await this.setRoute(message, 'error', null, 'existing_phone_route_lookup_failed');
      return { message, match: null, matches: [], resolvedOwner: null, routeStatus: 'error' };
    }
    const candidateRoutes = phoneRoute.owner ? [phoneRoute.owner] : routes;

    if (!candidateUsername || !matchSource) {
      if (candidateRoutes.length === 1) {
        const resolution = phoneRoute.owner ? 'existing_phone_link' : 'single_active_route';
        message = await this.setRoute(message, 'resolved', candidateRoutes[0], resolution);
        return { message, match: null, matches: [], resolvedOwner: candidateRoutes[0], routeStatus: 'resolved' };
      }
      message = await this.setRoute(message, 'unrouted', null, 'candidate_required_for_shared_session');
      return { message, match: null, matches: [], resolvedOwner: null, routeStatus: 'unrouted' };
    }

    await Promise.all(
      candidateRoutes.map((owner) =>
        this.enqueueRecheck(event, owner, clientPhoneE164, matchSource === 'outbound_message' ? 'outbound_candidate' : 'contact_seen')
      )
    );
    const attempts = await Promise.all(
      candidateRoutes.map((owner) => this.validateRoute(event, owner, message, clientPhoneE164, candidateUsername, matchSource))
    );
    const validated = attempts.filter((attempt) => attempt.outcome === 'validated');
    const errors = attempts.filter((attempt) => attempt.outcome === 'error');

    if (validated.length > 1) {
      const conflictIds = new Set(validated.map((attempt) => attempt.match.id));
      const matches = await Promise.all(
        attempts.map(async (attempt) => {
          if (!conflictIds.has(attempt.match.id)) return attempt.match;
          return this.options.store.updateMatch(attempt.match.id, {
            status: 'conflict',
            errorMessage: 'QR_ROUTE_CONFLICT: username exists in multiple active routes'
          });
        })
      );
      message = await this.setRoute(message, 'conflict', null, 'username_exists_in_multiple_routes');
      return { message, match: matches.find((item) => item.status === 'conflict') ?? null, matches, resolvedOwner: null, routeStatus: 'conflict' };
    }

    if (errors.length > 0) {
      const matches = attempts.map((attempt) => attempt.match);
      message = await this.setRoute(message, 'error', null, 'route_validation_incomplete');
      return { message, match: matches.find((item) => item.status === 'error') ?? null, matches, resolvedOwner: null, routeStatus: 'error' };
    }

    if (validated.length === 0) {
      const matches = attempts.map((attempt) => attempt.match);
      message = await this.setRoute(message, 'not_found', null, 'username_not_found_in_active_routes');
      return { message, match: matches[0] ?? null, matches, resolvedOwner: null, routeStatus: 'not_found' };
    }

    const selected = validated[0];
    message = await this.setRoute(
      message,
      'resolved',
      selected.owner,
      phoneRoute.owner ? 'existing_phone_link' : routes.length === 1 ? 'single_active_route' : 'unique_platform_validation'
    );
    let match = selected.match;

    const validatedAt = new Date().toISOString();
    try {
      await this.options.playerPhoneStore.assignUsernameByPhone({
        pagina: selected.owner.pagina,
        jugadorUsername: candidateUsername,
        telefono: clientPhoneE164,
        ownerContext: ownerContextFromWhatsappQrOwner(selected.owner, event.session.phoneE164)
      });
      match = await this.options.store.updateMatch(match.id, {
        status: 'assigned',
        platformValidatedAt: validatedAt,
        assignedAt: new Date().toISOString(),
        errorMessage: null
      });
      const matches = attempts.map((attempt) => (attempt.match.id === match.id ? match : attempt.match));
      return { message, match, matches, resolvedOwner: selected.owner, routeStatus: 'resolved' };
    } catch (error) {
      if (error instanceof PlayerPhoneStoreError && error.code === 'CONFLICT') {
        match = await this.options.store.updateMatch(match.id, {
          status: 'conflict',
          platformValidatedAt: validatedAt,
          errorMessage: error.message
        });
        const matches = attempts.map((attempt) => (attempt.match.id === match.id ? match : attempt.match));
        return { message, match, matches, resolvedOwner: selected.owner, routeStatus: 'resolved' };
      }

      match = await this.options.store.updateMatch(match.id, {
        status: 'error',
        rdaValidatedAt: validatedAt,
        errorMessage: error instanceof Error ? error.message : 'assignment_failed'
      });
      await this.enqueueRecheck(event, selected.owner, clientPhoneE164, 'technical_error');
      const matches = attempts.map((attempt) => (attempt.match.id === match.id ? match : attempt.match));
      return { message, match, matches, resolvedOwner: selected.owner, routeStatus: 'resolved' };
    }
  }
}
