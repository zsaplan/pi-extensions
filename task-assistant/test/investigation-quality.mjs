// Opt-in real-provider check. Synthetic Grafana only; never starts serve or sends Slack.
// Build first, then: node task-assistant/test/investigation-quality.mjs [--foreign|--distractor|--empty]
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, writeFile, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {TaskStore} from '../dist/store.js';
import {TaskLogFeed} from '../dist/task-logs.js';
import {TaskInvestigation} from '../dist/task-investigation.js';
import {runNextTask} from '../dist/worker.js';

const pkg = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(pkg, 'tmp/followup-quality'), {recursive: true});
const directory = await mkdtemp(path.join(pkg, 'tmp/followup-quality/run-'));
const root = path.join(directory, 'state'),
  chart = path.join(directory, 'bundle'),
  manifest = path.join(directory, 'site.yaml');
const variant = process.argv.includes('--foreign')
  ? 'foreign'
  : process.argv.includes('--distractor')
    ? 'distractor'
    : process.argv.includes('--empty')
      ? 'empty'
      : 'useful';
await mkdir(chart);
await writeFile(
  manifest,
  'kind: Site\nmetadata:\n  name: acme-test\nspec:\n  client: acme-test\n  environment: test\n  application:\n    chart:\n      version: 1.2.3\n    values:\n      global:\n        faro:\n          enabled: true\n',
);
await writeFile(
  path.join(chart, 'Chart.yaml'),
  'name: bundle\nversion: 1.2.3\n',
);
await writeFile(
  path.join(chart, 'values.yaml'),
  'global:\n  faro:\n    enabled: false\nbriteauth:\n  enabled: true\n',
);
const firstId = '1'.repeat(32),
  nextId = '2'.repeat(32),
  stamp = Date.now() - 5000;
const requests = [],
  journals = [];
