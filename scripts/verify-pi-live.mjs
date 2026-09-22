// Actual CLI + configured provider acceptance. Makes paid/subscription model calls.
// Only synthetic inputs and explicitly selected local/read-only tools are exposed.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import console from 'node:console';
import {randomUUID} from 'node:crypto';
import {closeSync, openSync} from 'node:fs';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {clearTimeout, setTimeout} from 'node:timers';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(
  process.argv.slice(2).every(arg => arg === '--quick'),
  'Usage: npm run verify:live -- [--quick]',
);
const quick = process.argv.includes('--quick');
const pi = path.join(root, 'node_modules/.bin/pi');
const personal =
  process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), '.pi/agent');
const settings = JSON.parse(
  await readFile(path.join(personal, 'settings.json'), 'utf8'),
);
const provider = process.env.PI_LIVE_PROVIDER ?? settings.defaultProvider;
const model = process.env.PI_LIVE_MODEL ?? settings.defaultModel;
assert.ok(
  provider && model,
  'Set PI_LIVE_PROVIDER and PI_LIVE_MODEL or configure Pi defaults',
);
await mkdir(path.join(root, 'tmp'), {recursive: true});
const output = await mkdtemp(path.join(root, 'tmp/pi-live-'));
await chmod(output, 0o700);
const scratch = await mkdtemp(path.join(tmpdir(), 'pi-live-'));
const agent = path.join(scratch, 'agent');
const cwd = path.join(scratch, 'repo');
const kb = path.join(scratch, 'kb');
const report = {status: 'running', provider, model, quick, output, stages: []};
let child;
let interrupted = false;
const stop = signal => {
  try {
    if (child?.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};
const interrupt = () => {
  interrupted = true;
  stop('SIGTERM');
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

try {
  for (const dir of [agent, cwd, kb]) await mkdir(dir);
  // A temporary copy of ONLY the selected provider credential; never in artifacts.
  // Provider API-key environment variables remain available to the child.
  try {
    const auth = JSON.parse(
      await readFile(path.join(personal, 'auth.json'), 'utf8'),
    );
    if (auth[provider])
      await writeFile(
        path.join(agent, 'auth.json'),
        JSON.stringify({[provider]: auth[provider]}),
        {mode: 0o600},
      );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(
    path.join(agent, 'settings.json'),
    JSON.stringify({
      cacheWarming: 'off',
      compaction: {enabled: false},
      retry: {enabled: false},
      enableInstallTelemetry: false,
    }),
  );
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: path.join(output, 'sessions'),
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    PI_RAINMAN_KB_ROOT: kb,
  };
  report.piVersion = execFileSync(pi, ['--version'], {
    env,
    encoding: 'utf8',
  }).trim();
  assert.equal(
    report.piVersion,
    '0.87.1',
    'Use the pinned test CLI, not the daily installation',
  );
  const git = (...args) => execFileSync('git', args, {cwd, stdio: 'pipe'});
  git('init', '-b', 'main');
  await writeFile(
    path.join(cwd, 'README.md'),
    '# Fixture\n\nA synthetic upgrade test.\n',
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Live Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture baseline',
  );
  await writeFile(
    path.join(cwd, 'README.md'),
    '# Fixture\n\nA synthetic Pi upgrade test.\n',
  );
  await writeFile(
    path.join(kb, 'PI__UPGRADE.md'),
    '# PI / UPGRADE\n\n- PREFERS | package-local verify | when=validating packages\n',
  );
  const common = [
    '--mode',
    'json',
    '--provider',
    provider,
    '--model',
    model,
    '--thinking',
    'low',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
  ];

  async function run(name, args, prompt, expectedTool) {
    assert.equal(interrupted, false, 'Run interrupted');
    const stage = {
      name,
      status: 'running',
      args: [...common, ...args, '--', prompt],
    };
    report.stages.push(stage);
    console.log(
      `Running ${name} with Pi ${report.piVersion} / ${provider}/${model}...`,
    );
    const stdout = openSync(path.join(output, `${name}.jsonl`), 'wx', 0o600);
    const stderr = openSync(path.join(output, `${name}.stderr`), 'wx', 0o600);
    let timer;
    let forceTimer;
    let timedOut = false;
    const started = Date.now();
    try {
      const code = await new Promise((resolve, reject) => {
        child = spawn(pi, stage.args, {
          cwd,
          env,
          detached: true,
          stdio: ['ignore', stdout, stderr],
        });
        timer = setTimeout(() => {
          timedOut = true;
          stop('SIGTERM');
          forceTimer = setTimeout(() => stop('SIGKILL'), 3000);
        }, 180000);
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(timedOut, false, `${name}: exceeded 180 seconds`);
      assert.equal(interrupted, false, 'Run interrupted');
      assert.equal(code, 0, `${name}: CLI exit ${code}; see stderr artifact`);
    } finally {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      closeSync(stdout);
      closeSync(stderr);
      child = undefined;
      stage.elapsedMs = Date.now() - started;
    }
    // JSON mode can exit 0 after a provider error: inspect authoritative events.
    const events = (await readFile(path.join(output, `${name}.jsonl`), 'utf8'))
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
    const messages = events
      .filter(
        event =>
          event.type === 'message_end' && event.message?.role === 'assistant',
      )
      .map(event => event.message);
    assert.ok(messages.length, `${name}: no assistant completion`);
    for (const message of messages) {
      assert.ok(
        !['error', 'aborted'].includes(message.stopReason),
        `${name}: ${message.errorMessage ?? message.stopReason}`,
      );
      assert.equal(message.provider, provider);
      assert.equal(message.model, model);
    }
    assert.ok(
      events.some(event => event.type === 'agent_settled'),
      `${name}: no settled boundary`,
    );
    const tools = events.filter(event => event.type === 'tool_execution_end');
    for (const tool of tools)
      assert.equal(
        tool.isError,
        false,
        `${name}: ${tool.toolName} failed; see JSONL artifact`,
      );
    assert.equal(
      tools.length,
      expectedTool ? 1 : 0,
      `${name}: unexpected tool count`,
    );
    if (expectedTool) assert.equal(tools[0].toolName, expectedTool);
    const text = messages
      .at(-1)
      .content.filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    stage.toolNames = tools.map(tool => tool.toolName);
    stage.parentUsage = messages.map(message => message.usage);
    stage.status = 'passed';
    return {text, details: tools[0]?.result.details};
  }

  const token = randomUUID();
  const tokenFile = path.join(scratch, 'token.txt');
  await writeFile(tokenFile, token);
  const session = path.join(output, 'read-session.jsonl');
  const first = await run(
    'read',
    ['--session', session, '--tools', 'read'],
    `Call read once on ${tokenFile}. Reply with only the exact token in that file.`,
    'read',
  );
  assert.equal(first.text.trim(), token);
  await rm(tokenFile);
  const resumed = await run(
    'resume',
    ['--session', session, '--no-tools'],
    'Without calling tools, repeat only the exact token read in the previous turn.',
    undefined,
  );
  assert.equal(resumed.text.trim(), token);

  if (!quick) {
    const review = await run(
      'review',
      [
        '--no-session',
        '--tools',
        'polish_solution_review',
        '-e',
        path.join(root, 'polish-solution/src/index.ts'),
      ],
      'Call polish_solution_review exactly once with baseRef HEAD on this synthetic repository. Wait for its result, then briefly report completion. Do not call other tools.',
      'polish_solution_review',
    );
    assert.ok(['approve', 'needs-attention'].includes(review.details?.status));
    assert.deepEqual(
      review.details.category_results.map(result => result.category).sort(),
      ['adversarial', 'dry', 'prune', 'simplify', 'standardize'],
    );
    const lookup = await run(
      'rainman',
      [
        '--no-session',
        '--tools',
        'rainman_lookup',
        '-e',
        path.join(root, 'rainman/src/index.ts'),
      ],
      'Call rainman_lookup exactly once to answer: What does PI prefer when validating packages? Report the answer and citation. Do not call other tools.',
      'rainman_lookup',
    );
    assert.equal(lookup.details?.status, 'answered');
    assert.ok(
      lookup.details.citations.some(
        citation =>
          citation.file === 'PI__UPGRADE.md' &&
          citation.quote.includes('package-local verify'),
      ),
    );
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  const last = report.stages.at(-1);
  if (last) last.status = 'failed';
  process.exitCode = 1;
} finally {
  stop('SIGKILL');
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  await rm(scratch, {recursive: true, force: true});
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    {mode: 0o600},
  );
  console.log(
    `${report.status.toUpperCase()}: ${path.join(output, 'report.json')}`,
  );
  if (report.error) console.error(report.error);
}
