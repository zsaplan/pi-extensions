// Opt-in real-model proof. Build first, then run from root:
// node task-assistant/test/concurrency-quality.mjs
// Synthetic Slack and task facts only; never starts serve or touches live task roots.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {TaskStore, digest, sourceKey} from '../dist/store.js';
import {AutoTrial} from '../dist/auto-trial.js';
import {ReadonlySlackClient} from '../dist/slack.js';
import {pollIntake, receipts, saveReceipt} from '../dist/intake.js';
import {classifyPending, recoverRuns, taskPublication} from '../dist/worker.js';
import {runTaskBatch} from '../dist/worker-pool.js';
import {TaskMessenger} from '../dist/task-slack.js';

const pkg = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(pkg, 'tmp/concurrency'), {recursive: true});
const directory = await mkdtemp(path.join(pkg, 'tmp/concurrency/provider-'));
const root = path.join(directory, 'state');
const config = {provider: 'openai-codex', model: 'gpt-6.1-sol'};
const automatic = process.argv.includes('--automatic');
const excludedFile = path.join(directory, 'excluded.json');
await writeFile(excludedFile, '[]');
const discovery = {mentionGroup: 'SOPS', watchChannel: 'CWATCH'};
const inbox = {
  workspace_id: 'TFIXTURE',
  channel_id: 'DFIXTURE',
  owner_user_id: 'UOWNER',
  bot_user_id: 'UBOT',
};
const tokens = {user: 'fixture-user', bot: 'fixture-bot'};
const fixtures = [
  {
    name: 'Amber',
    marker: 'AMBER4827',
    request:
      'Draft a launch note. Scope is a staging-only preview, not a production release. Ask the owner to choose the launch date first.',
    answer: 'Use November 2, 2026.',
    facts: ['2026', '2'],
  },
  {
    name: 'Birch',
    marker: 'BIRCH6538',
    request:
      'Draft a storage cleanup checklist for staging assets only. Ask the owner to choose the retention period in days first.',
    answer: 'Keep 14 days.',
    facts: ['14'],
  },
  {
    name: 'Cedar',
    marker: 'CEDAR9172',
    request:
      'Draft a short incident note: 3 of 20 synthetic file-processing jobs failed parsing; recovery is unverified. Ask the owner to choose the incident time window first.',
    answer: 'Use October 13, 2026, 03:00 to 03:15 UTC.',
    facts: ['03:00', '03:15'],
  },
];
const messages = [];
const requests = [],
  cycles = [],
  checks = {};
let sequence = 0,
  phase = 0,
  active = 0,
  maximum = 0;
