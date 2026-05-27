import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import prWorktreeStatus from '../src/index.ts';

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;

interface ExecCall {
  command: string;
  args: string[];
  cwd?: string;
}

interface FakeRuntime {
  pi: ExtensionAPI;
  calls: ExecCall[];
  commands: Map<string, CommandHandler>;
  events: Map<string, EventHandler[]>;
  getGhCallCount(): number;
}

interface UiUpdate {
  kind: 'status' | 'widget' | 'notify';
  key?: string;
  text?: string;
  content?: unknown;
  options?: unknown;
  message?: string;
  level?: string;
}

interface CapturedInterval {
  callback: () => void;
  ms?: number;
  cleared: boolean;
  unrefCalled: boolean;
  handle: NodeJS.Timeout;
}

const PR_URL = 'https://github.com/zsaplan/pi-extensions/pull/30';
const CACHE_KEY = 'branch:zsaplan/pi-extensions#pr-worktree-status';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function ok(stdout: string): ExecResult {
  return {code: 0, stdout, stderr: ''};
}

function ghError(message: string): ExecResult {
  return {code: 1, stdout: '', stderr: message};
}

function ghPayload(isDraft: boolean): string {
  return JSON.stringify({
    number: 30,
    title: 'PR worktree status',
    url: PR_URL,
    state: 'OPEN',
    isDraft,
    reviewRequests: [{slug: 'platform'}],
    statusCheckRollup: [{status: 'QUEUED'}],
    updatedAt: '2026-05-27T00:00:00Z',
  });
}

