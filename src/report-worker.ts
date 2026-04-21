import type { Logger } from 'pino';
import { runAsnReportJob } from './asn-report-job';
import { runRdaReportJob } from './rda-report-job';
import type { AppConfig, AsnReportJobRequest, JobExecutionOptions, RdaReportJobRequest, ReportJobResult } from './types';
import type { ReportRunLease, ReportRunStore } from './report-run-store';

export type ReportJobExecutor = (lease: ReportRunLease) => Promise<ReportJobResult>;

export interface ReportRunWorkerOptions {
  concurrency: number;
  pollMs: number;
  maxPollMs?: number;
  leaseSeconds: number;
  maxAttempts: number;
}

export class ReportRunWorker {
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly maxPollMs: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly executor: ReportJobExecutor;
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
    try {
      const result = await this.executor(lease);
      await this.store.completeRunItem(lease, result);
      await this.store.upsertDailySnapshot(lease, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: message, runId: lease.runId, username: lease.username }, 'Report item failed');
      await this.store.failRunItem(lease, message);
    }

    try {
      const run = await this.store.refreshRunStatus(lease.runId);
      if (['completed', 'completed_with_errors', 'failed'].includes(run.status)) {
        await this.store.createOutboxEntry(run.id);
      }
    } catch (error) {
      this.logger.error({ error, runId: lease.runId }, 'Could not refresh report run state');
    }
  }
}

export function createReportJobExecutor(
  appConfig: AppConfig,
  logger: Logger,
  options: JobExecutionOptions
): ReportJobExecutor {
  return async (lease) => {
    const baseRequest = {
      id: `report-run-${lease.runId}-${lease.itemId}`,
      jobType: 'report' as const,
      createdAt: new Date().toISOString(),
      options
    };

    const execution =
      lease.pagina === 'RdA'
        ? await runRdaReportJob(
            {
              ...baseRequest,
              payload: {
                pagina: 'RdA',
                operacion: 'reporte',
                usuario: lease.username,
                agente: lease.agente,
                contrasena_agente: lease.contrasenaAgente
              }
            } satisfies RdaReportJobRequest,
            appConfig,
            logger
          )
        : await runAsnReportJob(
            {
              ...baseRequest,
              payload: {
                pagina: 'ASN',
                operacion: 'reporte',
                usuario: lease.username,
                agente: lease.agente,
                contrasena_agente: lease.contrasenaAgente
              }
            } satisfies AsnReportJobRequest,
            appConfig,
            logger
          );
    if (!execution.result || !['asn-reporte-cargado-mes', 'rda-reporte-deposito-total'].includes(execution.result.kind)) {
      throw new Error(`Report job did not return a supported report result for pagina=${lease.pagina}`);
    }

    return execution.result as ReportJobResult;
  };
}
