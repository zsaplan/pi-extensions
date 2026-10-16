import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {POLL_INTERVAL_MS} from './config.ts';

/** Start-to-start cadence. A slow poll skips missed ticks; it never overlaps or catches up in a burst. */
export async function pollOnCadence(
  poll: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let next = performance.now();
  while (!signal.aborted) {
    await poll();
    if (signal.aborted) break;
    const now = performance.now();
    do {
      next += POLL_INTERVAL_MS;
    } while (next <= now);
    await sleep(next - performance.now(), undefined, {signal});
  }
}
