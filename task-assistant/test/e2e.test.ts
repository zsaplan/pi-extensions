import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'dist/cli.js');
const secretText = 'fixture-private-message-do-not-log';
const fullArgs = [
  '--conversation',
  'DASSIST',
  '--source-thread',
  'CSOURCE:1700000000.000001',
];

interface RequestRecord {
  method: string;
  identity: string;
  params: Record<string, string>;
}

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  requests: RequestRecord[];
}

test('real preflight CLI against a synthetic Slack HTTP service', async t => {
  await mkdir(path.join(root, 'tmp'), {recursive: true});
  const artifact = await mkdtemp(path.join(root, 'tmp/e2e-'));
  const preload = path.join(artifact, 'fetch.mjs');
  await writeFile(
    preload,
    `
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (process.env.FIXTURE_THROW === '1') throw new Error('fixture-user fixture-bot secret');
  const parsed = new URL(String(url));
  if (parsed.origin !== 'https://slack.com' || !parsed.pathname.startsWith('/api/')) {
    throw new Error('Unexpected destination');
  }
  return originalFetch(new URL(parsed.pathname, process.env.FIXTURE_ORIGIN), options);
};
`,
  );
  let scenario = 'happy';
  let requests: RequestRecord[] = [];
  let requestHook: ((method: string) => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const method = (req.url ?? '').replace('/api/', '');
    const identity =
      req.headers.authorization === 'Bearer fixture-user'
        ? 'user'
        : req.headers.authorization === 'Bearer fixture-bot'
          ? 'bot'
          : 'unknown';
    requests.push({
      method,
      identity,
      params: Object.fromEntries(new URLSearchParams(body)),
    });
    requestHook?.(method);
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST' || identity === 'unknown') {
      res.statusCode = 400;
      res.end(JSON.stringify({ok: false, error: 'unexpected_request'}));
      return;
    }
    const reply = (value: unknown) => res.end(JSON.stringify(value));
    if (method === 'auth.test') {
      reply({
        ok: true,
        team_id:
          scenario === 'workspace-mismatch' && identity === 'bot'
            ? 'TOTHER'
            : 'TONE',
        user_id: identity === 'user' ? 'UOWNER' : 'UBOT',
        ...(identity === 'bot' || scenario === 'user-is-bot'
          ? {bot_id: 'BONE'}
          : {}),
      });
      return;
    }
    if (method === 'search.messages' || method === 'assistant.search.context') {
      if (scenario === 'hang') return;
      if (scenario === 'scope') {
        reply({
          ok: false,
          error: 'missing_scope',
          needed: 'search:read.public,search:read.private',
          secret: secretText,
        });
        return;
      }
      if (scenario === 'rate-limit') {
        res.statusCode = 429;
        res.setHeader('Retry-After', '600');
        reply({ok: false, secret: secretText});
        return;
      }
      if (scenario === 'malformed') {
        reply({ok: true});
        return;
      }
      if (scenario === 'unsafe-error') {
        reply({
          ok: false,
          error: 'fixture-user fixture-bot',
          needed: 'fixture-user secret',
        });
        return;
      }
      if (scenario === 'http-error') {
        res.statusCode = 503;
        res.end(secretText);
        return;
      }
      const messages =
        scenario === 'empty'
          ? []
          : [
              {
                text: `<@UOWNER> ${secretText}`,
                content: `<@UOWNER> ${secretText}`,
                ts: '1700000000.000001',
                channel: {id: 'CSOURCE'},
              },
            ];
      reply(
        method === 'search.messages'
          ? {
              ok: true,
              messages: {matches: messages, pagination: {page_count: 3}},
            }
          : {ok: true, results: {messages}, next_cursor: 'fixture-next-page'},
      );
      return;
    }
    if (method === 'conversations.info') {
      reply({
        ok: true,
        channel: {
          id: 'DASSIST',
          is_im: true,
          user: scenario === 'wrong-owner' ? 'UOTHER' : 'UOWNER',
        },
      });
      return;
    }
    if (method === 'conversations.history') {
      reply({
        ok: true,
        messages: [{ts: '1700000000.000002', text: secretText}],
        has_more: true,
      });
      return;
    }
    if (method === 'conversations.replies') {
      reply({
        ok: true,
        messages: [
          {
            ts:
              scenario === 'wrong-root'
                ? '1700000000.000002'
                : '1700000000.000001',
            text: secretText,
          },
        ],
        response_metadata: {next_cursor: ''},
      });
      return;
    }
    res.statusCode = 400;
    reply({ok: false, error: 'unexpected_method'});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const evidence: unknown[] = [];
  const releaseManifest = process.env.TASK_FIXTURE_RELEASE_MANIFEST
    ? JSON.parse(
        await readFile(process.env.TASK_FIXTURE_RELEASE_MANIFEST, 'utf8'),
      )
    : undefined;
  let revision = 'unavailable';
  try {
    revision =
      releaseManifest?.source.commit ??
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
  } catch {
    /* Packaged checks need not run inside Git. */
  }

  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(
      path.join(artifact, 'report.json'),
      JSON.stringify(
        {
          schema_version: 1,
          suite: 'preflight-cli-e2e',
          invocation: 'npm run test --workspace task-assistant',
          node: process.version,
          base_revision: revision,
          release_id: releaseManifest?.id,
          executed_from_worktree: !releaseManifest,
          live_slack: false,
          model_invoked: false,
          outcomes: evidence,
          unverified: [
            'Live search scopes and completeness',
            'Live inbox/thread access',
            'Task/session execution',
            'Slack writes',
            'Restart recovery',
          ],
        },
        null,
        2,
      ) + '\n',
    );
    t.diagnostic(`Evidence: ${path.join(artifact, 'report.json')}`);
  });

  async function run(
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      stopAfterOutput?: boolean;
      stopOnRequest?: string;
    } = {},
  ): Promise<Result> {
    requests = [];
    const child = spawn(process.execPath, ['--import', preload, cli, ...args], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        SLACK_USER_TOKEN: 'fixture-user',
        SLACK_BOT_TOKEN: 'fixture-bot',
        TASK_ASSISTANT_SEARCH_API: '',
        TASK_ASSISTANT_CONVERSATION: '',
        FIXTURE_ORIGIN: origin,
        FIXTURE_THROW: '',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      if (options.stopAfterOutput && stdout.includes('\n'))
        child.kill('SIGTERM');
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
    });
    requestHook = method => {
      if (method === options.stopOnRequest) child.kill('SIGTERM');
    };
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const [code, signal] = (await once(child, 'close')) as [
      number | null,
      NodeJS.Signals | null,
    ];
    clearTimeout(watchdog);
    requestHook = undefined;
    assert.notEqual(
      signal,
      'SIGKILL',
      'CLI failed to finish/cancel within ten seconds',
    );
    for (const secret of ['fixture-user', 'fixture-bot', secretText]) {
      assert.ok(
        !stdout.includes(secret) && !stderr.includes(secret),
        'CLI exposed fixture secrets/text',
      );
    }
    const result = {code, signal, stdout, stderr, requests: [...requests]};
    evidence.push({args, result});
    return result;
  }

  async function example(
    name: string,
    body: () => Promise<void>,
  ): Promise<void> {
    await t.test(name, async () => {
      scenario = 'happy';
      let status = 'failed';
      try {
        await body();
        status = 'passed';
      } finally {
        evidence.push({scenario: name, status});
      }
    });
  }

  await example(
    'packaged JavaScript CLI runs inside node_modules without TypeScript stripping',
    async () => {
      const packed = JSON.parse(
        execFileSync(
          'npm',
          [
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            artifact,
          ],
          {
            cwd: root,
            encoding: 'utf8',
          },
        ),
      );
      const files = packed[0].files.map((file: {path: string}) => file.path);
      assert.ok(files.includes('dist/cli.js'));
      assert.ok(
        !files.some(
          (file: string) => file.startsWith('tmp/') || file.startsWith('src/'),
        ),
      );
      const installed = path.join(
        artifact,
        'node_modules/@zsaplan/pi-task-assistant',
      );
      await mkdir(installed, {recursive: true});
      execFileSync('tar', [
        '-xzf',
        path.join(artifact, packed[0].filename),
        '-C',
        installed,
        '--strip-components=1',
      ]);
      const output = execFileSync(
        process.execPath,
        [path.join(installed, 'dist/cli.js'), '--help'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            SLACK_USER_TOKEN: '',
            SLACK_BOT_TOKEN: '',
          },
        },
      );
      assert.match(output, /read-only preflight/);
    },
  );

  await example('help needs no credentials or network', async () => {
    const result = await run(['--help'], {
      env: {SLACK_USER_TOKEN: '', SLACK_BOT_TOKEN: ''},
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /read-only preflight/);
    assert.equal(result.requests.length, 0);
  });

  await example(
    'missing secrets and malformed configuration fail before network access',
    async () => {
      for (const [args, env] of [
        [['preflight', '--search-api', 'legacy'], {SLACK_USER_TOKEN: ''}],
        [['preflight'], {}],
        [
          [
            'preflight',
            '--search-api',
            'legacy',
            '--source-thread',
            'not-a-thread',
          ],
          {},
        ],
      ] as Array<[string[], NodeJS.ProcessEnv]>) {
        const result = await run(args, {env});
        assert.equal(result.code, 1);
        assert.equal(JSON.parse(result.stdout).error, 'configuration_error');
        assert.equal(result.requests.length, 0);
      }
    },
  );

  await example(
    'legacy probes preserve identity boundaries and report partial coverage',
    async () => {
      const result = await run([
        'run',
        '--once',
        '--search-api',
        'legacy',
        ...fullArgs,
      ]);
      assert.equal(result.code, 0);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'passed');
      assert.equal(report.discovery_complete, false);
      assert.equal(report.writes_performed, 0);
      assert.equal(report.tasks_started, 0);
      assert.equal(
        report.checks.find(
          (check: {name: string}) => check.name === 'search_access',
        ).details.additional_pages,
        true,
      );
      assert.deepEqual(
        result.requests
          .filter(request => request.method !== 'auth.test')
          .map(({method, identity}) => [method, identity]),
        [
          ['search.messages', 'user'],
          ['conversations.info', 'bot'],
          ['conversations.history', 'bot'],
          ['conversations.replies', 'user'],
        ],
      );
      const search = result.requests.find(
        request => request.method === 'search.messages',
      );
      assert.match(
        search?.params.query ?? '',
        /^<@UOWNER> after:\d{4}-\d{2}-\d{2}$/,
      );
    },
  );

  await example(
    'realtime search uses the owner token and no event action token',
    async () => {
      const result = await run([
        'preflight',
        '--search-api',
        'realtime',
        ...fullArgs,
      ]);
      assert.equal(result.code, 0);
      const search = result.requests.find(
        request => request.method === 'assistant.search.context',
      );
      assert.equal(search?.identity, 'user');
      assert.equal(search?.params.query, '<@UOWNER>');
      assert.equal(search?.params.limit, '20');
      assert.match(search?.params.after ?? '', /^\d+$/);
      assert.equal(search?.params.action_token, undefined);
      assert.equal(
        search?.params.channel_types,
        'public_channel,private_channel,mpim,im',
      );
    },
  );

  await example(
    'unconfigured conversation/thread remain unverified',
    async () => {
      const result = await run(['preflight', '--search-api', 'legacy']);
      assert.equal(result.code, 2);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'incomplete');
      assert.equal(
        report.checks.filter(
          (check: {status: string}) => check.status === 'unverified',
        ).length,
        2,
      );
    },
  );

  await example(
    'empty results verify access, not a mention example',
    async () => {
      scenario = 'empty';
      const result = await run([
        'preflight',
        '--search-api',
        'legacy',
        ...fullArgs,
      ]);
      const search = JSON.parse(result.stdout).checks.find(
        (check: {name: string}) => check.name === 'search_access',
      );
      assert.equal(result.code, 0);
      assert.equal(search.details.exact_mention_markup_matches, 0);
      assert.equal(search.details.coverage_verified, false);
    },
  );

  await example(
    'identity errors stop before reading conversations',
    async () => {
      for (const mode of ['workspace-mismatch', 'user-is-bot']) {
        scenario = mode;
        const result = await run([
          'preflight',
          '--search-api',
          'legacy',
          ...fullArgs,
        ]);
        assert.equal(result.code, 1);
        assert.equal(JSON.parse(result.stdout).status, 'blocked');
        assert.ok(
          result.requests.every(request => request.method === 'auth.test'),
        );
      }
    },
  );

  await example(
    'missing scopes stop foreground mode without fallback',
    async () => {
      scenario = 'scope';
      const result = await run([
        'run',
        '--search-api',
        'realtime',
        ...fullArgs,
      ]);
      assert.equal(result.code, 1);
      const failure = JSON.parse(result.stdout).checks.find(
        (check: {error: string}) => check.error === 'missing_scope',
      );
      assert.deepEqual(failure.required_scopes, [
        'search:read.public',
        'search:read.private',
      ]);
      assert.ok(
        !result.requests.some(request => request.method === 'search.messages'),
      );
    },
  );

  await example(
    'malformed success, unsafe errors, and server failures remain failures',
    async () => {
      for (const [mode, expected] of [
        ['malformed', 'invalid_response'],
        ['unsafe-error', 'slack_error'],
        ['http-error', 'service_unavailable'],
      ]) {
        scenario = mode;
        const result = await run([
          'preflight',
          '--search-api',
          'legacy',
          ...fullArgs,
        ]);
        assert.equal(result.code, 1);
        assert.ok(
          JSON.parse(result.stdout).checks.some(
            (check: {error: string}) => check.error === expected,
          ),
        );
      }
    },
  );

  await example(
    'wrong DM owner and wrong source root are rejected',
    async () => {
      for (const [mode, expected] of [
        ['wrong-owner', 'conversation_owner_mismatch'],
        ['wrong-root', 'thread_root_not_returned'],
      ]) {
        scenario = mode;
        const result = await run([
          'preflight',
          '--search-api',
          'legacy',
          ...fullArgs,
        ]);
        assert.equal(result.code, 1);
        assert.ok(
          JSON.parse(result.stdout).checks.some(
            (check: {error: string}) => check.error === expected,
          ),
        );
        if (mode === 'wrong-owner')
          assert.ok(
            !result.requests.some(
              request => request.method === 'conversations.history',
            ),
          );
      }
    },
  );

  await example(
    '429 exposes retry timing and an idle runner can be stopped',
    async () => {
      scenario = 'rate-limit';
      const result = await run(['run', '--search-api', 'legacy', ...fullArgs], {
        stopAfterOutput: true,
      });
      assert.equal(result.code, 0);
      const report = JSON.parse(result.stdout);
      assert.equal(report.retry_after_seconds, 600);
      assert.equal(report.retryable, true);
      assert.equal(
        result.requests.filter(request => request.method === 'search.messages')
          .length,
        1,
      );
    },
  );

  await example(
    'SIGTERM cancels in-flight requests and prevents later reads',
    async () => {
      scenario = 'hang';
      const result = await run(['run', '--search-api', 'legacy', ...fullArgs], {
        stopOnRequest: 'search.messages',
      });
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).status, 'cancelled');
      assert.ok(
        !result.requests.some(
          request => request.method === 'conversations.info',
        ),
      );
    },
  );

  await example('transport exceptions cannot leak credentials', async () => {
    const result = await run(
      ['preflight', '--search-api', 'legacy', ...fullArgs],
      {env: {FIXTURE_THROW: '1'}},
    );
    assert.equal(result.code, 1);
    assert.ok(
      JSON.parse(result.stdout).checks.every(
        (check: {error: string}) => check.error === 'transport_error',
      ),
    );
    assert.equal(result.requests.length, 0);
  });
});
