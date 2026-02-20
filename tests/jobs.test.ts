import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging';
import { JobManager } from '../src/jobs';
import type { JobRequest, JobStepResult, LoginJobRequest } from '../src/types';

function makeLoginRequest(id = randomUUID()): LoginJobRequest {
  return {
    id,
    jobType: 'login',
    createdAt: new Date().toISOString(),
    payload: {
      username: 'user',
      password: 'pass'
    },
    options: {
      headless: true,
      debug: false,
      slowMo: 0,
      timeoutMs: 5_000
    }
  };
}

function makeStep(name: string): JobStepResult {
  const now = new Date().toISOString();
  return {
    name,
    status: 'ok',
    startedAt: now,
    finishedAt: now
  };
}

async function waitForTerminalState(manager: JobManager, id: string): Promise<string | undefined> {
  for (let i = 0; i < 20; i += 1) {
    const status = manager.getById(id)?.status;
    if (status && ['succeeded', 'failed', 'expired'].includes(status)) {
      return status;
    }
    await sleep(20);
  }

  return manager.getById(id)?.status;
}

describe('JobManager', () => {
  it('transitions a successful job to succeeded', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async () => {
        await sleep(10);
        return { artifactPaths: ['/tmp/trace.zip'], steps: [makeStep('login')] };
      }
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('succeeded');
    expect(manager.getById(id)?.jobType).toBe('login');
    expect(manager.getById(id)?.artifactPaths).toEqual(['/tmp/trace.zip']);
    expect(manager.getById(id)?.steps).toHaveLength(1);
    await manager.shutdown();
  });

  it('transitions a failed job to failed and preserves attached context', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 60,
      logger: createLogger('silent', false),
      executor: async (_request: JobRequest) => {
        const error = new Error('invalid login');
        (error as Error & { artifactPaths?: string[]; steps?: JobStepResult[] }).artifactPaths = [
          '/tmp/error.png'
        ];
        (error as Error & { artifactPaths?: string[]; steps?: JobStepResult[] }).steps = [
          {
            name: 'login',
            status: 'failed',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            error: 'invalid login'
          }
        ];
        throw error;
      }
    });

    const id = manager.enqueue(makeLoginRequest());
    const final = await waitForTerminalState(manager, id);

    expect(final).toBe('failed');
    expect(manager.getById(id)?.error).toContain('invalid login');
    expect(manager.getById(id)?.artifactPaths).toEqual(['/tmp/error.png']);
    expect(manager.getById(id)?.steps[0]?.status).toBe('failed');
    await manager.shutdown();
  });

  it('marks finished jobs as expired after ttl', async () => {
    const manager = new JobManager({
      concurrency: 1,
      ttlMinutes: 0.0001,
      logger: createLogger('silent', false),
      executor: async () => ({ artifactPaths: [], steps: [makeStep('login')] })
    });

    const id = manager.enqueue(makeLoginRequest());
    await waitForTerminalState(manager, id);
    await sleep(20);

    expect(manager.getById(id)?.status).toBe('expired');
    await manager.shutdown();
  });
});
