import {classifyPending, recoverRuns, runNextTask} from './worker.ts';
import {options, output, required} from './queue-cli.ts';
import {TaskStore} from './store.ts';
import {requireAutoTrialScope} from './auto-trial.ts';
import {requireSessionLibrary} from './owner-references.ts';

export async function workerCommand(args: string[]): Promise<void> {
  const values = options(args, [
    '--root',
    '--provider',
    '--model',
    '--agent-dir',
    '--session-library',
  ]);
  const config = {
    provider: required(values, '--provider'),
    model: required(values, '--model'),
    agentDir: values.get('--agent-dir'),
    sessionLibrary: values.get('--session-library'),
  };
  const store = await TaskStore.acquire(required(values, '--root'));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await requireAutoTrialScope(store, false);
    await requireSessionLibrary(store, config.sessionLibrary);
    await recoverRuns(store);
    const triage = await classifyPending(store, config, controller.signal);
    const worker = await runNextTask(store, config, controller.signal);
    output({
      schema_version: 1,
      stage: 'local-task-step',
      triage,
      worker,
      writes_performed: 0,
    });
    if (triage.blocked || worker.error) process.exitCode = 2;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await store.close();
  }
}
