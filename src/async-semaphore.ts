export interface AsyncSemaphore {
  readonly activeCount: number;
  readonly pendingCount: number;
  acquire: () => Promise<() => void>;
}

export function createAsyncSemaphore(maxConcurrency: number): AsyncSemaphore {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`Semaphore concurrency must be a positive integer, got ${maxConcurrency}`);
  }

  let activeCount = 0;
  const pending: Array<(release: () => void) => void> = [];

  const dispatch = (): void => {
    while (activeCount < maxConcurrency && pending.length > 0) {
      const resolve = pending.shift();
      if (!resolve) {
        return;
      }

      activeCount += 1;
      let released = false;
      resolve(() => {
        if (released) {
          return;
        }
        released = true;
        activeCount -= 1;
        dispatch();
      });
    }
  };

  return {
    get activeCount() {
      return activeCount;
    },
    get pendingCount() {
      return pending.length;
    },
    acquire: () =>
      new Promise((resolve) => {
        pending.push(resolve);
        dispatch();
      })
  };
}
