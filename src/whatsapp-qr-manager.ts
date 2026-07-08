import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { TelegramAlertSender } from './telegram-alerts';
import { WhatsappQrAutoBackfillRunner } from './whatsapp-qr-auto-backfill';
import type { WhatsappQrAutoAssignService } from './whatsapp-qr-service';
import {
  buildWhatsappQrPhoneQueue,
  type WhatsappQrPhoneQueueRow,
  type WhatsappQrQueueSummary
} from './whatsapp-qr-dashboard';
import {
  ownerContextFromWhatsappQrOwner,
  type WhatsappQrChatState,
  type WhatsappQrContactRecord,
  type UpsertWhatsappQrSessionPatch,
  type WhatsappQrOwner,
  type WhatsappQrSessionRecord,
  type WhatsappQrStore
} from './whatsapp-qr-store';
import type { PlayerPhoneStore } from './player-phone-store';
import { normalizeWhatsappJidPhone, resolveMessageRemoteJid } from './whatsapp-qr-parser';

interface RuntimeMessageEvent {
  direction: 'inbound' | 'outbound';
  remoteJid?: string | null;
  messageId?: string | null;
  contactName?: string | null;
  pushName?: string | null;
  text?: string | null;
  messageTimestamp?: string | null;
  isHistory?: boolean;
}

interface RuntimeContactEvent {
  remoteJid?: string | null;
  clientPhoneE164?: string | null;
  contactName?: string | null;
  pushName?: string | null;
  username?: string | null;
  verifiedName?: string | null;
}

interface RuntimeSession {
  stop(): Promise<void>;
}

interface RuntimeHandlers {
  onQr(qrPayload: string, qrDataUrl: string | null): Promise<void>;
  onConnected(phoneE164: string | null): Promise<void>;
  onDisconnected(errorMessage: string | null): Promise<void>;
  onHeartbeat(): Promise<void>;
  onMessage(event: RuntimeMessageEvent): Promise<void>;
  onContact(event: RuntimeContactEvent): Promise<void>;
}

interface RuntimeStartOptions {
  resumeOnly?: boolean;
}

interface WhatsappQrRuntime {
  start(
    owner: WhatsappQrOwner,
    runtimeSessionId: string,
    handlers: RuntimeHandlers,
    options?: RuntimeStartOptions
  ): Promise<RuntimeSession>;
}

export interface WhatsappQrManagerOptions {
  store: WhatsappQrStore;
  autoAssignService: WhatsappQrAutoAssignService;
  playerPhoneStore: PlayerPhoneStore;
  telegramAlerts: TelegramAlertSender;
  logger: Logger;
  runtime?: WhatsappQrRuntime;
  authRootDir?: string;
  qrTtlMs?: number;
  heartbeatStaleMs?: number;
  alertPollMs?: number;
}

export interface WhatsappQrDashboard {
  sessions: Array<WhatsappQrSessionRecord & { hasRdaCredentials: boolean }>;
  summary: WhatsappQrQueueSummary;
  queue: WhatsappQrPhoneQueueRow[];
  coverage?: WhatsappQrCoverageSummary | null;
  isAdmin: boolean;
  runtimeEnabled: boolean;
  ownerSummaries?: Array<{
    owner: WhatsappQrOwner;
    session: (WhatsappQrSessionRecord & { hasRdaCredentials: boolean }) | null;
    summary: WhatsappQrQueueSummary;
  }>;
}

export interface WhatsappQrCoverageSummary {
  portfolioTotal: number;
  contactsSeenCount: number;
  contactsSeenPct: number;
  signalDetectedCount: number;
  signalDetectedPct: number;
  assignedCount: number;
  assignedPct: number;
  noSignalCount: number;
  noSignalPct: number;
}

const MONTH_TOKEN_RE = /^\d{4}-\d{2}$/;

function safeRuntimeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function extractText(message: any): string | null {
  const payload = message?.message;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return (
    payload.conversation ??
    payload.extendedTextMessage?.text ??
    payload.imageMessage?.caption ??
    payload.videoMessage?.caption ??
    null
  );
}

function extractContactName(contact: any): string | null {
  return contact?.name ?? contact?.notify ?? contact?.verifiedName ?? null;
}

