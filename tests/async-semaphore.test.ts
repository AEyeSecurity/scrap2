import { describe, expect, it } from 'vitest';
import { createAsyncSemaphore } from '../src/async-semaphore';

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('createAsyncSemaphore', () => {
  it('serializes work when concurrency is one', async () => {
    const semaphore = createAsyncSemaphore(1);
    const firstCanFinish = defer();
    const events: string[] = [];

    const first = semaphore.acquire().then(async (release) => {
      events.push('first:start');
      await firstCanFinish.promise;
      events.push('first:end');
      release();
    });

    const second = semaphore.acquire().then((release) => {
      events.push('second:start');
      release();
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    expect(semaphore.activeCount).toBe(1);
    expect(semaphore.pendingCount).toBe(1);

    firstCanFinish.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.pendingCount).toBe(0);
  });

  it('ignores repeated releases for the same lease', async () => {
    const semaphore = createAsyncSemaphore(1);
    const release = await semaphore.acquire();

    release();
    release();

    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.pendingCount).toBe(0);
  });
});
