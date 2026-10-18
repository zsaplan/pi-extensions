import path from 'node:path';
import os from 'node:os';
import lockfile from 'proper-lockfile';
import {fileURLToPath} from 'node:url';
import type {Readable} from 'node:stream';
import {spawn, execFileSync} from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  atomicJson,
  digest,
  readJson,
  record,
  StoreError,
  TaskStore,
  absent,
} from './store.ts';
import {options, output, required} from './queue-cli.ts';
import {RegularUse} from './regular-use.ts';

const label = 'com.zsaplan.pi-task-assistant';
const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
interface Settings {
  root: string;
  node: string;
  args: string[];
  runtime: Record<string, string>;
  dependency_lock: {file: string; hash: string};
}
const plistFile = () =>
  path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist');
const target = () => `gui/${process.getuid!()}/${label}`;
const control = (args: string[]) =>
  execFileSync('/bin/launchctl', args, {stdio: 'pipe'});
async function optional(file: string) {
  try {
    return record(await readJson(file));
  } catch (e) {
    if (!absent(e)) throw e;
    return undefined;
  }
}
async function secure(file: string) {
  const info = await stat(file);
  if (info.uid !== process.getuid!() || info.mode & 0o077)
    throw new StoreError('background_file_permissions');
}
async function settings(directory: string): Promise<Settings> {
  await secure(directory);
  await secure(path.join(directory, 'settings.json'));
  return (await readJson(path.join(directory, 'settings.json'))) as Settings;
}
function alive(pid: unknown) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}
async function writeLog(stream: Readable, file: string) {
  let handle = await open(file, 'a', 0o600);
  let size = (await handle.stat()).size;
  try {
    for await (const chunk of stream) {
      if (size && size + chunk.length > 10 * 1024 * 1024) {
        await handle.close();
        await rename(file, file + '.previous');
        handle = await open(file, 'w', 0o600);
        size = 0;
      }
      await handle.writeFile(chunk);
      size += chunk.length;
    }
  } finally {
    await handle.close();
  }
}
async function run(directory: string) {
  const config = await settings(directory),
    controlFile = path.join(directory, 'control.json'),
    stateFile = path.join(directory, 'status.json');
  const state = await optional(stateFile),
    controls = await optional(controlFile);
  if (controls?.paused || state?.state === 'failed') {
    output({
      stage: 'background',
      state: controls?.paused ? 'paused' : 'failed',
      reason: 'Explicit service start required',
    });
    return;
  }
  // Snapshot app code; a changed dependency installation requires deliberate redeployment.
  for (const [file, hash] of Object.entries(config.runtime))
    if (
      digest(await readFile(path.join(directory, 'runtime', file), 'utf8')) !==
      hash
    )
      throw new StoreError('background_runtime_changed');
  if (
    digest(await readFile(config.dependency_lock.file, 'utf8')) !==
    config.dependency_lock.hash
  )
    throw new StoreError('background_dependencies_changed');
  const secretFile = path.join(directory, 'credentials.json');
  await secure(secretFile);
  const secrets = record(await readJson(secretFile));
  if (
    typeof secrets.SLACK_USER_TOKEN !== 'string' ||
    typeof secrets.SLACK_BOT_TOKEN !== 'string'
  )
    throw new StoreError('background_credentials_unavailable');
  const child = spawn(config.node, config.args, {
    cwd: directory,
    env: {
      HOME: os.homedir(),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SLACK_USER_TOKEN: secrets.SLACK_USER_TOKEN,
      SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN,
      ...(typeof secrets.GH_TOKEN === 'string'
        ? {GH_TOKEN: secrets.GH_TOKEN}
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ended = new Promise<{
    code: number | null;
    signal?: string | null;
    error?: string;
  }>(resolve => {
    child.once('error', () => resolve({code: null, error: 'spawn_failed'}));
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  let stopping = false,
    force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopping = true;
    child.kill('SIGTERM');
    force = setTimeout(() => child.kill('SIGKILL'), 30000);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let logFailed = false;
  const logs = [
    writeLog(child.stdout!, path.join(directory, 'runner.jsonl')),
    writeLog(child.stderr!, path.join(directory, 'runner.stderr')),
  ].map(p =>
    p.catch(() => {
      logFailed = true;
      stop();
    }),
  );
  const started_at = new Date().toISOString();
  await atomicJson(stateFile, {
    schema_version: 1,
    state: 'running',
    pid: process.pid,
    worker_pid: child.pid,
    started_at,
    root: config.root,
  });
  const exit = await ended;
  await Promise.all(logs);
  clearTimeout(force);
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  await atomicJson(stateFile, {
    schema_version: 1,
    state: stopping && exit.code === 0 && !logFailed ? 'stopped' : 'failed',
    started_at,
    finished_at: new Date().toISOString(),
    root: config.root,
    exit,
    log_failed: logFailed,
  });
  if (!stopping || exit.code !== 0 || logFailed) process.exitCode = 1;
}
async function install(
  directory: string,
  approvalFile: string,
  backlogApproval?: string,
  agentDir?: string,
  dependencyLock?: string,
  researchConfig?: string,
) {
  const approval = record(await readJson(approvalFile)),
    scope = record(approval.scope);
  for (const key of [
    'root',
    'provider',
    'model',
    'conversation',
    'group',
    'channel',
    'session_library',
  ])
    if (typeof scope[key] !== 'string')
      throw new StoreError('invalid_regular_approval');
  if (
    !process.env.SLACK_USER_TOKEN ||
    !process.env.SLACK_BOT_TOKEN ||
    (researchConfig && !process.env.GH_TOKEN)
  )
    throw new StoreError('background_credentials_unavailable');
  try {
    await stat(plistFile());
    throw new StoreError('background_already_installed');
  } catch (e) {
    if (!absent(e)) throw e;
  }
  await mkdir(directory, {mode: 0o700});
  const store = await TaskStore.acquire(String(scope.root));
  try {
    await RegularUse.open(store, {
      file: approvalFile,
      backlogApproval,
      workers: Number(scope.workers),
      provider: String(scope.provider),
      model: String(scope.model),
      conversation: String(scope.conversation),
      sessionLibrary: String(scope.session_library),
      discovery: {
        mentionGroup: String(scope.group),
        watchChannel: String(scope.channel),
      },
    });
  } finally {
    await store.close();
  }
  const runtimeDir = path.join(directory, 'runtime'),
    sourceDir = path.dirname(fileURLToPath(import.meta.url));
  await mkdir(runtimeDir, {mode: 0o700});
  const runtime: Record<string, string> = {};
  for (const name of await readdir(sourceDir))
    if (name.endsWith('.js')) {
      await copyFile(path.join(sourceDir, name), path.join(runtimeDir, name));
      runtime[name] = digest(
        await readFile(path.join(runtimeDir, name), 'utf8'),
      );
    }
  await writeFile(
    path.join(runtimeDir, 'package.json'),
    JSON.stringify({type: 'module'}),
    {mode: 0o600},
  );
  for (const name of [
    '@earendil-works/pi-coding-agent',
    'proper-lockfile',
    'typebox',
    'yaml',
  ]) {
    let folder = path.dirname(
      await realpath(fileURLToPath(import.meta.resolve(name))),
    );
    for (;;) {
      const p = await optional(path.join(folder, 'package.json'));
      if (p?.name === name) break;
      const parent = path.dirname(folder);
      if (parent === folder)
        throw new StoreError('background_dependency_missing');
      folder = parent;
    }
    const link = path.join(runtimeDir, 'node_modules', name);
    await mkdir(path.dirname(link), {recursive: true, mode: 0o700});
    await symlink(folder, link, 'dir');
  }
  const copiedApproval = path.join(directory, 'approval.json');
  await copyFile(approvalFile, copiedApproval);
  await chmod(copiedApproval, 0o600);
  const copiedBacklog = path.join(directory, 'backlog-approval.json');
  if (backlogApproval) {
    await copyFile(backlogApproval, copiedBacklog);
    await chmod(copiedBacklog, 0o600);
  }
  await writeFile(
    path.join(directory, 'credentials.json'),
    JSON.stringify({
      SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN,
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      ...(researchConfig ? {GH_TOKEN: process.env.GH_TOKEN} : {}),
    }),
    {flag: 'wx', mode: 0o600},
  );
  const adjacentLock = path.resolve(sourceDir, '../package-lock.json');
  const lock = dependencyLock
    ? path.resolve(dependencyLock)
    : (await optional(adjacentLock))
      ? adjacentLock
      : path.resolve(sourceDir, '../../package-lock.json');
  const args = [
    path.join(runtimeDir, 'cli.js'),
    'serve',
    '--root',
    String(scope.root),
    '--search-api',
    'legacy',
    '--conversation',
    String(scope.conversation),
    '--provider',
    String(scope.provider),
    '--model',
    String(scope.model),
    '--workers',
    String(scope.workers),
    '--mention-group',
    String(scope.group),
    '--watch-channel',
    String(scope.channel),
    '--session-library',
    String(scope.session_library),
    '--regular-use',
    copiedApproval,
    ...(backlogApproval ? ['--backlog-approval', copiedBacklog] : []),
    ...(agentDir ? ['--agent-dir', path.resolve(agentDir)] : []),
    ...(researchConfig
      ? ['--github-research-config', path.resolve(researchConfig)]
      : []),
    '--allow-slack-writes',
  ];
  await atomicJson(path.join(directory, 'settings.json'), {
    root: scope.root,
    node: process.execPath,
    args,
    runtime,
    dependency_lock: {file: lock, hash: digest(await readFile(lock, 'utf8'))},
  });
  // Installation never connects to Slack or starts a worker. Start is explicit.
  await atomicJson(path.join(directory, 'control.json'), {paused: true});
  const program = [
    process.execPath,
    path.join(runtimeDir, 'cli.js'),
    'service',
    'run',
    '--directory',
    directory,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${program.map(v => '<string>' + xml(v) + '</string>').join('')}</array><key>WorkingDirectory</key><string>${xml(directory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ExitTimeOut</key><integer>40</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(path.join(directory, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(directory, 'service.stderr'))}</string></dict></plist>`;
  await mkdir(path.dirname(plistFile()), {recursive: true});
  await writeFile(plistFile(), plist, {flag: 'wx', mode: 0o600});
  output({
    stage: 'background',
    state: 'installed_paused',
    directory,
    plist: plistFile(),
    root: scope.root,
  });
}
export async function backgroundCommand(args: string[]) {
  if (process.platform !== 'darwin')
    throw new StoreError('background_requires_macos');
  const action = args[0],
    values = options(args.slice(1), [
      '--directory',
      '--approval',
      '--backlog-approval',
      '--agent-dir',
      '--dependency-lock',
      '--github-research-config',
    ]);
  if (
    action !== 'install' &&
    [...values.keys()].some(key => key !== '--directory')
  )
    throw new StoreError('invalid_background_arguments');
  const directory = path.resolve(
    values.get('--directory') ??
      path.join(os.homedir(), '.pi/agent/task-assistant-background'),
  );
  if (action === 'install')
    return install(
      directory,
      required(values, '--approval'),
      values.get('--backlog-approval'),
      values.get('--agent-dir'),
      values.get('--dependency-lock'),
      values.get('--github-research-config'),
    );
  if (action === 'run') {
    const release = await lockfile.lock(directory, {
      retries: 0,
      stale: 10000,
      update: 2000,
    });
    try {
      return await run(directory);
    } catch (error) {
      await atomicJson(path.join(directory, 'status.json'), {
        state: 'failed',
        at: new Date().toISOString(),
        error: error instanceof StoreError ? error.code : 'background_failed',
      });
      throw error;
    } finally {
      await release();
    }
  }
  const config = await settings(directory);
  if (action === 'status') {
    const status = await optional(path.join(directory, 'status.json'));
    const controls = await optional(path.join(directory, 'control.json'));
    const cycle = await optional(
      path.join(config.root, 'runs/last-cycle.json'),
    );
    const health = await optional(
      path.join(config.root, 'runs/slack-read-health.json'),
    );
    const checked =
      typeof health?.checked_at === 'string'
        ? Date.parse(health.checked_at)
        : NaN;
    const running = alive(status?.pid) && alive(status?.worker_pid);
    const monitoring = controls?.paused
      ? 'paused'
      : status?.state === 'failed'
        ? 'failed'
        : !running
          ? 'stopped'
          : !Number.isFinite(checked)
            ? 'starting'
            : Date.now() - checked > 2 * 150_000
              ? 'stale'
              : health?.state;
    output({
      stage: 'background',
      directory,
      monitoring,
      paused: controls?.paused,
      status,
      supervisor_alive: alive(status?.pid),
      worker_alive: alive(status?.worker_pid),
      last_cycle_at: cycle?.finished_at,
      last_cycle_age_seconds:
        typeof cycle?.finished_at === 'string'
          ? Math.round((Date.now() - Date.parse(cycle.finished_at)) / 1000)
          : null,
      admission: cycle?.regular_use,
      intake_health: health,
    });
    return;
  }
  if (action === 'start' || action === 'stop') {
    // A second configuration must never control another directory's LaunchAgent.
    const program = [
      config.node,
      path.join(directory, 'runtime', 'cli.js'),
      'service',
      'run',
      '--directory',
      directory,
    ];
    const expected =
      '<key>ProgramArguments</key><array>' +
      program.map(v => '<string>' + xml(v) + '</string>').join('') +
      '</array>';
    if (!(await readFile(plistFile(), 'utf8')).includes(expected))
      throw new StoreError('background_service_identity_mismatch');
  }
  if (action === 'stop') {
    await atomicJson(path.join(directory, 'control.json'), {paused: true});
    let loaded = true;
    try {
      control(['print', target()]);
    } catch {
      loaded = false;
    }
    if (loaded) control(['bootout', target()]);
    output({stage: 'background', state: 'stop_requested', directory});
    return;
  }
  if (action === 'start') {
    const status = await optional(path.join(directory, 'status.json'));
    if (alive(status?.pid) || alive(status?.worker_pid))
      throw new StoreError('background_already_running');
    await atomicJson(path.join(directory, 'control.json'), {paused: false});
    await atomicJson(path.join(directory, 'status.json'), {
      state: 'starting',
      at: new Date().toISOString(),
    });
    let loaded = true;
    try {
      control(['print', target()]);
    } catch {
      loaded = false;
    }
    if (loaded) control(['kickstart', target()]);
    else control(['bootstrap', `gui/${process.getuid!()}`, plistFile()]);
    output({stage: 'background', state: 'start_requested', directory});
    return;
  }
  throw new StoreError('invalid_background_command');
}