function extractSavedContactName(contact: any): string | null {
  return contact?.name ?? null;
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

function getBuenosAiresMonthToken(input = new Date()): string {
  return getBuenosAiresMonthStart(input).slice(0, 7);
}

function normalizeWhatsappQrMonth(month: string | undefined): string {
  const normalized = month?.trim() ?? '';
  if (!normalized) {
    return getBuenosAiresMonthToken();
  }
  if (!MONTH_TOKEN_RE.test(normalized)) {
    throw new Error('month must use YYYY-MM format');
  }

  const [, monthToken] = normalized.split('-');
  const monthValue = Number(monthToken);
  if (!Number.isInteger(monthValue) || monthValue < 1 || monthValue > 12) {
    throw new Error('month must use a valid YYYY-MM value');
  }

  return normalized;
}

function buildWhatsappQrMonthWindow(month: string | undefined): {
  month: string;
  monthStartDate: string;
  nextMonthStartDate: string;
  startedAtIso: string;
  endedAtIso: string;
} {
  const normalizedMonth = normalizeWhatsappQrMonth(month);
  const [yearToken, monthToken] = normalizedMonth.split('-');
  const year = Number(yearToken);
  const monthIndex = Number(monthToken) - 1;
  const nextMonthYear = monthIndex === 11 ? year + 1 : year;
  const nextMonthIndex = (monthIndex + 1) % 12;
  const monthStartDate = `${normalizedMonth}-01`;
  const nextMonthStartDate = `${nextMonthYear}-${String(nextMonthIndex + 1).padStart(2, '0')}-01`;

  return {
    month: normalizedMonth,
    monthStartDate,
    nextMonthStartDate,
    startedAtIso: new Date(Date.UTC(year, monthIndex, 1, 3, 0, 0, 0)).toISOString(),
    endedAtIso: new Date(Date.UTC(nextMonthYear, nextMonthIndex, 1, 3, 0, 0, 0)).toISOString()
  };
}

function resolveWhatsappQrMonthStart(): string {
  const override = process.env.WHATSAPP_QR_MONTH_OVERRIDE?.trim();
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) {
    return override;
  }

  return getBuenosAiresMonthStart();
}

async function toQrDataUrl(qrPayload: string): Promise<string | null> {
  try {
    const qrcode = (await import('qrcode')) as any;
    return await qrcode.toDataURL(qrPayload, { margin: 1, scale: 6 });
  } catch {
    return null;
  }
}

class BaileysWhatsappQrRuntime implements WhatsappQrRuntime {
  constructor(
    private readonly authRootDir: string,
    private readonly logger: Logger
  ) {}

  async start(
    owner: WhatsappQrOwner,
    runtimeSessionId: string,
    handlers: RuntimeHandlers,
    options: RuntimeStartOptions = {}
  ): Promise<RuntimeSession> {
    await mkdir(this.authRootDir, { recursive: true });
    const sessionDir = join(this.authRootDir, safeRuntimeSessionId(runtimeSessionId));
    await mkdir(sessionDir, { recursive: true });

    const baileys = (await import('@whiskeysockets/baileys')) as any;
    const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir);
    const contactNames = new Map<string, string>();
    let sock: any = null;
    let stopped = false;
    let disconnectedNotified = false;
    let reconnectAttempts = 0;
    let reconnectTimer: NodeJS.Timeout | null = null;
    const resumeOnly = options.resumeOnly === true;

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const notifyDisconnected = async (message: string | null) => {
      if (disconnectedNotified) {
        return;
      }
      disconnectedNotified = true;
      await handlers.onDisconnected(message);
    };

