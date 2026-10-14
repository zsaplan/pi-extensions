export const POLL_INTERVAL_MS = 150_000;

export const HELP = `Usage:
  pi-task-assistant preflight --search-api legacy|realtime [options]
  pi-task-assistant run --search-api legacy|realtime [--once] [options]
  pi-task-assistant intake --root PATH --search-api legacy --conversation ID [--once] [--mention-group ID] [--watch-channel ID]
  pi-task-assistant step --root PATH --provider ID --model ID [--agent-dir PATH]
  pi-task-assistant serve --root PATH --search-api legacy --conversation ID --provider ID --model ID [--agent-dir PATH] [--once] [--workers 1|2] [--mention-group ID] [--watch-channel ID] [--inbox-only] [--task-id ID | --task-ids ID,ID,ID | --discover-tasks 1..3 --exclude-threads PATH] [--pilot-seconds 1..600] [--allow-slack-writes]
  pi-task-assistant serve --root PATH --regular-use APPROVAL.json --search-api legacy --conversation ID --provider ID --model ID --workers 1|2 --mention-group ID --watch-channel ID --session-library PATH --allow-slack-writes [--once]
  pi-task-assistant service install --approval APPROVAL.json [--directory PATH]
  pi-task-assistant service start|stop|status [--directory PATH]
  pi-task-assistant enqueue --root PATH < request.json
  pi-task-assistant list --root PATH
  pi-task-assistant move --root PATH --task-id ID --status queued|active|waiting|review|done

Intake persists read-only Slack receipts/checkpoints; it does not invoke models or post.
Local queue commands do not access Slack or start task agents.

Options:
  --conversation ID          Probe this assistant conversation (no posting).
  --source-thread ID:TS      Probe one known source thread with the user token.
  --mention-group ID         intake/serve: also discover mentions of this Slack user group.
                             Bot token reads group metadata; user token searches its handle.
  --watch-channel ID         intake/serve: discover new top-level messages in this channel.
                             Starts at first configured intake; persists scope across restarts.
                             Both discovery flags are incompatible with --inbox-only.
  --once                     Complete one cycle, then exit (serve waits for task work).
  --workers 1|2              serve only: maximum simultaneous task sessions (default 1).
                             Two workers take a snapshot of up to ten queued tasks per cycle.
                             Bounded parallel pilots use --task-ids or --discover-tasks; no telemetry flags.
  --task-id ID               serve only: owner replies in one existing task thread;
                             requires --inbox-only and a single-task state root.
  --task-ids ID,ID,ID        serve only: allowlist one to three existing published tasks.
                             Requires --inbox-only, exactly those tasks in the root, and
                             --once or --pilot-seconds. Allows owner and stored-source updates.
                             Cannot combine with --task-id or telemetry flags.
  --discover-tasks 1..3      Automatic trial in a fresh root; cap total tasks, not active slots.
                             Requires --pilot-seconds, both discovery flags, --exclude-threads,
                             and an owner DM. No --once, --inbox-only, selectors or telemetry.
                             Only mentions/new channel roots admit tasks; old DM history is deferred.
  --exclude-threads PATH     JSON array of Source identities whose entire threads must be excluded.
                             Use an explicit [] only when no existing threads need protection.
                             Reservations and original deadline persist; closed trials cannot restart.
  --regular-use PATH         Explicit owner-approved transition from a closed trial to ongoing use.
                             Preserves trial history; binds root/identity/model/discovery and limits.
                             Up to three open tasks and five new reservations per rolling day.
                             New discovery starts at approval; related task input is retained.
  --pilot-seconds N          Bounded serve pilot; stops after 1..600 seconds.
                             No --once; allows 30 seconds to finish shutdown.
  --log-site SITE            Enable fixed read-only application-log intake for this task.
  --log-environment ENV      test|uat|prod; both log flags require --task-id and
                             --once or --pilot-seconds. Binding persists across restarts.
  --site-manifest PATH       Enable scoped configuration/trace tools; paired with --bundle-chart.
  --bundle-chart PATH        Directory with matching bundle Chart.yaml and values.yaml.
                             Requires log scope; selected paths persist across restarts.
  --help                     Show help without credentials or network access.

Environment:
  SLACK_USER_TOKEN, SLACK_BOT_TOKEN
  GRAFANA_SERVICE_ACCOUNT_KEY Required only for explicit log intake; fixed Grafana origin.
  GRAFANA_ENABLE_PROD         false/0/no disables production log reads.
  TASK_ASSISTANT_SEARCH_API   Alternative to --search-api.
  TASK_ASSISTANT_CONVERSATION Alternative to --conversation.

preflight/run perform read-only preflight checks, not task execution.
run waits 150 seconds after each check, or longer after 429.
intake/serve poll on a non-overlapping 150-second start-to-start schedule;
missed ticks are skipped. serve keeps bounded task workers separate from intake.
Classification is serial between batches; replies captured during work await the next batch.
serve writes to Slack only with the explicit --allow-slack-writes gate.
Continuous serve emits separate sanitized intake and settled task reports.
Preflight's missing conversation/thread probes remain unverified;
its search probes inspect only one page.
`;

export class ConfigurationError extends Error {}

export interface Config {
  command: 'preflight' | 'run';
  once: boolean;
  searchApi: 'legacy' | 'realtime';
  userToken: string;
  botToken: string;
  conversation?: string;
  sourceThread?: {channel: string; ts: string};
}

export function parseConfig(args: string[], env: NodeJS.ProcessEnv): Config {
  const [command, ...rest] = args;
  if (command !== 'preflight' && command !== 'run') {
    throw new ConfigurationError('Choose preflight or run; see --help.');
  }
  const options = new Map<string, string>();
  let once = command === 'preflight';
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index];
    if (options.has(option)) {
      throw new ConfigurationError('An option was supplied more than once.');
    }
    if (option === '--once') {
      once = true;
      options.set(option, 'true');
      continue;
    }
    if (
      !['--search-api', '--conversation', '--source-thread'].includes(option)
    ) {
      throw new ConfigurationError('Unknown argument; see --help.');
    }
    const value = rest[++index];
    if (!value || value.startsWith('--')) {
      throw new ConfigurationError('An option requires a value; see --help.');
    }
    options.set(option, value);
  }

  const searchApi =
    options.get('--search-api') ?? env.TASK_ASSISTANT_SEARCH_API;
  if (searchApi !== 'legacy' && searchApi !== 'realtime') {
    throw new ConfigurationError(
      'Select --search-api legacy or realtime explicitly.',
    );
  }
  const userToken = env.SLACK_USER_TOKEN?.trim();
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  if (!userToken || !botToken) {
    throw new ConfigurationError(
      'Set both SLACK_USER_TOKEN and SLACK_BOT_TOKEN.',
    );
  }
  const conversation =
    options.get('--conversation') ??
    (env.TASK_ASSISTANT_CONVERSATION?.trim() || undefined);
  if (conversation !== undefined && !/^[CDG][A-Z0-9]+$/.test(conversation)) {
    throw new ConfigurationError(
      '--conversation must be a Slack conversation ID.',
    );
  }
  const threadInput = options.get('--source-thread');
  const match = threadInput?.match(/^([CDG][A-Z0-9]+):(\d{1,16}\.\d{1,6})$/);
  if (threadInput !== undefined && !match) {
    throw new ConfigurationError(
      '--source-thread must be CHANNEL_ID:ROOT_TIMESTAMP.',
    );
  }
  return {
    command,
    once,
    searchApi,
    userToken,
    botToken,
    conversation,
    sourceThread: match ? {channel: match[1], ts: match[2]} : undefined,
  };
}
