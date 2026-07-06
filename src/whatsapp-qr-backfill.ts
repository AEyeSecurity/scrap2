import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { launchChromiumBrowser, configureContext } from './browser';
import { buildAppConfig } from './config';
import { createLogger } from './logging';
import { createPlayerPhoneStoreFromEnv } from './player-phone-store';
import { fetchRdaAgentId, resolveRdaUserByApi } from './rda-user-api';
import { resolveSiteAppConfig } from './site-profile';
import { WhatsappQrAutoAssignService } from './whatsapp-qr-service';
import {
  createWhatsappQrStoreFromEnv,
  type WhatsappQrMatchStatus,
  type WhatsappQrMatchSource,
  type WhatsappQrOwner,
  type WhatsappQrSessionRecord
} from './whatsapp-qr-store';

type BackfillAttemptStatus = WhatsappQrMatchStatus | 'no_candidate' | 'not_seen';
type PhoneClassification = 'direct' | 'chat' | 'unmatched';

interface BackfillAttempt {
  source: WhatsappQrMatchSource;
  candidateUsername: string | null;
  status: BackfillAttemptStatus;
  errorMessage: string | null;
}

interface PhoneBackfillState {
  phone: string;
  contactName: string | null;
  seenContact: boolean;
  seenOutbound: boolean;
  direct: BackfillAttempt;
  chatAttempts: BackfillAttempt[];
}

export interface WhatsappQrBackfillPhoneReport {
  phone: string;
  classification: PhoneClassification;
  contactName: string | null;
  direct: BackfillAttempt;
  chat: BackfillAttempt;
  seenContact: boolean;
  seenOutbound: boolean;
}

export interface WhatsappQrBackfillSummary {
  ownerKey: string;
  monthStart: string;
  totalPhones: number;
  directMatched: number;
  chatMatched: number;
  unmatched: number;
  directCandidatePhones: number;
  chatCandidatePhones: number;
  unmatchedNoSignal: number;
  unmatchedWithSignalOnly: number;
  unmatchedWithConflict: number;
  unmatchedWithNotFound: number;
  unmatchedWithError: number;
}

export interface WhatsappQrBackfillResult {
  summary: WhatsappQrBackfillSummary;
  phones: WhatsappQrBackfillPhoneReport[];
  outputPath: string;
}

export interface RunWhatsappQrMonthBackfillInput {
  ownerKey: string;
  monthStart: string;
  authRootDir?: string;
  historyLogPath?: string;
  outputPath?: string;
  historyTimeoutMs?: number;
  idleWindowMs?: number;
  logger?: Logger;
}

function safeRuntimeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function attemptRank(status: BackfillAttemptStatus): number {
  switch (status) {
    case 'assigned':
      return 7;
    case 'validated':
      return 6;
    case 'conflict':
      return 5;
    case 'not_found':
      return 4;
    case 'error':
      return 3;
    case 'candidate':
      return 2;
    case 'no_candidate':
      return 1;
    case 'not_seen':
    default:
      return 0;
  }
}

function preferredAttempt(attempts: BackfillAttempt[]): BackfillAttempt {
  if (attempts.length === 0) {
    return {
      source: 'outbound_message',
      candidateUsername: null,
      status: 'not_seen',
      errorMessage: null
    };
  }

  return attempts.reduce((best, current) => (attemptRank(current.status) > attemptRank(best.status) ? current : best));
}

