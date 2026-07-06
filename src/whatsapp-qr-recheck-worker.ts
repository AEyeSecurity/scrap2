import type { Logger } from 'pino';
import type { AppConfig } from './types';
import { PlayerPhoneStoreError, type PlayerPhoneStore } from './player-phone-store';
import { RdaUserCheckError, type AssertRdaUserExistsInput } from './rda-user-check';
import { extractUsernameFromContactName } from './whatsapp-qr-parser';
import {
  ownerContextFromWhatsappQrOwner,
  type WhatsappQrMatchRecord,
  type WhatsappQrRecheckQueueRecord,
  type WhatsappQrSessionRecord,
  type WhatsappQrStore
} from './whatsapp-qr-store';

export interface WhatsappQrRecheckWorkerOptions {
  pollMs: number;
  batchSize: number;
  runOnStart: boolean;
}

const RECHECK_DELAYS_MS = [
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000
];

function addDelay(date: Date, attempts: number): string {
  const delay = RECHECK_DELAYS_MS[Math.min(Math.max(0, attempts), RECHECK_DELAYS_MS.length - 1)];
  return new Date(date.getTime() + delay).toISOString();
}

function phoneToJid(phoneE164: string): string {
  return `${phoneE164.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
}

function matchAttemptAt(match: WhatsappQrMatchRecord): string {
  return match.assignedAt ?? match.updatedAt ?? match.rdaValidatedAt ?? match.createdAt;
}

function pickLatestMatch(matches: WhatsappQrMatchRecord[]): WhatsappQrMatchRecord | null {
  return matches
    .slice()
    .sort((left, right) => matchAttemptAt(right).localeCompare(matchAttemptAt(left)))[0] ?? null;
}

export class WhatsappQrRecheckWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: WhatsappQrStore,
    private readonly playerPhoneStore: PlayerPhoneStore,
    private readonly rdaUserExistsChecker: (input: AssertRdaUserExistsInput) => Promise<void>,
    private readonly appConfig: AppConfig,
    private readonly logger: Logger,
    private readonly options: WhatsappQrRecheckWorkerOptions
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    if (this.options.runOnStart) {
      this.pump().catch((error) => this.logger.error({ error }, 'WhatsApp QR recheck worker failed on start'));
    }
    this.timer = setInterval(() => {
      this.pump().catch((error) => this.logger.error({ error }, 'WhatsApp QR recheck worker failed'));
    }, Math.max(60_000, this.options.pollMs));
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pump(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const nowIso = new Date().toISOString();
      const rows = await this.store.listDueRechecks({
        nowIso,
        limit: this.options.batchSize
      });
      for (const row of rows) {
        await this.processRow(row, nowIso).catch((error) =>
          this.logger.warn({ error, recheckId: row.id, ownerId: row.ownerId }, 'WhatsApp QR recheck row failed')
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async processRow(row: WhatsappQrRecheckQueueRecord, nowIso: string): Promise<void> {
    if (row.expiresAt <= nowIso) {
      await this.store.updateRecheck(row.id, {
        status: 'expired',
        attempts: row.attempts + 1,
        lastError: null
      });
      return;
    }

    const session = await this.store.getSessionByOwner(row.ownerId);
    if (!session) {
      await this.reschedule(row, 'qr_session_missing');
      return;
    }

    const monthStart = row.monthStart;
    const [monthClients, contacts, messages, matches] = await Promise.all([
      this.store.listMonthClients({ ownerId: row.ownerId, monthStart }),
      this.store.listContactsByPhones({ ownerId: row.ownerId, phoneE164s: [row.phoneE164] }),
      this.store.listMessagesForMonth({
        ownerId: row.ownerId,
        createdFrom: `${monthStart}T03:00:00.000Z`,
        createdTo: this.nextMonthStartedAt(monthStart)
      }),
      this.store.listMatchesForMonth({
        ownerId: row.ownerId,
        createdFrom: `${monthStart}T03:00:00.000Z`,
        createdTo: this.nextMonthStartedAt(monthStart)
      })
    ]);

    const monthClient = monthClients.find((client) => client.phoneE164 === row.phoneE164);
    if (monthClient?.assignedUsername) {
      await this.store.updateRecheck(row.id, {
        status: 'done',
        attempts: row.attempts + 1,
        lastError: null
      });
      return;
    }

    const phoneMatches = matches.filter((match) => match.clientPhoneE164 === row.phoneE164);
    const assignedMatch = phoneMatches.find((match) => match.status === 'assigned');
    if (assignedMatch) {
      await this.store.updateRecheck(row.id, {
        status: 'done',
        attempts: row.attempts + 1,
        lastError: null
      });
      return;
    }

    const reusableMatch =
      pickLatestMatch(phoneMatches.filter((match) => match.status === 'candidate' || match.status === 'error')) ??
      pickLatestMatch(
        messages
          .filter((message) => message.clientPhoneE164 === row.phoneE164 && message.candidateUsername && message.matchSource)
          .map((message) => ({
            id: '',
            sessionId: message.sessionId,
            ownerId: message.ownerId,
            messageId: message.id,
            pagina: 'RdA' as const,
            clientPhoneE164: message.clientPhoneE164,
            username: message.candidateUsername!,
            source: message.matchSource!,
            status: 'candidate' as const,
            rdaValidatedAt: null,
            assignedAt: null,
            errorMessage: null,
            createdAt: message.createdAt,
            updatedAt: message.createdAt
          }))
      );

    if (reusableMatch && reusableMatch.id) {
      const done = await this.retryMatch(row, session, reusableMatch);
      if (done) {
        return;
      }
    }
    if (reusableMatch && !reusableMatch.id) {
      const done = await this.assignUsername(row, session, reusableMatch.username);
      if (done) {
        await this.store.updateRecheck(row.id, {
          status: 'done',
          attempts: row.attempts + 1,
          lastError: null
        });
        return;
      }
    }

    const contactCandidate = contacts
      .map((contact) => extractUsernameFromContactName(contact.contactName))
      .find((candidate): candidate is string => Boolean(candidate));
    if (contactCandidate) {
      const existingContactMatch = phoneMatches.find(
        (match) => match.username === contactCandidate && match.source === 'contact_name'
      );
      if (existingContactMatch) {
        const done = await this.retryMatch(row, session, existingContactMatch);
        if (done) {
          return;
        }
      }

      const created = await this.assignUsername(row, session, contactCandidate);
      if (created) {
        await this.store.updateRecheck(row.id, {
          status: 'done',
          attempts: row.attempts + 1,
          lastError: null
        });
        return;
      }
    }

    await this.reschedule(row, 'no_assignable_signal');
  }

  private nextMonthStartedAt(monthStart: string): string {
    const [yearToken, monthToken] = monthStart.split('-');
    const year = Number(yearToken);
    const month = Number(monthToken);
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T03:00:00.000Z`;
  }

  private async retryMatch(
    row: WhatsappQrRecheckQueueRecord,
    session: WhatsappQrSessionRecord,
    match: WhatsappQrMatchRecord
  ): Promise<boolean> {
    const assigned = await this.assignUsername(row, session, match.username);
    if (!assigned) {
      return false;
    }
    await this.store.updateMatch(match.id, {
      status: 'assigned',
      rdaValidatedAt: new Date().toISOString(),
      assignedAt: new Date().toISOString(),
      errorMessage: null
    });
    await this.store.updateRecheck(row.id, {
      status: 'done',
      attempts: row.attempts + 1,
      lastError: null
    });
    return true;
  }

  private async assignUsername(
    row: WhatsappQrRecheckQueueRecord,
    session: WhatsappQrSessionRecord,
    username: string
  ): Promise<boolean> {
    const owner = {
      ownerId: session.ownerId,
      ownerKey: session.ownerKey,
      ownerLabel: session.ownerLabel,
      pagina: session.pagina,
      telefono: session.phoneE164
    };
    const credentials = await this.store.getRdaCredential(row.ownerId);
    if (!credentials) {
      await this.reschedule(row, 'missing_rda_credentials');
      return false;
    }

    try {
      await this.rdaUserExistsChecker({
        usuario: username,
        agente: credentials.loginUsername,
        contrasenaAgente: credentials.loginPassword,
        appConfig: this.appConfig,
        logger: this.logger
      });
      await this.playerPhoneStore.assignUsernameByPhone({
        pagina: 'RdA',
        jugadorUsername: username,
        telefono: row.phoneE164,
        ownerContext: ownerContextFromWhatsappQrOwner(owner, session.phoneE164)
      });
      return true;
    } catch (error) {
      if (error instanceof RdaUserCheckError && error.code === 'NOT_FOUND') {
        await this.reschedule(row, error.message);
        return false;
      }
      if (error instanceof PlayerPhoneStoreError && error.code === 'CONFLICT') {
        await this.reschedule(row, error.message);
        return false;
      }
      await this.reschedule(row, error instanceof Error ? error.message : 'recheck_assignment_failed');
      return false;
    }
  }

  private async reschedule(row: WhatsappQrRecheckQueueRecord, lastError: string): Promise<void> {
    const attempts = row.attempts + 1;
    await this.store.updateRecheck(row.id, {
      attempts,
      nextRunAt: addDelay(new Date(), attempts),
      lastError
    });
  }
}
