type MutationCallback<T> = () => Promise<T>;
type FileMutationQueueImpl = <T>(absolutePath: string, callback: MutationCallback<T>) => Promise<T>;

let loadedImplPromise: Promise<FileMutationQueueImpl> | null = null;

function createLocalQueueImpl(): FileMutationQueueImpl {
  const tails = new Map<string, Promise<void>>();

  return async function withLocalQueue<T>(absolutePath: string, callback: MutationCallback<T>): Promise<T> {
    const previous = tails.get(absolutePath) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    tails.set(absolutePath, tail);

    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      releaseCurrent();
      if (tails.get(absolutePath) === tail) {
        tails.delete(absolutePath);
      }
    }
  };
}

async function loadImpl(): Promise<FileMutationQueueImpl> {
  if (!loadedImplPromise) {
    loadedImplPromise = import("@mariozechner/pi-coding-agent")
      .then((module) => {
        if (typeof module.withFileMutationQueue !== "function") {
          throw new Error("withFileMutationQueue is unavailable");
        }

        return module.withFileMutationQueue as FileMutationQueueImpl;
      })
      .catch(() => createLocalQueueImpl());
  }

  return loadedImplPromise;
}

export async function withQueuedFileMutation<T>(absolutePath: string, callback: MutationCallback<T>): Promise<T> {
  const impl = await loadImpl();
  return impl(absolutePath, callback);
}