    const startSocket = async (): Promise<void> => {
      if (stopped) {
        return;
      }

      sock = baileys.default({
        auth: state,
        syncFullHistory: true,
        browser: ['MasterCRM', 'Chrome', '1.0.0']
      });

      const resolveLidToPn = async (jid: string): Promise<string | null> => {
        try {
          const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
          return typeof pn === 'string' && pn.includes('@') ? pn : null;
        } catch {
          return null;
        }
      };

      const emitContact = async (contact: any): Promise<void> => {
        if (!contact?.id) {
          return;
        }
        let phone = normalizeWhatsappJidPhone(contact.phoneNumber ?? contact.id);
        if (!phone && typeof contact.id === 'string' && contact.id.endsWith('@lid')) {
          phone = normalizeWhatsappJidPhone(await resolveLidToPn(contact.id));
        }
        const contactName = extractSavedContactName(contact);
        if (phone && contactName) {
          contactNames.set(phone, contactName);
        }
        await handlers.onContact({
          remoteJid: contact.id,
          clientPhoneE164: phone,
          contactName,
          pushName: contact.notify ?? null,
          username: contact.username ?? null,
          verifiedName: contact.verifiedName ?? null
        });
      };

      const emitMessage = async (item: any, isHistory: boolean): Promise<void> => {
        const rawJid = item.key?.remoteJid ?? null;
        if (!rawJid || rawJid.endsWith('@g.us') || rawJid === 'status@broadcast') {
          return;
        }
        let remoteJid = resolveMessageRemoteJid(item.key);
        if (!remoteJid && rawJid.endsWith('@lid')) {
          remoteJid = await resolveLidToPn(rawJid);
        }
        if (!remoteJid) {
          this.logger.warn({ ownerKey: owner.ownerKey, rawJid }, 'QR message dropped: unresolved @lid');
          return;
        }
        const phone = normalizeWhatsappJidPhone(remoteJid);
        const timestampValue = item.messageTimestamp;
        const timestamp =
          typeof timestampValue === 'number'
            ? new Date(timestampValue * 1000).toISOString()
            : timestampValue?.low
              ? new Date(Number(timestampValue.low) * 1000).toISOString()
              : null;
        await handlers.onMessage({
          direction: item.key?.fromMe ? 'outbound' : 'inbound',
          remoteJid,
          messageId: item.key?.id ?? null,
          contactName: phone ? (contactNames.get(phone) ?? null) : null,
          pushName: item.pushName ?? null,
          text: extractText(item),
          messageTimestamp: timestamp,
          isHistory
        });
      };

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('contacts.update', async (updates: any[]) => {
        for (const contact of updates ?? []) {
          await emitContact(contact).catch((error) =>
            this.logger.warn({ error, ownerKey: owner.ownerKey }, 'QR contact update processing failed')
          );
        }
      });
      sock.ev.on('contacts.upsert', async (contacts: any[]) => {
        for (const contact of contacts ?? []) {
          await emitContact(contact).catch((error) =>
            this.logger.warn({ error, ownerKey: owner.ownerKey }, 'QR contact upsert processing failed')
          );
        }
      });
      sock.ev.on('connection.update', async (update: any) => {
        if (update.qr) {
          if (resumeOnly) {
            stopped = true;
            clearReconnectTimer();
            await notifyDisconnected('qr_auth_state_invalid');
            try {
              sock.end?.(new Error('Stored WhatsApp QR auth requires a new QR'));
            } catch {
              sock.ws?.close?.();
            }
            return;
          }
          reconnectAttempts = 0;
          await handlers.onQr(update.qr, await toQrDataUrl(update.qr));
        }
        if (update.connection === 'open') {
          reconnectAttempts = 0;
          const phone = normalizeWhatsappJidPhone(sock.user?.id ?? null);
          await handlers.onConnected(phone);
        }
        if (update.connection === 'close') {
          const statusCode =
            Number(update.lastDisconnect?.error?.output?.statusCode) ||
            Number(update.lastDisconnect?.error?.data?.statusCode) ||
            null;
          const message =
            update.lastDisconnect?.error?.message ??
            update.lastDisconnect?.error?.output?.payload?.message ??
            'connection_closed';

          if (!stopped && statusCode !== baileys.DisconnectReason.loggedOut) {
            reconnectAttempts += 1;
            const delayMs = Math.min(15_000, Math.max(1_000, reconnectAttempts * 1_500));
            this.logger.warn(
              { ownerKey: owner.ownerKey, statusCode, reconnectAttempts, delayMs, message },
              'WhatsApp QR socket closed; restarting runtime'
            );
            clearReconnectTimer();
            reconnectTimer = setTimeout(() => {
              startSocket().catch((error) => {
                this.logger.error({ error, ownerKey: owner.ownerKey }, 'WhatsApp QR socket restart failed');
              });
            }, delayMs);
            reconnectTimer.unref?.();
            return;
          }

          await notifyDisconnected(message);
        }
      });
      sock.ev.on('messages.upsert', async (payload: any) => {
        for (const item of payload.messages ?? []) {
          await emitMessage(item, false);
        }
        await handlers.onHeartbeat();
      });
      sock.ev.on('messaging-history.set', async (payload: any) => {
        for (const contact of payload.contacts ?? []) {
          await emitContact(contact);
        }

        for (const item of payload.messages ?? []) {
          await emitMessage(item, true);
        }
        await handlers.onHeartbeat();
      });
    };

    await startSocket();

    this.logger.info({ ownerKey: owner.ownerKey }, 'WhatsApp QR runtime started');

    return {
      async stop() {
        stopped = true;
        clearReconnectTimer();
        try {
          sock.end?.(new Error('MasterCRM QR session stopped'));
        } catch {
          sock.ws?.close?.();
        }
      }
    };
  }
}

