import type { Logger } from 'pino';
import type { MetaConversionsDispatcher, MetaConversionsDispatchError } from './meta-conversions';
import type { MetaConversionLease, MetaConversionsStore, MetaValueSignalScanOptions } from './meta-conversions-store';

export interface MetaConversionsWorkerOptions {
  concurrency: number;
  pollMs: number;
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
    this.scanEnabled = options.scanEnabled ?? true;
    this.scanOptions = options.scanOptions ?? {};
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
      if (this.scanEnabled) {
        await this.store.scanForValueSignals(this.scanLimit, this.scanOptions);
      }

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
