import type { Logger } from 'pino';
import type { AppConfig, JobExecutionOptions, ReportJobResult } from './types';
import type { ReportRunLease, ReportRunStore } from './report-run-store';
import type { TelegramAlertSender } from './telegram-alerts';
import {
  RunAuthenticatedReportSessionManager,
  type PlatformReportSessionManager
} from './report-browser-session';
import {
  createPlatformReportAdapters,
  isPlatformAuthenticationFailure,
  PlatformAuthenticationError
} from './platform-report-adapter';

export type ReportJobExecutor = {
  (lease: ReportRunLease): Promise<ReportJobResult>;
  closeRun?: (runId: string) => Promise<void>;
};

export interface ReportRunWorkerOptions {
  concurrency: number;
  pollMs: number;
  maxPollMs?: number;
  leaseSeconds: number;
  maxAttempts: number;
  alertSender?: TelegramAlertSender;
  asnEnabled?: boolean;
  expectedScheduleStartHour?: number;
  expectedScheduleEndHour?: number;
}

export class ReportRunWorker {
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly maxPollMs: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly executor: ReportJobExecutor;
  private readonly alertSender?: TelegramAlertSender;
  private readonly asnEnabled: boolean;
  private readonly expectedScheduleStartHour: number;
  private readonly expectedScheduleEndHour: number;
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private pumping = false;
  private stopping = false;
  private currentPollMs: number;
  private idleLoggedPollMs: number | null = null;

  constructor(
    private readonly store: ReportRunStore,
    private readonly logger: Logger,
    options: ReportRunWorkerOptions,
    executor: ReportJobExecutor
  ) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency));
    this.pollMs = Math.max(100, Math.trunc(options.pollMs));
    this.maxPollMs = Math.max(this.pollMs, Math.trunc(options.maxPollMs ?? Math.max(this.pollMs * 6, 30_000)));
    this.leaseSeconds = Math.max(1, Math.trunc(options.leaseSeconds));
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
    this.executor = executor;
    this.alertSender = options.alertSender;
    this.asnEnabled = options.asnEnabled ?? false;
    this.expectedScheduleStartHour = Math.min(23, Math.max(0, Math.trunc(options.expectedScheduleStartHour ?? 2)));
    this.expectedScheduleEndHour = Math.min(23, Math.max(0, Math.trunc(options.expectedScheduleEndHour ?? 6)));
    this.currentPollMs = this.pollMs;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.stopping = false;
    this.currentPollMs = this.pollMs;
    this.idleLoggedPollMs = null;
    void this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    while (this.active > 0 || this.pumping) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private scheduleNextPump(delayMs: number): void {
    if (this.stopping) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, Math.max(25, delayMs));
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) {
      return;
    }

    this.pumping = true;
    let claimedInThisPump = 0;
    try {
      while (!this.stopping && this.active < this.concurrency) {
        const lease = await this.store.leaseNextRunItem(this.leaseSeconds, this.maxAttempts);
        if (!lease) {
          break;
        }

        this.active += 1;
        claimedInThisPump += 1;
        void this.processLease(lease).finally(() => {
          this.active -= 1;
          if (!this.stopping) {
            setImmediate(() => {
              void this.pump();
            });
          }
        });
      }
    } catch (error) {
      this.logger.error({ error }, 'Report run worker pump failed');
    } finally {
      this.pumping = false;
      const hadActivity = claimedInThisPump > 0 || this.active > 0;
      if (hadActivity) {
        if (this.idleLoggedPollMs !== null) {
          this.logger.info({ pollMs: this.pollMs }, 'Report run worker resumed active polling');
        }
        this.currentPollMs = this.pollMs;
        this.idleLoggedPollMs = null;
      } else {
        this.currentPollMs =
          this.currentPollMs >= this.maxPollMs ? this.maxPollMs : Math.min(this.maxPollMs, this.currentPollMs * 2);
        if (this.idleLoggedPollMs !== this.currentPollMs) {
          this.logger.info({ nextPollMs: this.currentPollMs }, 'Report run worker idle; backing off polling');
          this.idleLoggedPollMs = this.currentPollMs;
        }
      }

      this.scheduleNextPump(this.active > 0 ? this.pollMs : this.currentPollMs);
    }
  }

  private async processLease(lease: ReportRunLease): Promise<void> {
    const heartbeatMs = Math.max(1_000, Math.trunc((this.leaseSeconds * 1000) / 3));
    const heartbeat = this.store.renewRunItemLease
      ? setInterval(() => {
          this.store
            .renewRunItemLease?.(lease, this.leaseSeconds)
            .catch((error) => this.logger.error({ error, itemId: lease.itemId }, 'Could not renew report item lease'));
        }, heartbeatMs)
      : null;
    heartbeat?.unref?.();
    try {
      await this.processLeaseResult(lease);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private async processLeaseResult(lease: ReportRunLease): Promise<void> {
    let result: ReportJobResult | null = null;
    try {
      if (lease.pagina === 'ASN' && !this.asnEnabled) {
        throw new Error('ASN_REPORTS_DISABLED');
      }
      result = await this.executor(lease);
      const completed = await this.store.completeRunItem(lease, result);
      if (completed === false) {
        this.logger.warn({ runId: lease.runId, itemId: lease.itemId }, 'Discarded result from expired report lease');
        await this.sendOperationalAlert(lease, 'Lease de reporte vencido', 'lease_expired');
        result = null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: message, runId: lease.runId, username: lease.username }, 'Report item failed');
      const failed = await this.store.failRunItem(lease, message);
      if (
        failed !== false &&
        (message.startsWith('PLATFORM_AUTH_FAILED') || message === 'ASN_REPORTS_DISABLED') &&
        this.store.failRemainingRunItems
      ) {
        await this.store.failRemainingRunItems(
          lease.runId,
          message,
          message.startsWith('PLATFORM_AUTH_FAILED') ? lease.ownerId : undefined
        );
        if (message.startsWith('PLATFORM_AUTH_FAILED')) {
          await this.sendOperationalAlert(lease, 'Autenticación de plataforma fallida', 'platform_auth_failed', message);
        }
      }
    }

    // Snapshot persistence and QR rechecks are downstream side effects. Once
    // the scrape itself is marked done, a side-effect failure must never turn
    // the item back into a retry and repeat the external scrape.
    if (result) {
      try {
        await this.store.upsertDailySnapshot(lease, result);
      } catch (error) {
        this.logger.error({ error, runId: lease.runId, itemId: lease.itemId }, 'Could not persist report snapshot');
      }

      try {
        await this.store.enqueueWhatsappQrRecheckFromSnapshot?.(lease, result);
      } catch (error) {
        this.logger.error({ error, runId: lease.runId, itemId: lease.itemId }, 'Could not enqueue WhatsApp QR recheck');
      }
    }

    try {
      const run = await this.store.refreshRunStatus(lease.runId);
      if (['completed', 'completed_with_errors', 'failed'].includes(run.status)) {
        await this.store.createOutboxEntry(run.id);
        if (run.totalItems > 0 && (run.doneItems < run.totalItems || run.failedItems > 0)) {
          await this.sendOperationalAlert(
            lease,
            'Cobertura de reporte incompleta',
            'coverage_incomplete',
            `${run.doneItems}/${run.totalItems} completos; ${run.failedItems} fallidos`
          );
        }
        if (!this.isWithinExpectedSchedule(run.requestedAt)) {
          await this.sendOperationalAlert(
            lease,
            'Corrida fuera de horario',
            'outside_expected_schedule',
            `Solicitada ${run.requestedAt}; ventana BA ${this.expectedScheduleStartHour}:00-${this.expectedScheduleEndHour}:59`
          );
        }
        await this.executor.closeRun?.(run.id);
      }
    } catch (error) {
      this.logger.error({ error, runId: lease.runId }, 'Could not refresh report run state');
    }
  }

  private async sendOperationalAlert(
    lease: ReportRunLease,
    title: string,
    status: string,
    detail?: string
  ): Promise<void> {
    if (!this.alertSender) return;
    try {
      await this.alertSender.send({
        title,
        ownerKey: lease.ownerKey,
        ownerLabel: lease.ownerLabel,
        status,
        timestamp: new Date().toISOString(),
        detail: detail ?? null
      });
    } catch (error) {
      this.logger.error({ error, runId: lease.runId, alertStatus: status }, 'Could not send report operational alert');
    }
  }

  private isWithinExpectedSchedule(requestedAt: string): boolean {
    const date = new Date(requestedAt);
    if (Number.isNaN(date.getTime())) return false;
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Argentina/Buenos_Aires',
        hour: '2-digit',
        hourCycle: 'h23'
      }).format(date)
    );
    if (!Number.isInteger(hour)) return false;
    return this.expectedScheduleStartHour <= this.expectedScheduleEndHour
      ? hour >= this.expectedScheduleStartHour && hour <= this.expectedScheduleEndHour
      : hour >= this.expectedScheduleStartHour || hour <= this.expectedScheduleEndHour;
  }
}