export function summarizeWhatsappQrBackfill(
  ownerKey: string,
  monthStart: string,
  states: Iterable<PhoneBackfillState>
): { summary: WhatsappQrBackfillSummary; phones: WhatsappQrBackfillPhoneReport[] } {
  const phones = [...states]
    .sort((left, right) => left.phone.localeCompare(right.phone))
    .map((state) => {
      const bestChat = preferredAttempt(state.chatAttempts);
      const classification: PhoneClassification =
        state.direct.status === 'assigned' ? 'direct' : bestChat.status === 'assigned' ? 'chat' : 'unmatched';

      return {
        phone: state.phone,
        classification,
        contactName: state.contactName,
        direct: state.direct,
        chat: bestChat,
        seenContact: state.seenContact,
        seenOutbound: state.seenOutbound
      };
    });

  const unmatchedPhones = phones.filter((phone) => phone.classification === 'unmatched');

  const summary: WhatsappQrBackfillSummary = {
    ownerKey,
    monthStart,
    totalPhones: phones.length,
    directMatched: phones.filter((phone) => phone.classification === 'direct').length,
    chatMatched: phones.filter((phone) => phone.classification === 'chat').length,
    unmatched: phones.filter((phone) => phone.classification === 'unmatched').length,
    directCandidatePhones: phones.filter((phone) => phone.direct.candidateUsername !== null).length,
    chatCandidatePhones: phones.filter((phone) => phone.chat.candidateUsername !== null).length,
    unmatchedNoSignal: unmatchedPhones.filter(
      (phone) => phone.direct.status === 'not_seen' && phone.chat.status === 'not_seen'
    ).length,
    unmatchedWithSignalOnly: unmatchedPhones.filter(
      (phone) =>
        !['conflict', 'not_found', 'error'].includes(phone.direct.status) &&
        !['conflict', 'not_found', 'error'].includes(phone.chat.status) &&
        !(phone.direct.status === 'not_seen' && phone.chat.status === 'not_seen')
    ).length,
    unmatchedWithConflict: unmatchedPhones.filter(
      (phone) => phone.direct.status === 'conflict' || phone.chat.status === 'conflict'
    ).length,
    unmatchedWithNotFound: unmatchedPhones.filter(
      (phone) => phone.direct.status === 'not_found' || phone.chat.status === 'not_found'
    ).length,
    unmatchedWithError: unmatchedPhones.filter((phone) => phone.direct.status === 'error' || phone.chat.status === 'error').length
  };

  return { summary, phones };
}

function createEmptyState(phone: string): PhoneBackfillState {
  return {
    phone,
    contactName: null,
    seenContact: false,
    seenOutbound: false,
    direct: {
      source: 'contact_name',
      candidateUsername: null,
      status: 'not_seen',
      errorMessage: null
    },
    chatAttempts: []
  };
}