function createRuntime(
  repoRoot: string,
  ghResponder?: (callCount: number) => ExecResult,
  gitResponder?: (
    args: string[],
    cwd: string | undefined,
  ) => ExecResult | undefined,
): FakeRuntime {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler[]>();
  const calls: ExecCall[] = [];
  let ghCallCount = 0;

  const pi = {
    registerCommand(name: string, options: {handler: CommandHandler}) {
      commands.set(name, options.handler);
    },
    on(name: string, handler: EventHandler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    async exec(command: string, args: string[], options?: {cwd?: string}) {
      calls.push({command, args, cwd: options?.cwd});

      if (command === 'git') {
        const override = gitResponder?.(args, options?.cwd);
        if (override) return override;
      }

      if (command === 'git' && args[0] === 'rev-parse') {
        return ok(`${repoRoot}\n`);
      }
      if (command === 'git' && args[0] === 'branch') {
        return ok('pr-worktree-status\n');
      }
      if (command === 'git' && args[0] === 'remote') {
        return ok(
          'origin git@github.com:zsaplan/pi-extensions.git (fetch)\n' +
            'origin git@github.com:zsaplan/pi-extensions.git (push)\n',
        );
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        ghCallCount += 1;
        return ghResponder?.(ghCallCount) ?? ok(ghPayload(ghCallCount > 1));
      }

      return {code: 1, stdout: '', stderr: `unexpected command: ${command}`};
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    calls,
    commands,
    events,
    getGhCallCount: () => ghCallCount,
  };
}

function createContext(
  cwd: string,
  updates: UiUpdate[],
  sessionId = cwd,
): ExtensionContext {
  return {
    hasUI: true,
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      setStatus(key: string, text: string | undefined) {
        updates.push({kind: 'status', key, text});
      },
      setWidget(key: string, content: unknown, options?: unknown) {
        updates.push({kind: 'widget', key, content, options});
      },
      notify(message: string, level: string) {
        updates.push({kind: 'notify', message, level});
      },
    },
  } as unknown as ExtensionContext;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function withCapturedInterval(
  run: (intervalRef: {
    current?: CapturedInterval;
    all: CapturedInterval[];
  }) => Promise<void>,
): Promise<void> {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervalRef: {current?: CapturedInterval; all: CapturedInterval[]} = {
    all: [],
  };

  globalThis.setInterval = ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const interval = {
      callback: () => callback(...args),
      ms,
      cleared: false,
      unrefCalled: false,
      handle: undefined as unknown as NodeJS.Timeout,
    };
    const handle = {
      unref: () => {
        interval.unrefCalled = true;
        return handle;
      },
    } as unknown as NodeJS.Timeout;
    interval.handle = handle;
    intervalRef.current = interval;
    intervalRef.all.push(interval);
    return handle;
  }) as typeof setInterval;

  globalThis.clearInterval = ((handle: NodeJS.Timeout | undefined) => {
    for (const interval of intervalRef.all) {
      if (interval.handle === handle) interval.cleared = true;
    }
  }) as typeof clearInterval;

  try {
    await run(intervalRef);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

function widgetUpdates(updates: UiUpdate[]): UiUpdate[] {
  return updates.filter(update => update.kind === 'widget');
}

function notifyUpdates(updates: UiUpdate[]): UiUpdate[] {
  return updates.filter(update => update.kind === 'notify');
}

type WidgetFactory = (
  tui: unknown,
  theme: unknown,
) => {render(width: number): string[]};

function renderWidget(update: UiUpdate, width: number): string {
  assert.equal(typeof update.content, 'function');
  const component = (update.content as WidgetFactory)({}, {});
  assert.equal(typeof component.render, 'function');
  return component.render(width)[0];
}

test('session cron schedules refreshes, uses cache, and clears on shutdown', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pr-status-'));
  const cacheDir = path.join(tempDir, 'cache');
  const repoRoot = path.join(tempDir, 'pi-extensions');
  await fs.mkdir(repoRoot, {recursive: true});

  const oldCacheDir = process.env.PI_PR_STATUS_CACHE_DIR;
  process.env.PI_PR_STATUS_CACHE_DIR = cacheDir;
  t.after(async () => {
    if (oldCacheDir === undefined) delete process.env.PI_PR_STATUS_CACHE_DIR;
    else process.env.PI_PR_STATUS_CACHE_DIR = oldCacheDir;
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  await withCapturedInterval(async intervalRef => {
    const runtime = createRuntime(repoRoot);
    const updates: UiUpdate[] = [];
    const ctx = createContext(repoRoot, updates);

    prWorktreeStatus(runtime.pi);

    const sessionStart = runtime.events.get('session_start')?.[0];
    assert.ok(sessionStart);
    sessionStart({}, ctx);

    await waitFor(
      () =>
        runtime.getGhCallCount() === 1 && widgetUpdates(updates).length >= 1,
      'initial PR refresh did not complete',
    );

    assert.equal(intervalRef.current?.ms, REFRESH_INTERVAL_MS);
    assert.equal(intervalRef.current?.unrefCalled, true);

    const cachePath = path.join(cacheDir, 'cache.json');
    const initialCache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.equal(initialCache.entries[CACHE_KEY].kind, 'found');
    assert.equal(initialCache.entries[CACHE_KEY].pr.url, PR_URL);

    const firstWidget = widgetUpdates(updates).at(-1);
    assert.ok(firstWidget);
    assert.deepEqual(firstWidget.options, {placement: 'belowEditor'});
    const firstLine = renderWidget(firstWidget, 200).trimStart();
    assert.match(firstLine, /^open · review requested: platform/);
    assert.match(firstLine, new RegExp(`${PR_URL}$`));
    assert.doesNotMatch(firstLine, /PR #30/);

    intervalRef.current?.callback();
    await waitFor(
      () => widgetUpdates(updates).length >= 2,
      'cached interval refresh did not update the status widget',
    );
    assert.equal(runtime.getGhCallCount(), 1);

    const expiredCache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    expiredCache.entries[CACHE_KEY].expiresAt = 0;
    await fs.writeFile(cachePath, `${JSON.stringify(expiredCache, null, 2)}\n`);

    intervalRef.current?.callback();
    await waitFor(
      () =>
        runtime.getGhCallCount() === 2 && widgetUpdates(updates).length >= 3,
      'expired interval refresh did not call gh again',
    );
    const refreshedLine = renderWidget(widgetUpdates(updates).at(-1)!, 200);
    assert.match(refreshedLine, /draft/);

    const sessionShutdown = runtime.events.get('session_shutdown')?.[0];
    assert.ok(sessionShutdown);
    await sessionShutdown({}, ctx);

    assert.equal(intervalRef.current?.cleared, true);
    assert.equal(widgetUpdates(updates).at(-1)?.content, undefined);
  });
});

test('session refresh timers are isolated per session', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pr-status-'));
  const cacheDir = path.join(tempDir, 'cache');
  const repoRoot = path.join(tempDir, 'pi-extensions');
  await fs.mkdir(repoRoot, {recursive: true});

  const oldCacheDir = process.env.PI_PR_STATUS_CACHE_DIR;
  process.env.PI_PR_STATUS_CACHE_DIR = cacheDir;
  t.after(async () => {
    if (oldCacheDir === undefined) delete process.env.PI_PR_STATUS_CACHE_DIR;
    else process.env.PI_PR_STATUS_CACHE_DIR = oldCacheDir;
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  await withCapturedInterval(async intervals => {
    const runtime = createRuntime(repoRoot);
    const updates: UiUpdate[] = [];
    const firstCtx = createContext(repoRoot, updates, 'session-1');
    const secondCtx = createContext(repoRoot, updates, 'session-2');

    prWorktreeStatus(runtime.pi);

    const sessionStart = runtime.events.get('session_start')?.[0];
    const sessionShutdown = runtime.events.get('session_shutdown')?.[0];
    assert.ok(sessionStart);
    assert.ok(sessionShutdown);

    sessionStart({}, firstCtx);
    sessionStart({}, secondCtx);

    assert.equal(intervals.all.length, 2);
    assert.equal(intervals.all[0].cleared, false);
    assert.equal(intervals.all[1].cleared, false);

    await waitFor(
      () => widgetUpdates(updates).length >= 2,
      'session refreshes did not finish',
    );

    await sessionShutdown({}, firstCtx);
    assert.equal(intervals.all[0].cleared, true);
    assert.equal(intervals.all[1].cleared, false);

    await sessionShutdown({}, secondCtx);
    assert.equal(intervals.all[1].cleared, true);
  });
});

test('stale cached worktree mappings are ignored and removed', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pr-status-'));
  const cacheDir = path.join(tempDir, 'cache');
  const repoRoot = path.join(tempDir, 'pi-extensions');
  await fs.mkdir(repoRoot, {recursive: true});
  await fs.mkdir(cacheDir, {recursive: true});

  const oldCacheDir = process.env.PI_PR_STATUS_CACHE_DIR;
  process.env.PI_PR_STATUS_CACHE_DIR = cacheDir;
  t.after(async () => {
    if (oldCacheDir === undefined) delete process.env.PI_PR_STATUS_CACHE_DIR;
    else process.env.PI_PR_STATUS_CACHE_DIR = oldCacheDir;
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  await fs.writeFile(
    path.join(cacheDir, 'cache.json'),
    `${JSON.stringify(
      {
        version: 1,
        entries: {},
        worktrees: {
          [repoRoot]: {
            key: 'pr:old-owner/old-repo#99',
            path: repoRoot,
            owner: 'old-owner',
            repo: 'old-repo',
            number: 99,
            url: 'https://github.com/old-owner/old-repo/pull/99',
            createdAt: Date.now(),
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  await withCapturedInterval(async () => {
    const runtime = createRuntime(repoRoot);
    const updates: UiUpdate[] = [];
    const ctx = createContext(repoRoot, updates);

    prWorktreeStatus(runtime.pi);

    const sessionStart = runtime.events.get('session_start')?.[0];
    assert.ok(sessionStart);
    sessionStart({}, ctx);

    await waitFor(
      () =>
        runtime.getGhCallCount() === 1 && widgetUpdates(updates).length >= 1,
      'branch-inferred refresh did not complete',
    );

    const ghCall = runtime.calls.find(call => call.command === 'gh');
    assert.ok(ghCall);
    assert.deepEqual(ghCall.args.slice(0, 2), ['pr', 'view']);
    assert.doesNotMatch(ghCall.args.join(' '), /old-owner/);

    const cache = JSON.parse(
      await fs.readFile(path.join(cacheDir, 'cache.json'), 'utf8'),
    );
    assert.equal(cache.worktrees[repoRoot], undefined);
  });
});

test('forced refresh makes stale cached status explicit when gh fails', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pr-status-'));
  const cacheDir = path.join(tempDir, 'cache');
  const repoRoot = path.join(tempDir, 'pi-extensions');
  await fs.mkdir(repoRoot, {recursive: true});

  const oldCacheDir = process.env.PI_PR_STATUS_CACHE_DIR;
  process.env.PI_PR_STATUS_CACHE_DIR = cacheDir;
  t.after(async () => {
    if (oldCacheDir === undefined) delete process.env.PI_PR_STATUS_CACHE_DIR;
    else process.env.PI_PR_STATUS_CACHE_DIR = oldCacheDir;
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  await withCapturedInterval(async () => {
    const runtime = createRuntime(repoRoot, callCount =>
      callCount === 1
        ? ok(ghPayload(false))
        : ghError('HTTP 401: bad credentials'),
    );
    const updates: UiUpdate[] = [];
    const ctx = createContext(repoRoot, updates);

    prWorktreeStatus(runtime.pi);

    const sessionStart = runtime.events.get('session_start')?.[0];
    assert.ok(sessionStart);
    sessionStart({}, ctx);

    await waitFor(
      () =>
        runtime.getGhCallCount() === 1 && widgetUpdates(updates).length >= 1,
      'initial good PR refresh did not complete',
    );

    const cachePath = path.join(cacheDir, 'cache.json');
    const expiredCache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    expiredCache.entries[CACHE_KEY].expiresAt = 0;
    await fs.writeFile(cachePath, `${JSON.stringify(expiredCache, null, 2)}\n`);

    const refresh = runtime.commands.get('pr-refresh');
    assert.ok(refresh);
    await refresh('', ctx);

    assert.equal(runtime.getGhCallCount(), 2);
    const staleLine = renderWidget(
      widgetUpdates(updates).at(-1)!,
      240,
    ).trimStart();
    assert.match(staleLine, /^stale: refresh failed/);
    assert.match(staleLine, /bad credentials/);
    assert.match(staleLine, /open · review requested: platform/);
    assert.match(staleLine, new RegExp(`${PR_URL}$`));
    assert.doesNotMatch(staleLine, /PR #30/);

    const notification = notifyUpdates(updates).at(-1);
    assert.ok(notification);
    assert.equal(notification.level, 'warning');
    assert.match(notification.message ?? '', /^Showing stale PR status/);
  });
});

test('/pr-worktree rejects an existing non-matching sibling path', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pr-status-'));
  const cacheDir = path.join(tempDir, 'cache');
  const repoRoot = path.join(tempDir, 'pi-extensions');
  const collisionPath = path.join(tempDir, 'pi-extensions-pr-30');
  await fs.mkdir(repoRoot, {recursive: true});
  await fs.mkdir(collisionPath, {recursive: true});

  const oldCacheDir = process.env.PI_PR_STATUS_CACHE_DIR;
  process.env.PI_PR_STATUS_CACHE_DIR = cacheDir;
  t.after(async () => {
    if (oldCacheDir === undefined) delete process.env.PI_PR_STATUS_CACHE_DIR;
    else process.env.PI_PR_STATUS_CACHE_DIR = oldCacheDir;
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  const runtime = createRuntime(repoRoot);
  const updates: UiUpdate[] = [];
  const ctx = createContext(repoRoot, updates);
  prWorktreeStatus(runtime.pi);

  const command = runtime.commands.get('pr-worktree');
  assert.ok(command);
  await command(PR_URL, ctx);

  const notification = notifyUpdates(updates).at(-1);
  assert.ok(notification);
  assert.equal(notification.level, 'error');
  assert.match(
    notification.message ?? '',
    /Existing PR worktree path resolves to/,
  );

  const cachePath = path.join(cacheDir, 'cache.json');
  await assert.rejects(fs.readFile(cachePath, 'utf8'), /ENOENT/);
});

test('/pr-worktree rejects an existing stale PR branch', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pr-status-'));
  const cacheDir = path.join(tempDir, 'cache');
  const repoRoot = path.join(tempDir, 'pi-extensions');
  const collisionPath = path.join(tempDir, 'pi-extensions-pr-30');
  await fs.mkdir(repoRoot, {recursive: true});
  await fs.mkdir(collisionPath, {recursive: true});

  const oldCacheDir = process.env.PI_PR_STATUS_CACHE_DIR;
  process.env.PI_PR_STATUS_CACHE_DIR = cacheDir;
  t.after(async () => {
    if (oldCacheDir === undefined) delete process.env.PI_PR_STATUS_CACHE_DIR;
    else process.env.PI_PR_STATUS_CACHE_DIR = oldCacheDir;
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  const remoteOutput =
    'origin git@github.com:zsaplan/pi-extensions.git (fetch)\n' +
    'origin git@github.com:zsaplan/pi-extensions.git (push)\n';
  const runtime = createRuntime(repoRoot, undefined, (args, cwd) => {
    if (cwd !== collisionPath) return undefined;
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return ok(`${collisionPath}\n`);
    }
    if (args[0] === 'remote') return ok(remoteOutput);
    if (args[0] === 'branch') return ok('pr-30\n');
    if (args[0] === 'fetch') return ok('');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('old\n');
    if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') {
      return ok('new\n');
    }
    return undefined;
  });
  const updates: UiUpdate[] = [];
  const ctx = createContext(repoRoot, updates);
  prWorktreeStatus(runtime.pi);

  const command = runtime.commands.get('pr-worktree');
  assert.ok(command);
  await command(PR_URL, ctx);

  const notification = notifyUpdates(updates).at(-1);
  assert.ok(notification);
  assert.equal(notification.level, 'error');
  assert.match(notification.message ?? '', /not at the latest PR ref/);

  const cachePath = path.join(cacheDir, 'cache.json');
  await assert.rejects(fs.readFile(cachePath, 'utf8'), /ENOENT/);
});

test('refresh without cached PR displays hard gh errors clearly', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pr-status-'));
  const cacheDir = path.join(tempDir, 'cache');
  const repoRoot = path.join(tempDir, 'pi-extensions');
  await fs.mkdir(repoRoot, {recursive: true});

  const oldCacheDir = process.env.PI_PR_STATUS_CACHE_DIR;
  process.env.PI_PR_STATUS_CACHE_DIR = cacheDir;
  t.after(async () => {
    if (oldCacheDir === undefined) delete process.env.PI_PR_STATUS_CACHE_DIR;
    else process.env.PI_PR_STATUS_CACHE_DIR = oldCacheDir;
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  await withCapturedInterval(async () => {
    const runtime = createRuntime(repoRoot, () => ghError('gh auth required'));
    const updates: UiUpdate[] = [];
    const ctx = createContext(repoRoot, updates);

    prWorktreeStatus(runtime.pi);

    const sessionStart = runtime.events.get('session_start')?.[0];
    assert.ok(sessionStart);
    sessionStart({}, ctx);

    await waitFor(
      () =>
        runtime.getGhCallCount() === 1 && widgetUpdates(updates).length >= 1,
      'initial gh error did not update the status widget',
    );

    const errorLine = renderWidget(
      widgetUpdates(updates).at(-1)!,
      120,
    ).trimStart();
    assert.equal(errorLine, 'PR status error: gh auth required');

    const cachePath = path.join(cacheDir, 'cache.json');
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.equal(cache.entries[CACHE_KEY].kind, 'error');
    assert.equal(cache.entries[CACHE_KEY].message, 'gh auth required');
  });
});
