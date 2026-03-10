import type { Logger } from 'pino';
import { runAsnReportJob } from './asn-report-job';
import type { AppConfig, AsnReportJobRequest, AsnReportJobResult, JobExecutionOptions } from './types';
import type { ReportRunLease, ReportRunStore } from './report-run-store';

export type ReportJobExecutor = (lease: ReportRunLease) => Promise<AsnReportJobResult>;

export interface ReportRunWorkerOptions {
  concurrency: number;
  pollMs: number;
  leaseSeconds: number;
  maxAttempts: number;
}

export class ReportRunWorker {
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly executor: ReportJobExecutor;
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private pumping = false;
  private stopping = false;

  constructor(
    private readonly store: ReportRunStore,
    private readonly logger: Logger,
    options: ReportRunWorkerOptions,
    executor: ReportJobExecutor
  ) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency));
    this.pollMs = Math.max(100, Math.trunc(options.pollMs));
    this.leaseSeconds = Math.max(1, Math.trunc(options.leaseSeconds));
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
    this.executor = executor;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.stopping = false;
    this.timer = setInterval(() => {
      void this.pump();
    }, this.pollMs);
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

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) {
      return;
    }

    this.pumping = true;
    try {
      while (!this.stopping && this.active < this.concurrency) {
        const lease = await this.store.leaseNextRunItem(this.leaseSeconds, this.maxAttempts);
        if (!lease) {
          break;
        }

        this.active += 1;
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
    const request: AsnReportJobRequest = {
      id: `report-run-${lease.runId}-${lease.itemId}`,
      jobType: 'report',
      createdAt: new Date().toISOString(),
      payload: {
        pagina: 'ASN',
        operacion: 'reporte',
        usuario: lease.username,
        agente: lease.agente,
        contrasena_agente: lease.contrasenaAgente
      },
      options
    };

    const execution = await runAsnReportJob(request, appConfig, logger);
    if (!execution.result || execution.result.kind !== 'asn-reporte-cargado-mes') {
      throw new Error('Report job did not return an ASN report result');
    }

    return execution.result;
  };
}
