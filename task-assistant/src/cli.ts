#!/usr/bin/env node
import process from 'node:process';
import {setTimeout as sleep} from 'node:timers/promises';
import {
  ConfigurationError,
  HELP,
  POLL_INTERVAL_MS,
  parseConfig,
} from './config.ts';
import {preflight} from './preflight.ts';
import {queueCommand} from './queue-cli.ts';
import {StoreError} from './store.ts';
import {SlackError} from './slack.ts';
import {intakeCommand} from './intake-cli.ts';
import {workerCommand} from './worker-cli.ts';
import {serveCommand} from './serve.ts';
import {backgroundCommand} from './background.ts';

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...args] = process.argv.slice(2);
  if (command === 'service') {
    await backgroundCommand(args);
    return;
  }
  if (command === 'serve') {
    await serveCommand(args);
    return;
  }
  if (command === 'step') {
    await workerCommand(args);
    return;
  }
  if (command === 'intake') {
    await intakeCommand(args);
    return;
  }
  if (['enqueue', 'list', 'move'].includes(command)) {
    await queueCommand(command, args);
    return;
  }
  const config = parseConfig(process.argv.slice(2), process.env);
  const controller = new AbortController();
  let interrupt = false;
  const stop = () => controller.abort();
  const interruptAndStop = () => {
    interrupt = true;
    stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', interruptAndStop);
  try {
    while (!controller.signal.aborted) {
      const report = await preflight(config, controller.signal);
      process.stdout.write(JSON.stringify(report) + '\n');
      if (controller.signal.aborted) break;
      if (config.once || (report.status !== 'passed' && !report.retryable)) {
        process.exitCode =
          report.status === 'passed'
            ? 0
            : report.status === 'incomplete'
              ? 2
              : 1;
        break;
      }
      // Waiting after completion prevents overlapping cycles and honors Retry-After.
      const delay = Math.max(
        POLL_INTERVAL_MS,
        report.retry_after_seconds * 1000,
      );
      try {
        await sleep(delay, undefined, {signal: controller.signal});
      } catch {
        if (!controller.signal.aborted) throw new Error('Runner wait failed.');
      }
    }
    if (controller.signal.aborted) process.exitCode = interrupt ? 130 : 0;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', interruptAndStop);
  }
}

main().catch(error => {
  process.stdout.write(
    JSON.stringify({
      schema_version: 1,
      stage:
        (
          {
            enqueue: 'local-queue',
            list: 'local-queue',
            move: 'local-queue',
            intake: 'intake',
            step: 'local-task-step',
            serve: 'task-cycle',
            service: 'background',
          } as Record<string, string>
        )[process.argv[2]] ?? 'read-only-preflight',
      status: 'blocked',
      error:
        error instanceof StoreError || error instanceof SlackError
          ? error.code
          : error instanceof ConfigurationError
            ? 'configuration_error'
            : 'internal_error',
      message:
        error instanceof ConfigurationError
          ? error.message
          : 'Operation failed; inspect local state before retrying.',
    }) + '\n',
  );
  process.exitCode = 1;
});