class DisabledWhatsappQrRuntime implements WhatsappQrRuntime {
  async start(): Promise<RuntimeSession> {
    throw new Error('WHATSAPP_QR_RUNTIME is not enabled');
  }
}

export function buildWhatsappQrRuntimeFromEnv(logger: Logger): WhatsappQrRuntime {
  const runtime = process.env.WHATSAPP_QR_RUNTIME?.trim().toLowerCase();
  if (runtime === 'baileys') {
    return new BaileysWhatsappQrRuntime(
      process.env.WHATSAPP_QR_AUTH_DIR?.trim() || join(process.cwd(), 'artifacts', 'whatsapp-qr-auth'),
      logger
    );
  }

  return new DisabledWhatsappQrRuntime();
}

export class WhatsappQrManager {
  private readonly runtimeSessions = new Map<string, RuntimeSession>();
  private readonly autoBackfillRunner: WhatsappQrAutoBackfillRunner;
  private readonly qrTtlMs: number;
  private readonly heartbeatStaleMs: number;
  private readonly alertPollMs: number;
  private readonly authRootDir: string;
  private alertTimer: NodeJS.Timeout | null = null;
  private readonly runtimeEnabled: boolean;
  private readonly chatStateCache = new Map<string, { state: WhatsappQrChatState; loadedAt: number }>();
  private readonly ignoredPhoneCache = new Map<string, { monthStart: string; loadedAt: number; phones: Set<string> }>();
  private startPromise: Promise<void> | null = null;
  private started = false;

  constructor(private readonly options: WhatsappQrManagerOptions) {
    this.qrTtlMs = options.qrTtlMs ?? Number(process.env.WHATSAPP_QR_TTL_MS ?? 90_000);
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? Number(process.env.WHATSAPP_QR_HEARTBEAT_STALE_MS ?? 180_000);
    this.alertPollMs = options.alertPollMs ?? Number(process.env.WHATSAPP_QR_ALERT_POLL_MS ?? 60_000);
    this.authRootDir =
      options.authRootDir ??
      (process.env.WHATSAPP_QR_AUTH_DIR?.trim() || join(process.cwd(), 'artifacts', 'whatsapp-qr-auth'));
    this.runtimeEnabled = process.env.WHATSAPP_QR_RUNTIME?.trim().toLowerCase() === 'baileys' || Boolean(options.runtime);
    this.autoBackfillRunner = new WhatsappQrAutoBackfillRunner(options.store, options.logger, {
      authRootDir: this.authRootDir
    });
  }

  private toCoverageCountPct(count: number, total: number): number {
    if (total <= 0) {
      return 0;
    }

    return Number(((count / total) * 100).toFixed(2));
  }

  private async buildCoverageSummary(
    ownerId: string,
    monthClients: Array<{ phoneE164: string; assignedUsername: string | null }>,
    allRows: WhatsappQrPhoneQueueRow[]
  ): Promise<WhatsappQrCoverageSummary> {
    const phones = [...new Set(monthClients.map((row) => row.phoneE164))];
    const contacts: WhatsappQrContactRecord[] =
      phones.length > 0 ? await this.options.store.listContactsByPhones({ ownerId, phoneE164s: phones }) : [];
    const contactPhones = new Set(contacts.map((contact) => contact.phoneE164));
    const portfolioTotal = monthClients.length;
    const contactsSeenCount = monthClients.filter((row) => contactPhones.has(row.phoneE164)).length;
    const signalDetectedCount = allRows.filter((row) => Boolean(row.suggestedUsername)).length;
    const assignedCount = allRows.filter((row) => Boolean(row.assignedUsername)).length;
    const noSignalCount = allRows.filter((row) => row.status === 'review' && row.reviewReason === 'no_signal').length;

    return {
      portfolioTotal,
      contactsSeenCount,
      contactsSeenPct: this.toCoverageCountPct(contactsSeenCount, portfolioTotal),
      signalDetectedCount,
      signalDetectedPct: this.toCoverageCountPct(signalDetectedCount, portfolioTotal),
      assignedCount,
      assignedPct: this.toCoverageCountPct(assignedCount, portfolioTotal),
      noSignalCount,
      noSignalPct: this.toCoverageCountPct(noSignalCount, portfolioTotal)
    };
  }

  private queueAutoBackfill(owner: WhatsappQrOwner, session: WhatsappQrSessionRecord, triggerSource: string): void {
    this.autoBackfillRunner
      .run(owner, session, triggerSource)
      .catch((error) =>
        this.options.logger.warn({ error, ownerKey: owner.ownerKey, triggerSource }, 'WhatsApp QR auto-backfill failed')
      );
  }

