import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { TelegramAlertSender } from './telegram-alerts';
import type { WhatsappQrAutoAssignService } from './whatsapp-qr-service';
import {
  buildWhatsappQrPhoneQueue,
  type WhatsappQrPhoneQueueRow,
  type WhatsappQrQueueSummary
} from './whatsapp-qr-dashboard';
import type {
  UpsertWhatsappQrSessionPatch,
  WhatsappQrOwner,
  WhatsappQrSessionRecord,
  WhatsappQrStore
} from './whatsapp-qr-store';
import { normalizeWhatsappJidPhone } from './whatsapp-qr-parser';

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
  isAdmin: boolean;
  runtimeEnabled: boolean;
  ownerSummaries?: Array<{
    owner: WhatsappQrOwner;
    session: (WhatsappQrSessionRecord & { hasRdaCredentials: boolean }) | null;
    summary: WhatsappQrQueueSummary;
  }>;
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
        printQRInTerminal: false,
        browser: ['MasterCRM', 'Chrome', '1.0.0']
      });

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('contacts.update', (updates: any[]) => {
        for (const contact of updates ?? []) {
          const contactName = extractSavedContactName(contact);
          if (contact?.id && contactName) {
            contactNames.set(contact.id, contactName);
          }
          if (contact?.id) {
            handlers.onContact({
              remoteJid: contact.id,
              clientPhoneE164: normalizeWhatsappJidPhone(contact.phoneNumber ?? contact.id),
              contactName: extractSavedContactName(contact),
              pushName: contact.notify ?? null,
              username: contact.username ?? null,
              verifiedName: contact.verifiedName ?? null
            }).catch((error) => this.logger.warn({ error, ownerKey: owner.ownerKey }, 'QR contact update processing failed'));
          }
        }
      });
      sock.ev.on('contacts.upsert', (contacts: any[]) => {
        for (const contact of contacts ?? []) {
          const contactName = extractSavedContactName(contact);
          if (contact?.id && contactName) {
            contactNames.set(contact.id, contactName);
          }
          if (contact?.id) {
            handlers.onContact({
              remoteJid: contact.id,
              clientPhoneE164: normalizeWhatsappJidPhone(contact.phoneNumber ?? contact.id),
              contactName: extractSavedContactName(contact),
              pushName: contact.notify ?? null,
              username: contact.username ?? null,
              verifiedName: contact.verifiedName ?? null
            }).catch((error) => this.logger.warn({ error, ownerKey: owner.ownerKey }, 'QR contact upsert processing failed'));
          }
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
          const remoteJid = item.key?.remoteJid ?? null;
          if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
            continue;
          }
          const direction = item.key?.fromMe ? 'outbound' : 'inbound';
          const timestampValue = item.messageTimestamp;
          const timestamp =
            typeof timestampValue === 'number'
              ? new Date(timestampValue * 1000).toISOString()
              : timestampValue?.low
                ? new Date(Number(timestampValue.low) * 1000).toISOString()
                : null;
          await handlers.onMessage({
            direction,
            remoteJid,
            messageId: item.key?.id ?? null,
            contactName: contactNames.get(remoteJid) ?? null,
            pushName: item.pushName ?? null,
            text: extractText(item),
            messageTimestamp: timestamp
          });
        }
        await handlers.onHeartbeat();
      });
      sock.ev.on('messaging-history.set', async (payload: any) => {
        for (const contact of payload.contacts ?? []) {
          const contactName = extractSavedContactName(contact);
          if (contact?.id && contactName) {
            contactNames.set(contact.id, contactName);
          }
          if (contact?.id) {
            await handlers.onContact({
              remoteJid: contact.id,
              clientPhoneE164: normalizeWhatsappJidPhone(contact.phoneNumber ?? contact.id),
              contactName: extractSavedContactName(contact),
              pushName: contact.notify ?? null,
              username: contact.username ?? null,
              verifiedName: contact.verifiedName ?? null
            });
          }
        }

        for (const item of payload.messages ?? []) {
          const remoteJid = item.key?.remoteJid ?? null;
          if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
            continue;
          }
          const direction = item.key?.fromMe ? 'outbound' : 'inbound';
          const timestampValue = item.messageTimestamp;
          const timestamp =
            typeof timestampValue === 'number'
              ? new Date(timestampValue * 1000).toISOString()
              : timestampValue?.low
                ? new Date(Number(timestampValue.low) * 1000).toISOString()
                : null;
          await handlers.onMessage({
            direction,
            remoteJid,
            messageId: item.key?.id ?? null,
            contactName: contactNames.get(remoteJid) ?? null,
            pushName: item.pushName ?? null,
            text: extractText(item),
            messageTimestamp: timestamp,
            isHistory: true
          });
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
  private readonly qrTtlMs: number;
  private readonly heartbeatStaleMs: number;
  private readonly alertPollMs: number;
  private readonly authRootDir: string;
  private alertTimer: NodeJS.Timeout | null = null;
  private readonly runtimeEnabled: boolean;
  private readonly monthlyPhoneCache = new Map<string, { monthStart: string; loadedAt: number; phones: Set<string> }>();
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
  }

  private async getMonthlyPhones(owner: WhatsappQrOwner): Promise<Set<string>> {
    const monthStart = resolveWhatsappQrMonthStart();
    const cached = this.monthlyPhoneCache.get(owner.ownerId);
    if (cached && cached.monthStart === monthStart && Date.now() - cached.loadedAt < 300_000) {
      return cached.phones;
    }

    const phones = await this.options.store.listOwnerClientPhonesForMonth({
      ownerId: owner.ownerId,
      monthStart
    });
    this.monthlyPhoneCache.set(owner.ownerId, {
      monthStart,
      loadedAt: Date.now(),
      phones
    });
    return phones;
  }

  private async isMonthlyClient(owner: WhatsappQrOwner, remoteJid?: string | null, clientPhoneE164?: string | null): Promise<boolean> {
    const phone = clientPhoneE164 ?? normalizeWhatsappJidPhone(remoteJid);
    if (!phone) {
      return false;
    }

    const phones = await this.getMonthlyPhones(owner);
    return phones.has(phone);
  }

  private async persistContact(owner: WhatsappQrOwner, session: WhatsappQrSessionRecord, contact: RuntimeContactEvent): Promise<string | null> {
    const phone = contact.clientPhoneE164 ?? normalizeWhatsappJidPhone(contact.remoteJid);
    if (!phone) {
      return null;
    }

    const upsertContact = (this.options.store as any).upsertContact as
      | ((input: {
          sessionId?: string | null;
          ownerId: string;
          phoneE164: string;
          contactName?: string | null;
          notify?: string | null;
          username?: string | null;
          verifiedName?: string | null;
          seenAt?: string;
        }) => Promise<unknown>)
      | undefined;
    if (upsertContact) {
      await upsertContact({
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
            if (message.isHistory && !(await this.isMonthlyClient(owner, message.remoteJid))) {
              return;
            }
            await this.options.autoAssignService.processMessage({
              owner,
              session: currentSession,
              ...message
            });
          },
          onContact: async (contact) => {
            const phone = await this.persistContact(owner, currentSession, contact);
            if (!(await this.isMonthlyClient(owner, contact.remoteJid, phone))) {
              return;
            }
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
    const { summary, queue } = buildWhatsappQrPhoneQueue({
      monthClients,
      messages,
      matches,
      ignoredPhones
    });

    return {
      sessions: sessions.map((session) => ({
        ...session,
        hasRdaCredentials: credentialOwnerIds.has(session.ownerId)
      })),
      summary,
      queue,
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