let cycle = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.hostname === 'slack.com') throw Error('Live Slack forbidden');
  if (url.hostname !== 'grafana.britecorepro.com')
    return realFetch(input, options);
  assert.equal(options?.method ?? 'GET', 'GET');
  requests.push({
    cycle,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  });
  if (url.pathname === '/api/datasources/name/loki-test')
    return Response.json({
      name: 'loki-test',
      type: 'loki',
      uid: 'fixture-loki',
    });
  if (url.pathname === '/api/datasources/name/tempo-test')
    return Response.json({
      name: 'tempo-test',
      type: 'tempo',
      uid: 'fixture-tempo',
    });
  if (url.pathname.endsWith('/query_range'))
    return Response.json({
      status: 'success',
      data: {
        resultType: 'streams',
        result: [
          {
            stream: {
              client_name: 'acme-test',
              service_name: 'briteauth',
              levelname: 'ERROR',
            },
            values: [
              [
                String(BigInt(stamp) * 1000000n),
                'Login handler returned an error; no trace ID attached.',
              ],
            ],
          },
        ],
      },
    });
  if (url.pathname.endsWith('/api/search')) {
    const query = url.searchParams.get('q');
    assert.ok(query.includes('resource.client_name = "acme-test"'));
    assert.equal(url.searchParams.get('limit'), '6');
    const targeted = query.includes('resource.service.name = "briteauth"');
    return Response.json({
      traces:
        targeted && variant === 'empty'
          ? []
          : [
              {
                traceID: targeted ? nextId : firstId,
                rootServiceName: 'briteauth',
              },
            ],
      metrics: {totalJobs: 1, completedJobs: 1},
    });
  }
  if (url.pathname.includes('/api/traces/')) {
    const id = url.pathname.split('/').at(-1);
    assert.ok([firstId, nextId].includes(id));
    const followed = id === nextId,
      distracting = followed && variant === 'distractor';
    const span = (name, duration, spanId, parentSpanId) => ({
      traceId: id,
      spanId,
      ...(parentSpanId ? {parentSpanId} : {}),
      name,
      startTimeUnixNano: String(BigInt(stamp) * 1000000n),
      endTimeUnixNano: String(BigInt(stamp + duration) * 1000000n),
      status: {code: 2},
      attributes: [{key: 'http.status_code', value: {intValue: 503}}],
    });
    const batch = (service, spans) => ({
      resource: {
        attributes: [
          {
            key: 'client_name',
            value: {
              stringValue:
                followed && variant === 'foreign' ? 'other-site' : 'acme-test',
            },
          },
          {key: 'service.name', value: {stringValue: service}},
        ],
      },
      scopeSpans: [{spans}],
    });
    return Response.json({
      batches: distracting
        ? [
            batch('briteauth', [
              span('POST /maintenance/token', 100, '1111111111111111'),
            ]),
          ]
        : [
            batch('briteauth', [
              span('POST /login', 2400, '1111111111111111'),
              span(
                'user-directory request',
                2300,
                '2222222222222222',
                '1111111111111111',
              ),
            ]),
            ...(followed
              ? [
                  batch('user-directory', [
                    span(
                      'directory cache read',
                      2200,
                      '3333333333333333',
                      '2222222222222222',
                    ),
                  ]),
                ]
              : []),
          ],
    });
  }
  throw Error('Unexpected Grafana route');
};
let store = await TaskStore.acquire(root);
try {
  const {item} = await store.enqueue({
    request:
      'Investigate reported login failures for the selected test site. Use the available scoped evidence to narrow the failing dependency, and pursue a useful next check when one is available. Do not confuse another operation with the login workflow. Keep this investigation in review; give a self-contained answer when findings materially change. Do not invent cause, affected-user counts or recovery from missing samples.',
    outcome:
      'Supported findings about the login failure, with a specific remaining gap and an earned stopping point. No external writes.',
    sources: [
      {
        workspace_id: 'TFIXTURE',
        channel_id: 'CLOGIN',
        message_ts: '1791830000.000000',
      },
    ],
    inbox: {
      workspace_id: 'TFIXTURE',
      channel_id: 'DFIXTURE',
      owner_user_id: 'UOWNER',
      bot_user_id: 'UBOT',
    },
  });
  const id = item.task.id,
    config = {provider: 'openai-codex', model: 'gpt-6.1-sol'};
  for (cycle = 0; cycle < 3; cycle++) {
    const logs = await TaskLogFeed.open(
      store,
      {task_id: id, site: 'acme-test', environment: 'test'},
      'synthetic-key',
    );
    const investigation = await TaskInvestigation.open(
      store,
      logs,
      manifest,
      chart,
    );
    const signal = AbortSignal.timeout(150000);
    assert.equal((await logs.poll(signal)).status, 'passed');
    if (cycle > 0) {
      assert.equal(await logs.pending(), undefined);
      const needed = await investigation.needsFollowup?.();
      if (needed && (await store.locate(id)).status === 'review')
        await store.move(id, 'queued');
    }
    const result = await runNextTask(
      store,
      config,
      signal,
      undefined,
      undefined,
      logs,
      investigation,
    );
    const journal = JSON.parse(
      await readFile(path.join(root, 'runs', id + '.json'), 'utf8'),
    );
    journals.push({cycle, worker: result, journal});
    // A new owner process, the same task and exact Pi session; no manual requeue except the scheduler's predicate.
    await store.close();
    store = await TaskStore.acquire(root);
  }
  const evidenceDirectory = path.join(root, 'runs/evidence', id);
  const evidence = await Promise.all(
    (await readdir(evidenceDirectory))
      .filter(name => name.endsWith('-inspect_task_traces.json'))
      .map(async name =>
        JSON.parse(await readFile(path.join(evidenceDirectory, name), 'utf8')),
      ),
  );
  const checks = {
    persisted_lead:
      journals[0].journal.investigation_progress?.checkpoint?.status ===
      'follow_up',
    targeted_followup: requests.some(
      r =>
        r.cycle === 1 &&
        r.query.q?.includes('resource.service.name = "briteauth"'),
    ),
    same_session:
      journals[0].journal.session_id === journals[1].journal.session_id,
    two_settled_runs: journals
      .slice(0, 2)
      .every(
        ({worker, journal}) =>
          worker.status === 'review' && journal.phase === 'settled',
      ),
    followup_consumed:
      journals[1].journal.investigation_progress?.followup_used === true,
    stopped_after_one_followup: journals[2].worker.status === 'idle',
    unchanged_followup_silent:
      variant === 'useful' || journals[1].journal.outcome?.reply === null,
    useful_followup_answered:
      variant !== 'useful' || Boolean(journals[1].journal.outcome?.reply),
    request_budget: [0, 1].every(
      cycle =>
        requests.filter(
          r => r.cycle === cycle && r.path.includes('/api/traces/'),
        ).length <= 3,
    ),
  };
  const patch = execFileSync('git', ['diff', '--', 'task-assistant/src/'], {
    cwd: path.resolve(pkg, '..'),
    encoding: 'utf8',
  });
  await writeFile(path.join(directory, 'runtime.patch'), patch, {
    flag: 'wx',
    mode: 0o600,
  });
  const runtime_files = {};
  await mkdir(path.join(directory, 'runtime'));
  for (const name of [
    'worker',
    'task-investigation',
    'task-logs',
    'investigation-progress',
    'serve',
  ]) {
    try {
      const content = await readFile(path.join(pkg, 'dist', name + '.js'));
      runtime_files[name] = createHash('sha256').update(content).digest('hex');
      await writeFile(path.join(directory, 'runtime', name + '.js'), content, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const report = {
    runtime_files,
    checked_at: new Date().toISOString(),
    directory,
    variant,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: pkg,
      encoding: 'utf8',
    }).trim(),
    node: process.version,
    pi: JSON.parse(
      await readFile(
        new URL(
          '../package.json',
          import.meta.resolve('@earendil-works/pi-coding-agent'),
        ),
        'utf8',
      ),
    ).version,
    ...config,
    checks,
    result: Object.values(checks).every(Boolean)
      ? 'requires_source_based_answer_review'
      : 'failed_followup_gate',
    requests,
    evidence,
    journals,
    limitations:
      'Synthetic evidence with real provider. Not live acceptance or a broad quality score. Review the actual evidence, conclusions and stopping reason; mechanics alone are insufficient.',
  };
  await writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    {flag: 'wx', mode: 0o600},
  );
  console.log(
    JSON.stringify({
      directory,
      variant,
      checks,
      result: report.result,
      answers: journals.map(({worker, journal}) =>
        worker.status === 'idle' ? null : journal.outcome?.reply,
      ),
    }),
  );
  if (!Object.values(checks).every(Boolean)) process.exitCode = 2;
} finally {
  await store.close();
  globalThis.fetch = realFetch;
}
