import type { Logger } from 'pino';
import { buildWhatsappQrPhoneQueue } from './whatsapp-qr-dashboard';
import { runWhatsappQrMonthBackfill, type WhatsappQrBackfillResult } from './whatsapp-qr-backfill';
import type { WhatsappQrOwner, WhatsappQrSessionRecord, WhatsappQrStore } from './whatsapp-qr-store';

const AUTO_BACKFILL_THROTTLE_MS = 6 * 60 * 60_000;

function getBuenosAiresMonthStart(input = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(input);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return year && month ? `${year}-${month}-01` : `${input.toISOString().slice(0, 7)}-01`;
}

function buildMonthWindow(monthStart: string): { createdFrom: string; createdTo: string } {
  const [yearToken, monthToken] = monthStart.split('-');
  const year = Number(yearToken);
  const monthIndex = Number(monthToken) - 1;
  const nextMonthYear = monthIndex === 11 ? year + 1 : year;
  const nextMonthIndex = (monthIndex + 1) % 12;

  return {
    createdFrom: new Date(Date.UTC(year, monthIndex, 1, 3, 0, 0, 0)).toISOString(),
    createdTo: new Date(Date.UTC(nextMonthYear, nextMonthIndex, 1, 3, 0, 0, 0)).toISOString()
  };
}

function isoTimeOrZero(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export interface WhatsappQrAutoBackfillRunnerOptions {
  authRootDir?: string;
  now?: () => Date;
  runBackfill?: (input: { ownerKey: string; monthStart: string; authRootDir?: string; logger: Logger }) => Promise<WhatsappQrBackfillResult>;
}

export interface WhatsappQrAutoBackfillRunResult {
  status: 'completed' | 'skipped';
  reason?: 'throttled' | 'already_running';
  monthStart: string;
  rechecksEnqueued: number;
  noSignalRows: number;
}

export class WhatsappQrAutoBackfillRunner {
  private readonly activeRuns = new Set<string>();

  constructor(
    private readonly store: WhatsappQrStore,
    private readonly logger: Logger,
    private readonly options: WhatsappQrAutoBackfillRunnerOptions = {}
  ) {}

  async run(owner: WhatsappQrOwner, session: WhatsappQrSessionRecord, triggerSource: string): Promise<WhatsappQrAutoBackfillRunResult> {
    const now = this.options.now?.() ?? new Date();
    const monthStart = getBuenosAiresMonthStart(now);
    const activeKey = `${owner.ownerId}:${monthStart}`;
    if (this.activeRuns.has(activeKey)) {
      return {
        status: 'skipped',
        reason: 'already_running',
        monthStart,
        rechecksEnqueued: 0,
        noSignalRows: 0
      };
    }

    this.activeRuns.add(activeKey);
    let runRowId: string | null = null;

    try {
      const latestRun = await this.store.getLatestBackfillRun({
        ownerId: owner.ownerId,
        monthStart
      });
      if (
        latestRun?.status === 'completed' &&
        isoTimeOrZero(latestRun.lastCompletedAt) >= now.getTime() - AUTO_BACKFILL_THROTTLE_MS
      ) {
        return {
          status: 'skipped',
          reason: 'throttled',
          monthStart,
          rechecksEnqueued: 0,
          noSignalRows: 0
        };
      }

      const startedAt = (this.options.now?.() ?? new Date()).toISOString();
      const runRow = await this.store.createBackfillRun({
        ownerId: owner.ownerId,
        sessionId: session.id,
        monthStart,
        triggerSource,
        startedAt
      });
      runRowId = runRow.id;

      const runBackfill =
        this.options.runBackfill ??
        (async (input: { ownerKey: string; monthStart: string; authRootDir?: string; logger: Logger }) =>
          runWhatsappQrMonthBackfill({
            ownerKey: input.ownerKey,
            monthStart: input.monthStart,
            authRootDir: input.authRootDir,
            logger: input.logger
          }));

      const backfillResult = await runBackfill({
        ownerKey: owner.ownerKey,
        monthStart,
        authRootDir: this.options.authRootDir,
        logger: this.logger
      });

      const recheckResult = await this.enqueueNoSignalRechecks(owner.ownerId, session.id, monthStart);
      const finishedAt = (this.options.now?.() ?? new Date()).toISOString();

      await this.store.updateBackfillRun(runRowId, {
        status: 'completed',
        finishedAt,
        lastCompletedAt: finishedAt,
        lastError: null,
        summaryJson: {
          backfill: backfillResult.summary,
          noSignalRows: recheckResult.noSignalRows,
          rechecksEnqueued: recheckResult.rechecksEnqueued
        }
      });

      return {
        status: 'completed',
        monthStart,
        rechecksEnqueued: recheckResult.rechecksEnqueued,
        noSignalRows: recheckResult.noSignalRows
      };
    } catch (error) {
      const finishedAt = (this.options.now?.() ?? new Date()).toISOString();
      if (runRowId) {
        await this.store.updateBackfillRun(runRowId, {
          status: 'failed',
          finishedAt,
          lastError: error instanceof Error ? error.message : 'whatsapp_qr_auto_backfill_failed',
          summaryJson: null
        });
      }
      throw error;
    } finally {
      this.activeRuns.delete(activeKey);
    }
  }

  private async enqueueNoSignalRechecks(
    ownerId: string,
    sessionId: string,
    monthStart: string
  ): Promise<{ noSignalRows: number; rechecksEnqueued: number }> {
    const monthWindow = buildMonthWindow(monthStart);
    const [monthClients, messages, matches, ignoredPhones] = await Promise.all([
      this.store.listMonthClients({ ownerId, monthStart }),
      this.store.listMessagesForMonth({
        ownerId,
        createdFrom: monthWindow.createdFrom,
        createdTo: monthWindow.createdTo
      }),
      this.store.listMatchesForMonth({
        ownerId,
        createdFrom: monthWindow.createdFrom,
        createdTo: monthWindow.createdTo
      }),
      this.store.listIgnoredPhonesForMonth({
        ownerId,
        monthStart
      })
    ]);

    const { allRows } = buildWhatsappQrPhoneQueue({
      monthClients,
      messages,
      matches,
      ignoredPhones
    });
    const noSignalRows = allRows.filter((row) => row.status === 'review' && row.reviewReason === 'no_signal');
    const nowIso = (this.options.now?.() ?? new Date()).toISOString();

    for (const row of noSignalRows) {
      await this.store.enqueueRecheck({
        ownerId,
        sessionId,
        monthStart,
        phoneE164: row.phoneE164,
        reason: 'backfill_no_signal',
        nextRunAt: nowIso
      });
    }

    return {
      noSignalRows: noSignalRows.length,
      rechecksEnqueued: noSignalRows.length
    };
  }
}