async function persistBackfillContact(
  store: ReturnType<typeof createWhatsappQrStoreFromEnv>,
  owner: WhatsappQrOwner,
  session: WhatsappQrSessionRecord,
  input: {
    remoteJid: string;
    clientPhoneE164?: string | null;
    contactName?: string | null;
    pushName?: string | null;
    username?: string | null;
    verifiedName?: string | null;
    seenAt?: string | null;
  }
): Promise<string | null> {
  const contactStore = store as {
    upsertContact?: (payload: {
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
  const normalizedPhone =
    input.clientPhoneE164?.trim() ||
    (() => {
      const raw = input.remoteJid.split('@')[0]?.replace(/[^0-9]/g, '');
      return raw ? `+${raw}` : null;
    })();

  if (typeof contactStore.upsertContact !== 'function' || !normalizedPhone) {
    return normalizedPhone ?? null;
  }

  await contactStore.upsertContact({
    sessionId: session.id,
    ownerId: owner.ownerId,
    phoneE164: normalizedPhone,
    contactName: input.contactName ?? null,
    notify: input.pushName ?? null,
    username: input.username ?? null,
    verifiedName: input.verifiedName ?? null,
    seenAt: input.seenAt ?? new Date().toISOString()
  });

  return normalizedPhone;
}

interface HistoryReplayNotification {
  time: string;
  histNotification: any;
}

function stripAnsiCodes(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

async function loadLatestBootstrapNotifications(logPath: string): Promise<HistoryReplayNotification[]> {
  const raw = await readFile(logPath, 'utf8');
  const notifications = raw
    .split(/\r?\n/)
    .flatMap((line) => {
      const normalized = stripAnsiCodes(line).trim();
      if (!normalized.startsWith('{')) {
        return [];
      }

      try {
        const parsed = JSON.parse(normalized) as { time?: string; histNotification?: any; msg?: string };
        if (parsed.msg !== 'got history notification' || !parsed.histNotification || typeof parsed.time !== 'string') {
          return [];
        }

        return [
          {
            time: parsed.time,
            histNotification: parsed.histNotification
          } satisfies HistoryReplayNotification
        ];
      } catch {
        return [];
      }
    })
    .filter((item) =>
      ['INITIAL_BOOTSTRAP', 'RECENT', 'FULL'].includes(String(item.histNotification?.syncType ?? '').trim().toUpperCase())
    );

  let bootstrapIndex = -1;
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    if (String(notifications[index]?.histNotification?.syncType ?? '').trim().toUpperCase() === 'INITIAL_BOOTSTRAP') {
      bootstrapIndex = index;
      break;
    }
  }
  if (bootstrapIndex < 0) {
    throw new Error(`No INITIAL_BOOTSTRAP history notification found in ${logPath}`);
  }

  return notifications.slice(bootstrapIndex);
}

function resolveHistoryRemoteJid(remoteJid: string | null | undefined, lidToPn: Map<string, string>): string | null {
  if (!remoteJid) {
    return null;
  }

  return lidToPn.get(remoteJid) ?? remoteJid;
}

function normalizeHistoryNotificationForReplay(histNotification: any): any {
  if (
    histNotification &&
    typeof histNotification === 'object' &&
    typeof histNotification.initialHistBootstrapInlinePayload === 'string'
  ) {
    return {
      ...histNotification,
      initialHistBootstrapInlinePayload: Buffer.from(histNotification.initialHistBootstrapInlinePayload, 'base64')
    };
  }

  return histNotification;
}

async function withLoggedRdaPage(
  owner: WhatsappQrOwner,
  logger: Logger,
  loginUsername: string,
  loginPassword: string,
  callback: (input: { page: import('playwright').Page; agentId: string }) => Promise<void>
): Promise<void> {
  const appConfig = buildAppConfig({});
  const rdaConfig = resolveSiteAppConfig(appConfig, owner.pagina);
  const runtimeConfig = {
    ...rdaConfig,
    headless: true,
    debug: false,
    slowMo: 0,
    timeoutMs: Math.min(Math.max(rdaConfig.timeoutMs, 8_000), 20_000),
    blockResources: true,
    postLoginWarmupPath: undefined
  };

  const browser = await launchChromiumBrowser(runtimeConfig, logger);
  const context = await browser.newContext({
    baseURL: runtimeConfig.baseUrl,
    viewport: { width: 1920, height: 1080 }
  });

  try {
    await configureContext(context, runtimeConfig, logger);
    const page = await context.newPage();
    await ensureAuthenticated(
      context,
      page,
      runtimeConfig,
      {
        username: loginUsername,
        password: loginPassword
      },
      logger,
      { persistSession: false }
    );
    const agentId = await fetchRdaAgentId(page, runtimeConfig.timeoutMs);
    await callback({ page, agentId });
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export async function runWhatsappQrMonthBackfill(input: RunWhatsappQrMonthBackfillInput): Promise<WhatsappQrBackfillResult> {
  const logger = input.logger ?? createLogger('info', true);
  const store = createWhatsappQrStoreFromEnv();
  const playerPhoneStore = createPlayerPhoneStoreFromEnv();
  const owner = await store.resolveOwnerByKey('RdA', input.ownerKey);
  if (!owner) {
    throw new Error(`Owner not found for ${input.ownerKey}`);
  }

  const session = await store.getSessionByOwner(owner.ownerId);
  if (!session) {
    throw new Error(`WhatsApp QR session not found for ${input.ownerKey}`);
  }

  const credential = await store.getRdaCredential(owner.ownerId);
  if (!credential) {
    throw new Error(`RdA credential not found for ${input.ownerKey}`);
  }

  const monthlyPhones = await store.listOwnerClientPhonesForMonth({
    ownerId: owner.ownerId,
    monthStart: input.monthStart
  });
  if (monthlyPhones.size === 0) {
    throw new Error(`No month phones found for ${input.ownerKey} in ${input.monthStart}`);
  }

  const states = new Map<string, PhoneBackfillState>();
  for (const phone of monthlyPhones) {
    states.set(phone, createEmptyState(phone));
  }

  const historyTimeoutMs = input.historyTimeoutMs ?? 180_000;
  const idleWindowMs = input.idleWindowMs ?? 15_000;
  const authRootDir = input.authRootDir?.trim() || process.env.WHATSAPP_QR_AUTH_DIR?.trim() || join(process.cwd(), 'artifacts', 'whatsapp-qr-auth');
  const sessionDir = join(authRootDir, safeRuntimeSessionId(session.runtimeSessionId));

  const appConfig = buildAppConfig({});
  await mkdir(resolve(process.cwd(), 'out'), { recursive: true });

  await withLoggedRdaPage(owner, logger, credential.loginUsername, credential.loginPassword, async ({ page, agentId }) => {
    const rdaUserExistsChecker = async ({ usuario }: { usuario: string }) => {
      await resolveRdaUserByApi(page, usuario, 10_000, agentId);
    };

    const autoAssignService = new WhatsappQrAutoAssignService({
      appConfig,
      logger,
      store,
      playerPhoneStore,
      rdaUserExistsChecker: (input) => rdaUserExistsChecker({ usuario: input.usuario })
    });

    const attemptedContactCandidates = new Set<string>();
    const attemptedChatCandidates = new Set<string>();
    let lastActivityAt = Date.now();
    let queue = Promise.resolve();

    const touch = (): void => {
      lastActivityAt = Date.now();
    };

    const enqueue = (task: () => Promise<void>): void => {
      queue = queue
        .then(task)
        .catch((error) => logger.warn({ error, ownerKey: owner.ownerKey }, 'WhatsApp QR backfill event failed'));
    };

    const processDirect = async (event: {
      remoteJid: string;
      clientPhoneE164?: string | null;
      contactName?: string | null;
      pushName?: string | null;
      username?: string | null;
      verifiedName?: string | null;
      messageTimestamp?: string | null;
    }): Promise<void> => {
      const normalized = await persistBackfillContact(store, owner, session, event);
      if (!normalized) {
        return;
      }
      const state = states.get(normalized);
      if (!state) {
        return;
      }
      state.seenContact = true;
      state.contactName = event.contactName ?? state.contactName;
      touch();

      const dedupeKey = `${normalized}::${(event.contactName ?? '').trim().toLowerCase()}`;
      if (attemptedContactCandidates.has(dedupeKey)) {
        return;
      }
      attemptedContactCandidates.add(dedupeKey);

      const result = await autoAssignService.processMessage({
        owner,
        session,
        direction: 'contact_sync',
        remoteJid: event.remoteJid,
        contactName: event.contactName ?? null,
        pushName: event.pushName ?? null,
        text: null,
        messageTimestamp: event.messageTimestamp ?? null
      });
      state.direct = {
        source: 'contact_name',
        candidateUsername: result.message?.candidateUsername ?? null,
        status: result.match?.status ?? (result.message?.candidateUsername ? 'candidate' : 'no_candidate'),
        errorMessage: result.match?.errorMessage ?? null
      };
    };

    const processOutbound = async (event: {
      remoteJid: string;
      messageId?: string | null;
      contactName?: string | null;
      pushName?: string | null;
      text?: string | null;
      messageTimestamp?: string | null;
    }): Promise<void> => {
      const phone = event.remoteJid.split('@')[0]?.replace(/[^0-9]/g, '');
      if (!phone) {
        return;
      }
      const normalized = `+${phone}`;
      const state = states.get(normalized);
      if (!state) {
        return;
      }
      state.seenOutbound = true;
      touch();

      if (state.direct.status === 'assigned') {
        return;
      }

      const dedupeKey = `${normalized}::${(event.text ?? '').trim().toLowerCase()}`;
      if (attemptedChatCandidates.has(dedupeKey)) {
        return;
      }
      attemptedChatCandidates.add(dedupeKey);

      const result = await autoAssignService.processMessage({
        owner,
        session,
        direction: 'outbound',
        remoteJid: event.remoteJid,
        messageId: event.messageId ?? null,
        contactName: event.contactName ?? null,
        pushName: event.pushName ?? null,
        text: event.text ?? null,
        messageTimestamp: event.messageTimestamp ?? null
      });
      state.chatAttempts.push({
        source: 'outbound_message',
        candidateUsername: result.message?.candidateUsername ?? null,
        status: result.match?.status ?? (result.message?.candidateUsername ? 'candidate' : 'no_candidate'),
        errorMessage: result.match?.errorMessage ?? null
      });
    };

    const extractText = (message: any): string | null =>
      message?.message?.conversation ??
      message?.message?.extendedTextMessage?.text ??
      message?.message?.imageMessage?.caption ??
      message?.message?.videoMessage?.caption ??
      null;

    const extractContactName = (contact: any): string | null => contact?.name ?? contact?.notify ?? contact?.verifiedName ?? null;

    const timestampToIso = (value: any): string | null =>
      typeof value === 'number'
        ? new Date(value * 1000).toISOString()
        : value?.low
          ? new Date(Number(value.low) * 1000).toISOString()
          : null;

    if (input.historyLogPath?.trim()) {
      const { downloadAndProcessHistorySyncNotification } = (await import(
        '@whiskeysockets/baileys/lib/Utils/history.js'
      )) as any;
      const notifications = await loadLatestBootstrapNotifications(resolve(input.historyLogPath.trim()));
      const lidToPn = new Map<string, string>();

      for (const notification of notifications) {
        const data = await downloadAndProcessHistorySyncNotification(
          normalizeHistoryNotificationForReplay(notification.histNotification),
          {},
          logger
        );
        touch();

        for (const mapping of data.lidPnMappings ?? []) {
          if (typeof mapping?.lid === 'string' && typeof mapping?.pn === 'string') {
            lidToPn.set(mapping.lid, mapping.pn);
          }
        }

        for (const contact of data.contacts ?? []) {
          const remoteJid = resolveHistoryRemoteJid(
            typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : contact?.id ?? null,
            lidToPn
          );
          if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
            continue;
          }
          enqueue(() =>
            processDirect({
              remoteJid,
              clientPhoneE164: typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : null,
              contactName: extractContactName(contact),
              pushName: contact?.notify ?? null,
              username: contact?.username ?? null,
              verifiedName: contact?.verifiedName ?? null
            })
          );
        }

        for (const item of data.messages ?? []) {
          const remoteJid = resolveHistoryRemoteJid(item?.key?.remoteJid ?? null, lidToPn);
          if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || !item?.key?.fromMe) {
            continue;
          }
          enqueue(() =>
            processOutbound({
              remoteJid,
              messageId: item.key?.id ?? null,
              contactName: null,
              pushName: item.pushName ?? null,
              text: extractText(item),
              messageTimestamp: timestampToIso(item.messageTimestamp)
            })
          );
        }
      }
    } else {
      const baileys = (await import('@whiskeysockets/baileys')) as any;
      const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir);
      let connectionOpened = false;

      const sock = baileys.default({
        auth: state,
        printQRInTerminal: false,
        browser: ['MasterCRM', 'Chrome', '1.0.0']
      });

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update: any) => {
        if (update.connection === 'open') {
          connectionOpened = true;
          touch();
        }
        if (update.connection === 'close') {
          touch();
        }
      });
      sock.ev.on('contacts.update', (contacts: any[]) => {
        for (const contact of contacts ?? []) {
          const contactName = extractContactName(contact);
          if (!contact?.id) {
            continue;
          }
          enqueue(() =>
            processDirect({
              remoteJid: contact.id,
              clientPhoneE164: typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : null,
              contactName,
              pushName: contact.notify ?? null,
              username: contact?.username ?? null,
              verifiedName: contact?.verifiedName ?? null
            })
          );
        }
      });
      sock.ev.on('contacts.upsert', (contacts: any[]) => {
        for (const contact of contacts ?? []) {
          const contactName = extractContactName(contact);
          if (!contact?.id) {
            continue;
          }
          enqueue(() =>
            processDirect({
              remoteJid: contact.id,
              clientPhoneE164: typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : null,
              contactName,
              pushName: contact.notify ?? null,
              username: contact?.username ?? null,
              verifiedName: contact?.verifiedName ?? null
            })
          );
        }
      });
      sock.ev.on('messages.upsert', (payload: any) => {
        for (const item of payload.messages ?? []) {
          const remoteJid = item.key?.remoteJid ?? null;
          if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || !item.key?.fromMe) {
            continue;
          }
          enqueue(() =>
            processOutbound({
              remoteJid,
              messageId: item.key?.id ?? null,
              contactName: null,
              pushName: item.pushName ?? null,
              text: extractText(item),
              messageTimestamp: timestampToIso(item.messageTimestamp)
            })
          );
        }
      });
      sock.ev.on('messaging-history.set', (payload: any) => {
        touch();
        for (const contact of payload.contacts ?? []) {
          const contactName = extractContactName(contact);
          if (!contact?.id) {
            continue;
          }
          enqueue(() =>
            processDirect({
              remoteJid: contact.id,
              clientPhoneE164: typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : null,
              contactName,
              pushName: contact.notify ?? null,
              username: contact?.username ?? null,
              verifiedName: contact?.verifiedName ?? null
            })
          );
        }
        for (const item of payload.messages ?? []) {
          const remoteJid = item.key?.remoteJid ?? null;
          if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || !item.key?.fromMe) {
            continue;
          }
          enqueue(() =>
            processOutbound({
              remoteJid,
              messageId: item.key?.id ?? null,
              contactName: null,
              pushName: item.pushName ?? null,
              text: extractText(item),
              messageTimestamp: timestampToIso(item.messageTimestamp)
            })
          );
        }
      });

      const startedAt = Date.now();
      while (Date.now() - startedAt < historyTimeoutMs) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        if (connectionOpened && Date.now() - lastActivityAt >= idleWindowMs) {
          break;
        }
      }

      await queue;

      try {
        sock.end?.(new Error('WhatsApp QR month backfill completed'));
      } catch {
        sock.ws?.close?.();
      }
    }

    await queue;
  });

  const { summary, phones } = summarizeWhatsappQrBackfill(owner.ownerKey, input.monthStart, states.values());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath =
    input.outputPath?.trim() ||
    resolve(process.cwd(), 'out', `whatsapp-qr-backfill-${safeRuntimeSessionId(owner.ownerKey)}-${input.monthStart}-${timestamp}.json`);
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        owner: {
          ownerId: owner.ownerId,
          ownerKey: owner.ownerKey,
          ownerLabel: owner.ownerLabel,
          pagina: owner.pagina
        },
        session: {
          id: session.id,
          runtimeSessionId: session.runtimeSessionId,
          phoneE164: session.phoneE164
        },
        summary,
        phones
      },
      null,
      2
    )
  );

  logger.info({ outputPath, summary }, 'WhatsApp QR monthly backfill completed');

  return {
    summary,
    phones,
    outputPath
  };
}
