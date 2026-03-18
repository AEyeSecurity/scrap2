import type { Logger } from 'pino';
import type { MetaConversionsDispatcher, MetaConversionsDispatchError } from './meta-conversions';
import type { MetaConversionLease, MetaConversionsStore } from './meta-conversions-store';

export interface MetaConversionsWorkerOptions {
  concurrency: number;
  pollMs: number;
  leaseSeconds: number;
  maxAttempts: number;
  scanLimit: number;
  batchSize?: number;
}

function isRetryableError(error: unknown): error is MetaConversionsDispatchError {
  return (
    error instanceof Error &&
    'retryable' in error &&
    typeof (error as { retryable?: unknown }).retryable === 'boolean' &&
    (error as { retryable: boolean }).retryable
  );
}

export class MetaConversionsWorker {
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly scanLimit: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private pumping = false;
  private stopping = false;

  constructor(
    private readonly store: MetaConversionsStore,
    private readonly dispatcher: MetaConversionsDispatcher,
    private readonly logger: Logger,
    options: MetaConversionsWorkerOptions
  ) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency));
    this.pollMs = Math.max(100, Math.trunc(options.pollMs));
    this.leaseSeconds = Math.max(1, Math.trunc(options.leaseSeconds));
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
    this.scanLimit = Math.max(1, Math.trunc(options.scanLimit));
    this.batchSize = Math.max(1, Math.trunc(options.batchSize ?? 1));
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
      await this.store.scanForQualifiedLeads(this.scanLimit);

      let claimedInThisPump = 0;
      while (
        !this.stopping &&
        this.active < this.concurrency &&
        claimedInThisPump < this.batchSize
      ) {
        const lease = await this.store.leaseNextEvent(this.leaseSeconds, this.maxAttempts);
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
      this.logger.error({ error }, 'Meta conversions worker pump failed');
    } finally {
      this.pumping = false;
    }
  }

  private async processLease(lease: MetaConversionLease): Promise<void> {
    try {
      await this.dispatcher.dispatch(lease);
      await this.store.markSent(lease.id);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          error: message,
          ownerId: lease.ownerId,
          clientId: lease.clientId,
          eventStage: lease.eventStage
        },
        'Meta conversion dispatch failed'
      );

      if (lease.attempts >= lease.maxAttempts || !isRetryableError(error)) {
        await this.store.markFailed(lease.id, message);
        return;
      }

      const retryAfterSeconds = lease.attempts >= lease.maxAttempts - 1 ? 300 : 60;
      await this.store.markRetry(lease.id, message, retryAfterSeconds);
    }
  }
}
