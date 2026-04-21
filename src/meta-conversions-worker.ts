import type { Logger } from 'pino';
import type { MetaConversionsDispatcher, MetaConversionsDispatchError } from './meta-conversions';
import type { MetaConversionLease, MetaConversionsStore, MetaValueSignalScanOptions } from './meta-conversions-store';

export interface MetaConversionsWorkerOptions {
  concurrency: number;
  pollMs: number;
  maxPollMs?: number;
  leaseSeconds: number;
  maxAttempts: number;
  scanLimit: number;
  scanEnabled?: boolean;
  scanOptions?: MetaValueSignalScanOptions;
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
  private readonly maxPollMs: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly scanLimit: number;
  private readonly scanEnabled: boolean;
  private readonly scanOptions: MetaValueSignalScanOptions;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private pumping = false;
  private stopping = false;
  private currentPollMs: number;
  private idleLoggedPollMs: number | null = null;

  constructor(
    private readonly store: MetaConversionsStore,
    private readonly dispatcher: MetaConversionsDispatcher,
    private readonly logger: Logger,
    options: MetaConversionsWorkerOptions
  ) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency));
    this.pollMs = Math.max(100, Math.trunc(options.pollMs));
    this.maxPollMs = Math.max(this.pollMs, Math.trunc(options.maxPollMs ?? Math.max(this.pollMs * 6, 30_000)));
    this.leaseSeconds = Math.max(1, Math.trunc(options.leaseSeconds));
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
    this.scanLimit = Math.max(1, Math.trunc(options.scanLimit));
    this.scanEnabled = options.scanEnabled ?? true;
    this.scanOptions = options.scanOptions ?? {};
    this.batchSize = Math.max(1, Math.trunc(options.batchSize ?? 1));
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
    let scannedSignals = 0;
    try {
      if (this.scanEnabled) {
        scannedSignals = await this.store.scanForValueSignals(this.scanLimit, this.scanOptions);
      }

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
      const hadActivity = claimedInThisPump > 0 || scannedSignals > 0 || this.active > 0;
      if (hadActivity) {
        if (this.idleLoggedPollMs !== null) {
          this.logger.info({ pollMs: this.pollMs }, 'Meta conversions worker resumed active polling');
        }
        this.currentPollMs = this.pollMs;
        this.idleLoggedPollMs = null;
      } else {
        this.currentPollMs =
          this.currentPollMs >= this.maxPollMs ? this.maxPollMs : Math.min(this.maxPollMs, this.currentPollMs * 2);
        if (this.idleLoggedPollMs !== this.currentPollMs) {
          this.logger.info({ nextPollMs: this.currentPollMs }, 'Meta conversions worker idle; backing off polling');
          this.idleLoggedPollMs = this.currentPollMs;
        }
      }

      this.scheduleNextPump(this.active > 0 ? this.pollMs : this.currentPollMs);
    }
  }

  private async processLease(lease: MetaConversionLease): Promise<void> {
    try {
      const result = await this.dispatcher.dispatch(lease);
      await this.store.markSent({
        id: lease.id,
        requestPayload: result.requestBody,
        responseStatus: result.responseStatus,
        responseBody: result.responseBody,
        fbtraceId: result.fbtraceId
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const dispatchError = error as Partial<MetaConversionsDispatchError> | null;
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
        await this.store.markFailed({
          id: lease.id,
          error: message,
          requestPayload:
            dispatchError && typeof dispatchError === 'object' && 'requestBody' in dispatchError
              ? dispatchError.requestBody
              : undefined,
          responseStatus:
            dispatchError && typeof dispatchError === 'object' && 'statusCode' in dispatchError
              ? (dispatchError.statusCode as number | undefined)
              : undefined,
          responseBody:
            dispatchError && typeof dispatchError === 'object' && 'responseBody' in dispatchError
              ? dispatchError.responseBody
              : undefined,
          fbtraceId:
            dispatchError && typeof dispatchError === 'object' && 'fbtraceId' in dispatchError
              ? (dispatchError.fbtraceId as string | null | undefined)
              : undefined
        });
        return;
      }

      const retryAfterSeconds = lease.attempts >= lease.maxAttempts - 1 ? 300 : 60;
      await this.store.markRetry({
        id: lease.id,
        error: message,
        retryAfterSeconds,
        requestPayload:
          dispatchError && typeof dispatchError === 'object' && 'requestBody' in dispatchError
            ? dispatchError.requestBody
            : undefined,
        responseStatus:
          dispatchError && typeof dispatchError === 'object' && 'statusCode' in dispatchError
            ? (dispatchError.statusCode as number | undefined)
            : undefined,
        responseBody:
          dispatchError && typeof dispatchError === 'object' && 'responseBody' in dispatchError
            ? dispatchError.responseBody
            : undefined,
        fbtraceId:
          dispatchError && typeof dispatchError === 'object' && 'fbtraceId' in dispatchError
            ? (dispatchError.fbtraceId as string | null | undefined)
            : undefined
      });
    }
  }
}