const activeTasks = new Set();
const timestamp = () =>
  `${Math.floor(Date.now() / 1000) - 1}.${String(++sequence).padStart(6, '0')}`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.origin === 'https://slack.com') {
    const params = Object.fromEntries(new URLSearchParams(options?.body));
    const method = url.pathname.replace('/api/', '');
    const bot = options?.headers?.Authorization === 'Bearer fixture-bot';
    if (method === 'auth.test')
      return Response.json({
        ok: true,
        team_id: 'TFIXTURE',
        user_id: bot ? 'UBOT' : 'UOWNER',
        ...(bot ? {bot_id: 'BFIXTURE'} : {}),
      });
    if (method === 'users.info')
      return Response.json({
        ok: true,
        user: {
          id: params.user,
          team_id: 'TFIXTURE',
          profile: {display_name: 'Owner Example'},
        },
      });
    if (method === 'conversations.info')
      return Response.json({
        ok: true,
        channel: {id: 'DFIXTURE', is_im: true, user: 'UOWNER'},
      });
    if (
      method === 'conversations.history' ||
      method === 'conversations.replies'
    )
      return Response.json({
        ok: true,
        messages: messages
          .filter(
            m =>
              m.channel === params.channel &&
              (method === 'conversations.history'
                ? !m.thread_ts
                : m.ts === params.ts || m.thread_ts === params.ts),
          )
          .slice()
          .reverse(),
        has_more: false,
        response_metadata: {next_cursor: ''},
      });
    assert.equal(bot, true);
    assert.equal(params.channel, 'DFIXTURE');
    if (method === 'chat.postMessage') {
      const message = {
        channel: params.channel,
        ts: timestamp(),
        text: params.text,
        user: 'UBOT',
        ...(params.thread_ts ? {thread_ts: params.thread_ts} : {}),
      };
      messages.push(message);
      return Response.json({
        ok: true,
        channel: message.channel,
        ts: message.ts,
      });
    }
    if (method === 'chat.update') {
      const message = messages.find(
        m => m.channel === params.channel && m.ts === params.ts,
      );
      assert.ok(message);
      message.text = params.text;
      return Response.json({
        ok: true,
        channel: message.channel,
        ts: message.ts,
      });
    }
    throw Error(`Unimplemented synthetic Slack method ${method}`);
  }
  if (url.origin === 'https://grafana.britecorepro.com')
    throw Error('Live telemetry forbidden');
  return realFetch(input, options);
};
// Observe SDK model calls across both SSE and WebSocket without changing the transport.
// Lifetimes include request/auth preparation; they are not network-only latency measurements.
const originalStream = ModelRuntime.prototype.streamSimple;
ModelRuntime.prototype.streamSimple = function (model, context, options) {
  const body = JSON.stringify(context.messages);
  if (!body.includes('new_information'))
    return originalStream.call(this, model, context, options);
  const own = fixtures.filter(f => f.id && body.includes(f.id));
  assert.equal(
    own.length,
    1,
    'Each worker model call contains exactly one fixture task identity',
  );
  const id = own[0].id;
  assert.equal(
    activeTasks.has(id),
    false,
    'No simultaneous model calls in one session',
  );
  activeTasks.add(id);
  maximum = Math.max(maximum, ++active);
  const request = {phase, task_id: id, started_at: new Date().toISOString()};
  requests.push(request);
  const finish = () => {
    active--;
    activeTasks.delete(id);
    request.finished_at = new Date().toISOString();
  };
  try {
    const stream = originalStream.call(this, model, context, options);
    void stream.result().then(finish, finish);
    return stream;
  } catch (error) {
    finish();
    throw error;
  }
};
let store;
let autoTrial;
let failure;
const signal = AbortSignal.timeout(300000);
try {
  store = await TaskStore.acquire(root);
  if (automatic)
    autoTrial = await AutoTrial.open(
      store,
      3,
      300,
      'DFIXTURE',
      discovery,
      excludedFile,
    );
  const addCandidate = async (source, text) =>
    saveReceipt(store, {
      schema_version: 1,
      id: digest(sourceKey(source)),
      source,
      kind: 'mention',
      author_id: 'UOWNER',
      text,
      content_hash: digest(JSON.stringify({text, author: 'UOWNER'})),
      content_source: 'search',
      candidate_task_ids: [],
      disposition: 'pending',
      received_at: new Date().toISOString(),
    });
  for (const fixture of fixtures) {
    const source = {
      workspace_id: 'TFIXTURE',
      channel_id: `C${fixture.name.toUpperCase()}`,
      message_ts: timestamp(),
    };
    const request = `${automatic ? '<@UOWNER> ' : ''}Project ${fixture.name}, reference ${fixture.marker}. ${fixture.request} These are synthetic test facts. The missing choice is an owner decision, not a fact to guess. When the owner replies, write result.md using that choice and this reference, give a short inline answer without a file reference, and leave the task in review. Do not perform external actions.`;
    messages.push({
      channel: source.channel_id,
      ts: source.message_ts,
      user: 'UOWNER',
      text: request,
    });
    if (automatic) {
      await addCandidate(source, request);
      fixture.id = `task-${digest(sourceKey(source)).slice(0, 32)}`;
    } else {
      const created = await store.enqueue({
        request,
        outcome:
          'One isolated local draft after the owner supplies the missing decision.',
        sources: [source],
        inbox,
      });
      fixture.id = created.item.task.id;
    }
  }
  if (automatic)
    await addCandidate(
      {
        workspace_id: 'TFIXTURE',
        channel_id: 'COVERFLOW',
        message_ts: `${Math.floor(Date.now() / 1000) - 100}.000001`,
      },
      '<@UOWNER> Draft a separate note for Project Overflow. No external actions.',
    );
  for (phase = 0; phase < 3; phase++) {
    // Fresh store/session handles each cycle, as after a clean coordinator restart.
    if (automatic)
      autoTrial = await AutoTrial.open(
        store,
        3,
        300,
        'DFIXTURE',
        discovery,
        excludedFile,
      );
    await recoverRuns(store);
    const client = new ReadonlySlackClient(
      tokens,
      path.join(root, 'runs/slack/cooldowns.json'),
    );
    const messenger = new TaskMessenger(store, tokens, true);
    assert.equal(
      (await pollIntake(store, client, 'DFIXTURE', signal, true)).status,
      'passed',
    );
    const scope = (await store.list()).map(item => item.task);
    const triage = await classifyPending(
      store,
      config,
      signal,
      automatic ? undefined : scope,
      autoTrial,
    );
    assert.equal(triage.blocked, 0);
    const batch = await runTaskBatch(store, config, signal, {
      workers: 2,
      taskIds: fixtures.map(fixture => fixture.id),
      communication: messenger,
      sourceClient: client,
      onSettled: async result => {
        const item = await store.locate(result.task_id);
        await messenger.sync(item.task.id);
        const answer = await taskPublication(store, item.task);
        if (answer)
          await messenger.reply(
            item.task.id,
            answer.text,
            answer.needsResponse,
            answer.key,
          );
      },
    });
    const tasks = await store.list();
    assert.equal(tasks.length, 3);
    assert.ok(batch.every(result => !result.error));
    const journals = await Promise.all(
      tasks.map(async item => ({
        task_id: item.task.id,
        run: JSON.parse(
          await readFile(
            path.join(root, 'runs', item.task.id + '.json'),
            'utf8',
          ),
        ),
      })),
    );
    cycles.push({
      phase,
      triage,
      batch,
      tasks,
      journals,
      message_count: messages.length,
    });
    if (phase === 0) {
      assert.equal(batch.length, 3);
      assert.ok(tasks.every(item => item.status === 'waiting'));
      for (const fixture of fixtures) {
        const item = tasks.find(item => item.task.id === fixture.id);
        messages.push({
          channel: 'DFIXTURE',
          ts: timestamp(),
          thread_ts: item.task.slack.parent_ts,
          user: 'UOWNER',
          text: fixture.answer,
        });
      }
    } else if (phase === 1) {
      assert.equal(batch.length, 3);
      assert.ok(tasks.every(item => item.status === 'review'));
    } else {
      assert.deepEqual(batch, []);
      assert.equal(messages.length, cycles[1].message_count);
    }
    await store.close();
    store = await TaskStore.acquire(root);
  }
  if (automatic) {
    checks.total_admission_cap =
      autoTrial.ids.length === 3 &&
      (await receipts(store)).find(r => r.text.includes('Project Overflow'))
        ?.disposition === 'pending';
    autoTrial = await AutoTrial.open(
      store,
      3,
      300,
      'DFIXTURE',
      discovery,
      excludedFile,
    );
    await autoTrial.close();
  }
  checks.two_active_model_calls = maximum === 2 && active === 0;
  checks.separate_sessions =
    new Set(cycles[1].tasks.map(item => item.task.session.id)).size === 3;
  checks.same_sessions_after_reopen = fixtures.every(
    f =>
      JSON.stringify(
        cycles[0].tasks.find(t => t.task.id === f.id).task.session,
      ) ===
      JSON.stringify(
        cycles[1].tasks.find(t => t.task.id === f.id).task.session,
      ),
  );
  const ownerReplies = (await receipts(store)).filter(
    r => r.kind === 'task_reply' && r.author_id === 'UOWNER',
  );
  checks.correct_owner_routing =
    ownerReplies.length === 3 &&
    ownerReplies.every(
      r =>
        r.disposition === 'routed' &&
        fixtures.some(f => f.id === r.task_id && f.answer === r.text),
    );
  for (const fixture of fixtures) {
    const item = await store.locate(fixture.id);
    const draft = await readFile(
      path.join(item.directory, 'artifacts/result.md'),
      'utf8',
    );
    const session = await readFile(item.task.session.file, 'utf8');
    fixture.draft = draft;
    checks[fixture.name + '_facts_and_isolation'] =
      draft.includes(fixture.marker) &&
      fixture.facts.every(fact => draft.includes(fact)) &&
      fixtures
        .filter(f => f.id !== fixture.id)
        .every(f => !session.includes(f.marker) && !draft.includes(f.marker));
    const thread = messages.filter(
      m => m.user === 'UBOT' && m.thread_ts === item.task.slack.parent_ts,
    );
    checks[fixture.name + '_question_and_answer_only'] =
      thread.length === 2 && thread[0].text.startsWith('<@UOWNER> ');
    fixture.replies = thread.map(m => m.text);
  }
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 2;
} finally {
  await store?.close();
  globalThis.fetch = realFetch;
  ModelRuntime.prototype.streamSimple = originalStream;
  const runtime_files = {};
  await mkdir(path.join(directory, 'runtime'));
  for (const name of [
    'worker',
    'auto-trial',
    'worker-pool',
    'store',
    'serve',
    'task-slack',
  ]) {
    const bytes = await readFile(path.join(pkg, 'dist', name + '.js'));
    runtime_files[name] = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(directory, 'runtime', name + '.js'), bytes, {
      mode: 0o600,
    });
  }
  const report = {
    checked_at: new Date().toISOString(),
    directory,
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
    automatic,
    runtime_files,
    checks,
    failure,
    maximum_concurrent_model_calls: maximum,
    measurement:
      'SDK model-call start through final result, including request/auth preparation; native transport unchanged.',
    requests,
    fixtures,
    cycles,
    messages,
    result: failure ? 'failed' : 'requires_source_based_answer_review',
    limitations:
      'Real provider with synthetic task facts, owner replies and Slack transport. Not live Slack acceptance, multi-site telemetry proof or permission to restart a real runner.',
  };
  await writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    {mode: 0o600},
  );
  await writeFile(
    path.join(directory, 'runtime.patch'),
    execFileSync('git', ['diff', '--', 'task-assistant/src/'], {
      cwd: path.resolve(pkg, '..'),
      encoding: 'utf8',
    }),
    {mode: 0o600},
  );
  console.log(
    JSON.stringify({
      directory,
      result: report.result,
      failure,
      checks,
      maximum_concurrent_model_calls: maximum,
      replies: fixtures.map(f => ({project: f.name, replies: f.replies})),
    }),
  );
}
