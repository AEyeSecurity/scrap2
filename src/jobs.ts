import pLimit from 'p-limit';
import type { Logger } from 'pino';
import type { JobExecutionResult, JobRequest, JobResult, JobStatus, JobStoreEntry } from './types';

interface JobManagerOptions {
  concurrency: number;
  ttlMinutes: number;
  logger: Logger;
  executor: (request: JobRequest) => Promise<JobExecutionResult>;
}

function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'expired';
}

function toMillis(isoDate: string | undefined): number | null {
  if (!isoDate) {
    return null;
  }

  const value = Date.parse(isoDate);
  return Number.isNaN(value) ? null : value;
}

function cloneJobResult(result: JobResult | undefined): JobResult | undefined {
  if (!result) {
    return undefined;
  }

  return { ...result };
}

export class JobManager {
  private readonly entries = new Map<string, JobStoreEntry>();

  private readonly limiter;

  private readonly ttlMs: number;

  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly options: JobManagerOptions) {
    this.limiter = pLimit(options.concurrency);
    this.ttlMs = options.ttlMinutes * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.cleanupExpiredJobs(), 60 * 1000);
    this.cleanupTimer.unref();
  }

  enqueue(request: JobRequest): string {
    this.entries.set(request.id, {
      id: request.id,
      jobType: request.jobType,
      status: 'queued',
      createdAt: request.createdAt,
      artifactPaths: [],
      steps: []
    });

    void this.limiter(async () => {
      const startedAt = new Date().toISOString();
      this.entries.set(request.id, {
        ...(this.entries.get(request.id) as JobStoreEntry),
        status: 'running',
        startedAt
      });

      try {
        const result = await this.options.executor(request);
        const finishedAt = new Date().toISOString();
        this.entries.set(request.id, {
          ...(this.entries.get(request.id) as JobStoreEntry),
          status: 'succeeded',
          finishedAt,
          artifactPaths: result.artifactPaths,
          steps: result.steps,
          result: cloneJobResult(result.result)
        });
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        const errorWithContext = error as Error & {
          artifactPaths?: string[];
          steps?: JobStoreEntry['steps'];
        };
        this.entries.set(request.id, {
          ...(this.entries.get(request.id) as JobStoreEntry),
          status: 'failed',
          finishedAt,
          error: message,
          artifactPaths: Array.isArray(errorWithContext.artifactPaths)
            ? [...errorWithContext.artifactPaths]
            : [],
          steps: Array.isArray(errorWithContext.steps) ? [...errorWithContext.steps] : [],
          result: undefined
        });
      }
    }).catch((error: unknown) => {
      this.options.logger.error({ error, jobId: request.id }, 'Unexpected async job queue error');
    });

    return request.id;
  }

  getById(id: string): JobStoreEntry | undefined {
    const current = this.entries.get(id);
    if (!current) {
      return undefined;
    }

    const maybeExpired = this.markExpiredIfNeeded(current);
    this.entries.set(id, maybeExpired);
    return {
      ...maybeExpired,
      artifactPaths: [...maybeExpired.artifactPaths],
      steps: maybeExpired.steps.map((step) => ({ ...step })),
      result: cloneJobResult(maybeExpired.result)
    };
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
  }

  private cleanupExpiredJobs(): void {
    for (const [id, entry] of this.entries.entries()) {
      const maybeExpired = this.markExpiredIfNeeded(entry);
      this.entries.set(id, maybeExpired);
    }
  }

  private markExpiredIfNeeded(entry: JobStoreEntry): JobStoreEntry {
    if (!isTerminal(entry.status) || entry.status === 'expired') {
      return entry;
    }

    const referenceMs = toMillis(entry.finishedAt) ?? toMillis(entry.startedAt) ?? toMillis(entry.createdAt);
    if (referenceMs == null) {
      return entry;
    }

    if (Date.now() - referenceMs > this.ttlMs) {
      return { ...entry, status: 'expired' };
    }

    return entry;
  }
}