  private chatStateKey(ownerId: string, phoneE164: string): string {
    return `${ownerId}:${phoneE164}`;
  }

  private isCurrentMonthChat(state: WhatsappQrChatState | null | undefined): state is WhatsappQrChatState {
    if (!state?.firstMessageAt) {
      return false;
    }

    return getBuenosAiresMonthStart(new Date(state.firstMessageAt)) === resolveWhatsappQrMonthStart();
  }

  private async recordChatMessage(
    owner: WhatsappQrOwner,
    phoneE164: string,
    message: RuntimeMessageEvent
  ): Promise<WhatsappQrChatState | null> {
    const messageAt = message.messageTimestamp ?? new Date().toISOString();
    const key = this.chatStateKey(owner.ownerId, phoneE164);
    const cached = this.chatStateCache.get(key);
    if (cached && Date.now() - cached.loadedAt < 300_000 && messageAt >= cached.state.firstMessageAt) {
      return cached.state;
    }

    try {
      const state = await this.options.store.recordChatMessage({
        ownerId: owner.ownerId,
        phoneE164,
        messageAt,
        direction: message.direction
      });
      this.chatStateCache.set(key, { state, loadedAt: Date.now() });
      return state;
    } catch (error) {
      this.options.logger.warn({ error, ownerKey: owner.ownerKey, phoneE164 }, 'Could not record QR chat message');
      return cached?.state ?? null;
    }
  }

  private async getChatState(owner: WhatsappQrOwner, phoneE164: string): Promise<WhatsappQrChatState | null> {
    const key = this.chatStateKey(owner.ownerId, phoneE164);
    const cached = this.chatStateCache.get(key);
    if (cached && Date.now() - cached.loadedAt < 300_000) {
      return cached.state;
    }

    const [contact] = await this.options.store.listContactsByPhones({
      ownerId: owner.ownerId,
      phoneE164s: [phoneE164]
    });
    if (!contact?.firstMessageAt || !contact.firstMessageDirection) {
      return null;
    }

    const state: WhatsappQrChatState = {
      firstMessageAt: contact.firstMessageAt,
      firstMessageDirection: contact.firstMessageDirection,
      intakeRecordedAt: contact.intakeRecordedAt
    };
    this.chatStateCache.set(key, { state, loadedAt: Date.now() });
    return state;
  }

  private async isIgnoredPhone(owner: WhatsappQrOwner, phoneE164: string): Promise<boolean> {
    const monthStart = resolveWhatsappQrMonthStart();
    const cached = this.ignoredPhoneCache.get(owner.ownerId);
    if (cached && cached.monthStart === monthStart && Date.now() - cached.loadedAt < 300_000) {
      return cached.phones.has(phoneE164);
    }

    const phones = await this.options.store.listIgnoredPhonesForMonth({ ownerId: owner.ownerId, monthStart });
    this.ignoredPhoneCache.set(owner.ownerId, { monthStart, loadedAt: Date.now(), phones });
    return phones.has(phoneE164);
  }

  private async maybeRecordIntake(
    owner: WhatsappQrOwner,
    session: WhatsappQrSessionRecord,
    phoneE164: string,
    state: WhatsappQrChatState
  ): Promise<void> {
    if (state.intakeRecordedAt || state.firstMessageDirection !== 'inbound') {
      return;
    }
    if (await this.isIgnoredPhone(owner, phoneE164)) {
      return;
    }

    try {
      await this.options.playerPhoneStore.intakePendingCliente({
        pagina: owner.pagina,
        telefono: phoneE164,
        ownerContext: ownerContextFromWhatsappQrOwner(owner, session.phoneE164),
        sourceContext: { receivedAt: state.firstMessageAt }
      });
      const recordedAt = await this.options.store.markIntakeRecorded({ ownerId: owner.ownerId, phoneE164 });
      state.intakeRecordedAt = recordedAt ?? new Date().toISOString();
      this.options.logger.info({ ownerKey: owner.ownerKey, phoneE164 }, 'WhatsApp QR intake recorded');
    } catch (error) {
      this.options.logger.warn({ error, ownerKey: owner.ownerKey, phoneE164 }, 'WhatsApp QR intake failed');
    }
  }

