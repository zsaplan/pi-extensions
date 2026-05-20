export type PromptTimeoutSession = {
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
};

export type PromptTimeoutOptions = {
  operation: Promise<void>;
  session: PromptTimeoutSession;
  timeoutMs: number;
  signal?: AbortSignal;
  stallTimeoutMs?: number;
};

function abortSessionBestEffort(session: PromptTimeoutSession): void {
  try {
    void session.abort().catch(() => {
      // Ignore abort failures; the caller must still receive the watchdog error.
    });
  } catch {
    // Ignore synchronous abort failures for the same reason.
  }
}

function isPositiveFiniteTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export async function promptWithTimeout({
  operation,
  session,
  timeoutMs,
  signal,
  stallTimeoutMs,
}: PromptTimeoutOptions): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;
  let stallTimeoutId: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let unsubscribeSessionEvents: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      abortSessionBestEffort(session);
      reject(
        new Error(`polish_solution_review timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  const stallPromise = isPositiveFiniteTimeout(stallTimeoutMs)
    ? new Promise<never>((_resolve, reject) => {
        const resetStallTimer = (): void => {
          if (stallTimeoutId !== undefined) clearTimeout(stallTimeoutId);
          stallTimeoutId = setTimeout(() => {
            abortSessionBestEffort(session);
            reject(
              new Error(
                'polish_solution_review reviewer session made no progress ' +
                  `for ${stallTimeoutMs}ms while waiting for the child agent. ` +
                  'Aborted the child session; this can happen when a websocket ' +
                  'or transport error leaves session.prompt() unresolved.',
              ),
            );
          }, stallTimeoutMs);
        };

        unsubscribeSessionEvents = session.subscribe(() => {
          resetStallTimer();
        });
        resetStallTimer();
      })
    : undefined;

  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          abortSessionBestEffort(session);
          reject(new Error('Operation aborted'));
        };

        if (signal.aborted) {
          abortListener();
          return;
        }

        signal.addEventListener('abort', abortListener, {once: true});
      })
    : undefined;

  try {
    await Promise.race(
      [operation, timeoutPromise]
        .concat(stallPromise ? [stallPromise] : [])
        .concat(abortPromise ? [abortPromise] : []),
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (stallTimeoutId !== undefined) clearTimeout(stallTimeoutId);
    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
    unsubscribeSessionEvents?.();
  }
}
