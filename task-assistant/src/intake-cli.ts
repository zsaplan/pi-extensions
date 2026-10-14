import path from 'node:path';
import {parseConfig} from './config.ts';
import {discoveryOptions} from './discovery.ts';
import {pollOnCadence} from './cadence.ts';
import {pollIntake} from './intake.ts';
import {options, output, required} from './queue-cli.ts';
import {ReadonlySlackClient} from './slack.ts';
import {StoreError, TaskStore} from './store.ts';

export async function intakeCommand(args: string[]): Promise<void> {
  const once = args.includes('--once');
  if (args.filter(arg => arg === '--once').length > 1)
    throw new StoreError('invalid_arguments');
  const values = options(
    args.filter(arg => arg !== '--once'),
    [
      '--root',
      '--search-api',
      '--conversation',
      '--mention-group',
      '--watch-channel',
    ],
  );
  if (required(values, '--search-api') !== 'legacy')
    throw new StoreError('intake_requires_legacy');
  const discovery = discoveryOptions(values);
  const conversation = required(values, '--conversation');
  const config = parseConfig(
    ['preflight', '--search-api', 'legacy', '--conversation', conversation],
    process.env,
  );
  const store = await TaskStore.acquire(required(values, '--root'));
  const client = new ReadonlySlackClient(
    {
      user: config.userToken,
      bot: config.botToken,
    },
    path.join(store.root, 'runs', 'slack', 'cooldowns.json'),
  );
  const controller = new AbortController();
  let interrupted = false;
  const stop = () => controller.abort();
  const interrupt = () => {
    interrupted = true;
    stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', interrupt);
  try {
    const poll = async () => {
      const report = await pollIntake(
        store,
        client,
        conversation,
        controller.signal,
        false,
        discovery,
      );
      output(report);
      if (once) process.exitCode = report.status === 'passed' ? 0 : 2;
    };
    if (once) await poll();
    else await pollOnCadence(poll, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', interrupt);
    await store.close();
    if (controller.signal.aborted) process.exitCode = interrupted ? 130 : 0;
  }
}