  private async persistContact(owner: WhatsappQrOwner, session: WhatsappQrSessionRecord, contact: RuntimeContactEvent): Promise<string | null> {
    const phone = contact.clientPhoneE164 ?? normalizeWhatsappJidPhone(contact.remoteJid);
    if (!phone) {
      return null;
    }

    const contactStore = this.options.store as {
      upsertContact?: (input: {
        sessionId?: string | null;
        ownerId: string;
        phoneE164: string;
        contactName?: string | null;
        notify?: string | null;
        username?: string | null;
        verifiedName?: string | null;
        seenAt?: string;
      }) => Promise<unknown>;
    };
    if (typeof contactStore.upsertContact === 'function') {
      await contactStore.upsertContact({
        sessionId: session.id,
        ownerId: owner.ownerId,
        phoneE164: phone,
        contactName: contact.contactName,
        notify: contact.pushName,
        username: contact.username,
        verifiedName: contact.verifiedName,
        seenAt: new Date().toISOString()
      });
    }

    return phone;
  }

  private ownerFromSession(session: WhatsappQrSessionRecord): WhatsappQrOwner {
    return {
      ownerId: session.ownerId,
      ownerKey: session.ownerKey,
      ownerLabel: session.ownerLabel,
      pagina: session.pagina
    };
  }

  private async hasPersistedAuth(runtimeSessionId: string): Promise<boolean> {
    try {
      await access(join(this.authRootDir, safeRuntimeSessionId(runtimeSessionId), 'creds.json'));
      return true;
    } catch {
      return false;
    }
  }

