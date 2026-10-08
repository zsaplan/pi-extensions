// One queue per loaded extension, shared by direct and nested invocations.
export const maxConcurrentRuns = 3;

export class RunQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  private async acquire(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.active < maxConcurrentRuns) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        const index = this.waiting.indexOf(start);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal?.reason ?? new Error('Queued run cancelled.'));
      };
      this.waiting.push(start);
      signal?.addEventListener('abort', cancel, {once: true});
    });
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      // Transfer the reserved slot before waking a waiter: a new caller cannot
      // jump the queue or exceed the bound between release and continuation.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