export function createReportJobExecutor(
  appConfig: AppConfig,
  logger: Logger,
  options: JobExecutionOptions,
  providedSessionManager?: PlatformReportSessionManager
): ReportJobExecutor {
  const sessionManager =
    providedSessionManager ?? new RunAuthenticatedReportSessionManager(appConfig, logger, options);
  const adapters = createPlatformReportAdapters(appConfig, logger, options, sessionManager);
  const authenticationFailures = new Map<string, PlatformAuthenticationError>();
  const executor: ReportJobExecutor = async (lease) => {
    const authenticationKey = `${lease.runId}:${lease.ownerId}`;
    const previousAuthFailure = authenticationFailures.get(authenticationKey);
    if (previousAuthFailure) {
      throw previousAuthFailure;
    }
    try {
      return await adapters[lease.pagina].execute(lease);
    } catch (error) {
      if (isPlatformAuthenticationFailure(error)) {
        const authError = new PlatformAuthenticationError(
          lease.pagina,
          error instanceof Error ? error.message : String(error),
          { cause: error }
        );
        authenticationFailures.set(authenticationKey, authError);
        throw authError;
      }
      throw error;
    }
  };
  executor.closeRun = async (runId) => {
    const runPrefix = `${runId}:`;
    for (const key of authenticationFailures.keys()) {
      if (key.startsWith(runPrefix)) authenticationFailures.delete(key);
    }
    await sessionManager.closeRun(runId);
  };
  return executor;
}
