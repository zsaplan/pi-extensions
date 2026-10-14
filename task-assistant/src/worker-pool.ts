import {
  runNextTask,
  type ModelConfig,
  type TaskCommunication,
} from './worker.ts';
import {StoreError, TaskStore} from './store.ts';
import type {ReadonlySlackClient} from './slack.ts';
import type {TaskLogFeed} from './task-logs.ts';
import type {TaskInvestigation} from './task-investigation.ts';

export type TaskRunResult = Awaited<ReturnType<typeof runNextTask>>;

export function workerLimit(value?: string): 1 | 2 {
  if (value === undefined || value === '1') return 1;
  if (value === '2') return 2;
  throw new StoreError('invalid_worker_limit');
}

// One bounded queue snapshot, not an unbounded drain. Recovery/classification happen before this call.
export async function runTaskBatch(
  store: TaskStore,
  config: ModelConfig,
  signal: AbortSignal,
  options: {
    workers: 1 | 2;
    taskIds?: string[];
    communication?: TaskCommunication;
    sourceClient?: ReadonlySlackClient;
    logs?: TaskLogFeed;
    investigation?: TaskInvestigation;
    // False holds further dispatch after an uncertain publication; running peers still settle.
    onSettled?: (result: TaskRunResult) => Promise<boolean | void>;
  },
): Promise<TaskRunResult[]> {
  workerLimit(String(options.workers));
  if (options.workers === 2 && (options.logs || options.investigation))
    throw new StoreError('parallel_scope_unsupported');
  const ids = (await store.list())
    .filter(
      item =>
        item.status === 'queued' &&
        (!options.taskIds || options.taskIds.includes(item.task.id)),
    )
    .sort((a, b) => a.task.created_at.localeCompare(b.task.created_at))
    .slice(0, options.workers === 1 ? 1 : 10)
    .map(item => item.task.id);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const results: TaskRunResult[] = [];
  let next = 0;
  let held = false;
  const lanes = Array.from(
    {length: Math.min(options.workers, ids.length)},
    async () => {
      try {
        while (!held && !combined.aborted && next < ids.length) {
          const id = ids[next++];
          const result = await runNextTask(
            store,
            config,
            combined,
            options.communication,
            options.sourceClient,
            options.logs,
            options.investigation,
            id,
          );
          results.push(result);
          if (
            !combined.aborted &&
            (await options.onSettled?.(result)) === false
          )
            held = true;
        }
      } catch (error) {
        controller.abort();
        throw error;
      }
    },
  );
  // Fail closed, but never release ownership while a peer is still writing its session/journal.
  const settled = await Promise.allSettled(lanes);
  const failed = settled.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results;
}