  private async startRuntime(
    owner: WhatsappQrOwner,
    session: WhatsappQrSessionRecord,
    options: { resumeOnly: boolean }
  ): Promise<WhatsappQrSessionRecord> {
    if (this.runtimeSessions.has(session.id)) {
      return session;
    }

    if (options.resumeOnly && !(await this.hasPersistedAuth(session.runtimeSessionId))) {
      return this.options.store.updateSession(session.id, {
        status: 'disconnected',
        qrPayload: null,
        qrDataUrl: null,
        qrExpiresAt: null,
        lastDisconnectedAt: new Date().toISOString(),
        lastError: 'qr_auth_state_missing',
        disconnectedAlertedAt: null
      });
    }

    const runtime = this.options.runtime ?? buildWhatsappQrRuntimeFromEnv(this.options.logger);
    let currentSession = session;
    try {
      const runtimeSession = await runtime.start(
        owner,
        currentSession.runtimeSessionId,
        {
          onQr: async (qrPayload, qrDataUrl) => {
            currentSession = await this.options.store.updateSession(currentSession.id, {
              status: 'waiting_qr',
              qrPayload,
              qrDataUrl,
              qrExpiresAt: new Date(Date.now() + this.qrTtlMs).toISOString(),
              lastHeartbeatAt: new Date().toISOString(),
              lastError: null,
              qrAlertedAt: null
            });
          },
          onConnected: async (phoneE164) => {
            currentSession = await this.options.store.updateSession(currentSession.id, {
              status: 'connected',
              phoneE164,
              qrPayload: null,
              qrDataUrl: null,
              qrExpiresAt: null,
              lastConnectedAt: new Date().toISOString(),
              lastHeartbeatAt: new Date().toISOString(),
              lastError: null,
              disconnectedAlertedAt: null,
              heartbeatAlertedAt: null
            });
            this.queueAutoBackfill(owner, currentSession, options.resumeOnly ? 'resume_connected' : 'connect_connected');
          },
          onDisconnected: async (errorMessage) => {
            currentSession = await this.options.store.updateSession(currentSession.id, {
              status: 'disconnected',
              qrPayload: null,
              qrDataUrl: null,
              qrExpiresAt: null,
              lastDisconnectedAt: new Date().toISOString(),
              lastError: errorMessage,
              disconnectedAlertedAt: null
            });
            this.runtimeSessions.delete(currentSession.id);
          },
          onHeartbeat: async () => {
            currentSession = await this.options.store.updateSession(currentSession.id, {
              lastHeartbeatAt: new Date().toISOString(),
              heartbeatAlertedAt: null
            });
          },
          onMessage: async (message) => {
            const phone = normalizeWhatsappJidPhone(message.remoteJid);
            if (!phone) {
              return;
            }
            const state = await this.recordChatMessage(owner, phone, message);
            if (!this.isCurrentMonthChat(state)) {
              return;
            }
            await this.maybeRecordIntake(owner, currentSession, phone, state);
            await this.options.autoAssignService.processMessage({
              owner,
              session: currentSession,
              ...message,
              clientPhoneE164: phone
            });
          },
          onContact: async (contact) => {
            const phone = await this.persistContact(owner, currentSession, contact);
            if (!phone) {
              return;
            }
            const state = await this.getChatState(owner, phone);
            if (!this.isCurrentMonthChat(state)) {
              return;
            }
            await this.maybeRecordIntake(owner, currentSession, phone, state);
            await this.options.autoAssignService.processMessage({
              owner,
              session: currentSession,
              direction: 'contact_sync',
              remoteJid: contact.remoteJid,
              clientPhoneE164: phone,
              contactName: contact.contactName,
              pushName: contact.pushName,
              text: null
            });
          }
        },
        { resumeOnly: options.resumeOnly }
      );
      this.runtimeSessions.set(currentSession.id, runtimeSession);
      if (currentSession.status === 'connected') {
        this.queueAutoBackfill(owner, currentSession, options.resumeOnly ? 'resume_attached' : 'connect_attached');
      }
      return currentSession;
    } catch (error) {
      currentSession = await this.options.store.updateSession(currentSession.id, {
        status: options.resumeOnly ? 'disconnected' : 'error',
        qrPayload: null,
        qrDataUrl: null,
        qrExpiresAt: null,
        lastDisconnectedAt: options.resumeOnly ? new Date().toISOString() : currentSession.lastDisconnectedAt,
        lastError:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : options.resumeOnly
              ? 'qr_auth_state_invalid'
              : 'qr_runtime_start_failed'
      });
      return currentSession;
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      if (!this.alertTimer) {
        this.alertTimer = setInterval(() => {
          this.checkAlerts().catch((error) => this.options.logger.warn({ error }, 'WhatsApp QR alert check failed'));
        }, this.alertPollMs);
        this.alertTimer.unref?.();
      }

      const sessions = await this.options.store.listReconnectableSessions();
      for (const session of sessions) {
        if (session.status !== 'connected') {
          continue;
        }
        await this.startRuntime(this.ownerFromSession(session), session, { resumeOnly: true });
      }
      this.started = true;
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.startPromise = null;
    if (this.alertTimer) {
      clearInterval(this.alertTimer);
      this.alertTimer = null;
    }
    const sessions = [...this.runtimeSessions.values()];
    this.runtimeSessions.clear();
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }

  async getDashboard(owner: WhatsappQrOwner, isAdmin: boolean, month: string): Promise<WhatsappQrDashboard> {
    const ownerIds = [owner.ownerId];
    const monthWindow = buildWhatsappQrMonthWindow(month);
    const [sessions, credentialOwnerIds, monthClients, messages, matches, ignoredPhones] = await Promise.all([
      this.options.store.listSessions(ownerIds),
      this.options.store.listCredentialOwnerIds(ownerIds),
      this.options.store.listMonthClients({
        ownerId: owner.ownerId,
        monthStart: monthWindow.monthStartDate
      }),
      this.options.store.listMessagesForMonth({
        ownerId: owner.ownerId,
        createdFrom: monthWindow.startedAtIso,
        createdTo: monthWindow.endedAtIso
      }),
      this.options.store.listMatchesForMonth({
        ownerId: owner.ownerId,
        createdFrom: monthWindow.startedAtIso,
        createdTo: monthWindow.endedAtIso
      }),
      this.options.store.listIgnoredPhonesForMonth({
        ownerId: owner.ownerId,
        monthStart: monthWindow.monthStartDate
      })
    ]);
    const { summary, queue, allRows } = buildWhatsappQrPhoneQueue({
      monthClients,
      messages,
      matches,
      ignoredPhones
    });
    const coverage = await this.buildCoverageSummary(owner.ownerId, monthClients, allRows);

    return {
      sessions: sessions.map((session) => ({
        ...session,
        hasRdaCredentials: credentialOwnerIds.has(session.ownerId)
      })),
      summary,
      queue,
      coverage,
      isAdmin,
      runtimeEnabled: this.runtimeEnabled
    };
  }

  async getAdminOverview(owner: WhatsappQrOwner, month: string): Promise<WhatsappQrDashboard> {
    const monthWindow = buildWhatsappQrMonthWindow(month);
    const sessions = await this.options.store.listSessions(null);
    const ownerById = new Map<string, WhatsappQrOwner>();
    ownerById.set(owner.ownerId, owner);
    for (const session of sessions) {
      ownerById.set(session.ownerId, this.ownerFromSession(session));
    }

    const ownerIds = [...ownerById.keys()];
    const credentialOwnerIds = await this.options.store.listCredentialOwnerIds(ownerIds);
    const safeSessions = sessions.map((session) => ({
      ...session,
      hasRdaCredentials: credentialOwnerIds.has(session.ownerId)
    }));
    const sessionByOwnerId = new Map(safeSessions.map((session) => [session.ownerId, session]));
    const ownerSummaries = [];
    let totalPhones = 0;
    let assigned = 0;
    let review = 0;
    let ignored = 0;
    let noSignal = 0;
    let detectedUnassigned = 0;
    let notFound = 0;
    let conflict = 0;
    let technicalError = 0;

    for (const selectedOwner of ownerById.values()) {
      const [monthClients, messages, matches, ignoredPhones] = await Promise.all([
        this.options.store.listMonthClients({
          ownerId: selectedOwner.ownerId,
          monthStart: monthWindow.monthStartDate
        }),
        this.options.store.listMessagesForMonth({
          ownerId: selectedOwner.ownerId,
          createdFrom: monthWindow.startedAtIso,
          createdTo: monthWindow.endedAtIso
        }),
        this.options.store.listMatchesForMonth({
          ownerId: selectedOwner.ownerId,
          createdFrom: monthWindow.startedAtIso,
          createdTo: monthWindow.endedAtIso
        }),
        this.options.store.listIgnoredPhonesForMonth({
          ownerId: selectedOwner.ownerId,
          monthStart: monthWindow.monthStartDate
        })
      ]);
      const built = buildWhatsappQrPhoneQueue({ monthClients, messages, matches, ignoredPhones });
      ownerSummaries.push({
        owner: selectedOwner,
        session: sessionByOwnerId.get(selectedOwner.ownerId) ?? null,
        summary: built.summary
      });
      totalPhones += built.summary.totalPhones;
      assigned += built.summary.assigned;
      review += built.summary.review;
      ignored += built.summary.ignored;
      noSignal += built.summary.noSignal;
      detectedUnassigned += built.summary.detectedUnassigned;
      notFound += built.summary.notFound;
      conflict += built.summary.conflict;
      technicalError += built.summary.technicalError;
    }

    return {
      sessions: safeSessions,
      summary: {
        totalPhones,
        assigned,
        review,
        ignored,
        noSignal,
        detectedUnassigned,
        notFound,
        conflict,
        technicalError
      },
      queue: [],
      isAdmin: true,
      runtimeEnabled: this.runtimeEnabled,
      ownerSummaries
    };
  }

  async connect(owner: WhatsappQrOwner): Promise<WhatsappQrSessionRecord> {
    const now = new Date().toISOString();
    const session = await this.options.store.upsertSession(owner, {
      status: 'waiting_qr',
      qrPayload: null,
      qrDataUrl: null,
      qrExpiresAt: new Date(Date.now() + this.qrTtlMs).toISOString(),
      lastError: null,
      lastHeartbeatAt: now
    });

    return this.startRuntime(owner, session, { resumeOnly: false });
  }

  async disconnect(owner: WhatsappQrOwner): Promise<WhatsappQrSessionRecord> {
    const session = await this.options.store.upsertSession(owner, {});
    const runtimeSession = this.runtimeSessions.get(session.id);
    if (runtimeSession) {
      await runtimeSession.stop().catch((error) => this.options.logger.warn({ error }, 'Could not stop QR runtime session'));
      this.runtimeSessions.delete(session.id);
    }

    return this.options.store.updateSession(session.id, {
      status: 'disconnected',
      qrPayload: null,
      qrDataUrl: null,
      qrExpiresAt: null,
      lastDisconnectedAt: new Date().toISOString(),
      lastError: null
    });
  }

  async checkAlerts(): Promise<void> {
    const now = new Date();
    const staleSessions = await this.options.store.listStaleSessions({
      heartbeatBefore: new Date(now.getTime() - this.heartbeatStaleMs).toISOString(),
      qrExpiredBefore: now.toISOString()
    });

    for (const session of staleSessions) {
      const alertKind =
        session.status === 'connected'
          ? 'heartbeat'
          : session.status === 'waiting_qr'
            ? 'qr'
            : session.status === 'disconnected'
              ? 'disconnected'
              : null;
      if (!alertKind) {
        continue;
      }
      const title =
        alertKind === 'heartbeat'
          ? 'heartbeat vencido'
          : alertKind === 'qr'
            ? 'QR vencido sin conectar'
            : 'sesion desconectada';
      const timestamp = now.toISOString();
      await this.options.telegramAlerts.send({
        title,
        ownerKey: session.ownerKey,
        ownerLabel: session.ownerLabel,
        status: session.status,
        phoneE164: session.phoneE164,
        timestamp,
        detail: session.lastError
      });
      await this.options.store.markAlerted(session.id, alertKind, timestamp);
    }
  }
}
