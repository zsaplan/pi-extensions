import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {TaskStore, atomicJson, digest} from '../dist/store.js';
import {TaskGithubResearch} from '../dist/github-research.js';
import {runNextTask, taskPublication} from '../dist/worker.js';
import {TaskMessenger} from '../dist/task-slack.js';
import {VERSION} from '@earendil-works/pi-coding-agent';

process.umask(0o077);
const artifact = process.argv[2],
  source = process.env.TASK_RESEARCH_PACKAGE;
assert.ok(source);
assert.equal(VERSION, '1.1.0');
const snapshot = path.join(artifact, 'researcher');
await mkdir(snapshot);
await cp(path.join(source, 'dist'), path.join(snapshot, 'dist'), {
  recursive: true,
});
await cp(path.join(source, 'profiles'), path.join(snapshot, 'profiles'), {
  recursive: true,
});
await cp(
  path.join(source, 'package.json'),
  path.join(snapshot, 'package.json'),
);
const dependencyModules = createRequire(path.join(source, 'package.json'))
  .resolve.paths('@earendil-works/pi-coding-agent')
  .find(dir =>
    existsSync(path.join(dir, '@earendil-works/pi-coding-agent/package.json')),
  );
assert.ok(dependencyModules);
assert.equal(
  JSON.parse(
    await readFile(
      path.join(
        dependencyModules,
        '@earendil-works/pi-coding-agent/package.json',
      ),
      'utf8',
    ),
  ).version,
  '0.99.2',
);
await symlink(dependencyModules, path.join(snapshot, 'node_modules'));
const dependencyLock = path.resolve(source, '../package-lock.json');
const req = createRequire(path.join(source, 'package.json'));
const {WebSocket, WebSocketServer} = req('ws');
const profile = await import(
  pathToFileURL(path.join(snapshot, 'dist/profiles.js')).href
);
const profileDigest = (
  await profile.loadProfile('github-researcher', false, true)
).digest;
const files = {
  'package.json': digest(
    await readFile(path.join(snapshot, 'package.json'), 'utf8'),
  ),
};
async function inventory(dir, prefix) {
  for (const name of await readdir(dir)) {
    const target = path.join(dir, name),
      relative = prefix + '/' + name;
    if ((await stat(target)).isDirectory()) await inventory(target, relative);
    else if (!name.endsWith('.tsbuildinfo'))
      files[relative] = digest(await readFile(target, 'utf8'));
  }
}
await inventory(path.join(snapshot, 'dist'), 'dist');
await inventory(path.join(snapshot, 'profiles'), 'profiles');
const root = path.join(artifact, 'state'),
  agent = path.join(artifact, 'agent');
await mkdir(agent);
const token =
  'fixture.' +
  Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {chatgpt_account_id: 'fixture'},
    }),
  ).toString('base64url') +
  '.fixture';
const auth = path.join(agent, 'auth.json');
await atomicJson(auth, {
  'openai-codex': {
    type: 'oauth',
    access: token,
    refresh: 'fixture',
    expires: Date.now() + 3600000,
  },
});
const configFile = path.join(artifact, 'research.json');
await atomicJson(configFile, {
  schema_version: 1,
  root,
  package_dir: snapshot,
  profile_digest: profileDigest,
  files,
  dependency_lock: {
    file: dependencyLock,
    hash: digest(await readFile(dependencyLock, 'utf8')),
  },
  auth_path: auth,
});

let scenario = 'happy',
  requests = 0,
  github = 0,
  connections = 0,
  liveSockets = 0,
  peakSockets = 0,
  childFailure;
let controller;
const deliveries = [],
  checks = [],
  frames = [],
  parentPayloads = [];
const rawBody = 'setting: example\n';
const blob = createHash('sha1')
  .update(`blob ${Buffer.byteLength(rawBody)}\0`)
  .update(rawBody)
  .digest('hex');
const nativeFetch = globalThis.fetch,
  nativeSocket = globalThis.WebSocket;
const server = createServer(async (request, response) => {
  try {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text),
      history = body.messages;
    parentPayloads.push(body);
    assert.ok(body.tools.some(t => t.function.name === 'github_research_run'));
    assert.ok(body.tools.some(t => t.function.name === 'github_research_read'));
    assert.ok(!body.tools.some(t => t.function.name === 'bash'));
    const lastUser = history.findLastIndex(m => m.role === 'user');
    const current = history.slice(lastUser + 1),
      results = current.filter(m => m.role === 'tool');
    let call;
    if (scenario === 'happy' && !results.length) {
      call = {
        name: 'github_research_read',
        arguments: JSON.stringify({
          operation: 'file',
          repository: 'fixture/research',
          path: 'README.md',
        }),
      };
    } else if (
      !results.length ||
      (scenario === 'happy' && results.length <= 2)
    ) {
      if (scenario === 'happy' && results.length === 1)
        assert.match(
          results[0].content,
          /No active GitHub research assignment/,
        );
      call = {
        name: 'github_research_run',
        arguments: JSON.stringify({
          task: 'Inspect fixture/research README.md. What setting is configured? Configuration alone does not prove runtime success.',
        }),
      };
    } else if (
      !results.some(r => r.name === 'finish_task') &&
      !current.some(m =>
        m.tool_calls?.some(t => t.function.name === 'finish_task'),
      )
    ) {
      const text = results.at(-1).content;
      if (!['cancel', 'restart-admitted'].includes(scenario)) {
        const value = JSON.parse(text.slice(text.indexOf('{')));
        assert.equal(value.referenceValidation.status, 'valid');
        assert.equal(value.sourceEvidence.records.length, 1);
        assert.equal(value.status, 'completed');
        assert.match(
          value.output,
          /github.com\/fixture\/research\/blob\/a{40}\/README.md/,
        );
        assert.match(
          value.sourceEvidence.records[0].content[0].text,
          /setting: example/,
        );
      }
      if (scenario === 'restart-admitted')
        assert.match(text, /research_already_admitted_no_retry/);
      call = {
        name: 'finish_task',
        arguments: JSON.stringify(
          scenario === 'restart-admitted'
            ? {
                status: 'waiting',
                summary: 'Interrupted research remains unresolved.',
                next_action: 'Review the recorded interruption.',
                question: null,
                reply:
                  'The research was interrupted. I have not repeated it or verified the repository finding.',
              }
            : {
                status: 'review',
                summary: 'Configuration found; runtime remains unverified.',
                next_action: 'Review the configuration finding.',
                question: null,
                reply:
                  'The repository configures setting: example. This is configuration evidence, not proof of runtime success. https://github.com/fixture/research/blob/' +
                  'a'.repeat(40) +
                  '/README.md',
              },
        ),
      };
    }
    const delta = call
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_' + requests++,
              type: 'function',
              function: call,
            },
          ],
        }
      : {role: 'assistant', content: 'Finished.'};
    response.writeHead(200, {'Content-Type': 'text/event-stream'});
    response.write(
      `data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason: null}]})}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}})}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  } catch (error) {
    childFailure = error;
    response.destroy(error);
  }
});
const wsServer = new WebSocketServer({server});
wsServer.on('connection', socket => {
  connections++;
  liveSockets++;
  peakSockets = Math.max(peakSockets, liveSockets);
  socket.on('close', () => liveSockets--);
  let turns = 0;
  socket.on('message', async data => {
    try {
      const request = JSON.parse(data);
      frames.push(request);
      assert.equal(request.model, 'gpt-6-luna');
      assert.equal(request.service_tier, 'default');
      assert.equal(request.reasoning.effort, 'high');
      assert.equal(request.tools.length, 7);
      if (scenario === 'cancel') {
        setTimeout(() => controller.abort(), 20);
        return;
      }
      if (scenario === 'concurrent')
        await new Promise(resolve => setTimeout(resolve, 50));
      const observed = request.input
        .filter(i => i.type === 'function_call_output')
        .map(i => {
          try {
            return JSON.parse(i.output);
          } catch {
            return {};
          }
        })
        .find(i => i.sourceId);
      const id = 'item_' + turns;
      const action = turns++ === 0;
      const text =
        'Observed setting: example. Runtime is unverified.' +
        (observed ? ` [[${observed.sourceId}]]` : '');
      const item = action
        ? {
            type: 'function_call',
            id,
            call_id: id,
            name: 'github_file',
            arguments: JSON.stringify({
              repository: 'fixture/research',
              path: 'README.md',
              limit: 20,
            }),
          }
        : {
            type: 'message',
            id,
            role: 'assistant',
            status: 'completed',
            content: [{type: 'output_text', text, annotations: []}],
          };
      const events = [
        {
          type: 'response.created',
          response: {id: 'response_' + turns, status: 'in_progress'},
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: action ? {...item, arguments: ''} : {...item, content: []},
        },
        ...(action
          ? [
              {
                type: 'response.function_call_arguments.delta',
                item_id: id,
                output_index: 0,
                delta: item.arguments,
              },
              {
                type: 'response.function_call_arguments.done',
                item_id: id,
                output_index: 0,
                arguments: item.arguments,
              },
            ]
          : [
              {
                type: 'response.content_part.added',
                item_id: id,
                output_index: 0,
                content_index: 0,
                part: {type: 'output_text', text: '', annotations: []},
              },
              {
                type: 'response.output_text.delta',
                item_id: id,
                output_index: 0,
                content_index: 0,
                delta: text,
              },
            ]),
        {type: 'response.output_item.done', output_index: 0, item},
        {
          type: 'response.completed',
          response: {
            id: 'response_' + turns,
            status: 'completed',
            model: 'gpt-6-luna',
            service_tier: 'default',
            output: [item],
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              total_tokens: 30,
              input_tokens_details: {cached_tokens: 0},
            },
          },
        },
      ];
      for (const event of events) socket.send(JSON.stringify(event));
    } catch (error) {
      childFailure = error;
      socket.terminate();
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
globalThis.WebSocket = class extends WebSocket {
  constructor(url, options) {
    assert.equal(String(url), 'wss://chatgpt.com/backend-api/codex/responses');
    super(origin.replace('http:', 'ws:'), options);
  }
};
globalThis.fetch = async (url, options) => {
  const target = new URL(String(url));
  if (target.origin === origin) return nativeFetch(url, options);
  if (target.origin === 'https://slack.com') {
    const params = Object.fromEntries(new URLSearchParams(options.body));
    const method = target.pathname.split('/').at(-1);
    let value;
    if (method === 'auth.test')
      value = {
        team_id: 'TONE',
        user_id: 'UBOT',
        url: 'https://fixture.slack.com/',
      };
    else if (method === 'conversations.info')
      value = {channel: {id: 'DASSIST', is_im: true, user: 'UOWNER'}};
    else if (method === 'chat.postMessage' || method === 'chat.update') {
      deliveries.push({method, ...params});
      value = {channel: params.channel, ts: params.ts ?? '1700000005.000001'};
    } else if (method === 'users.info')
      value = {user: {id: params.user, real_name: params.user}};
    else if (method === 'chat.getPermalink')
      value = {
        permalink:
          'https://fixture.slack.com/archives/CSOURCE/p1700000000000001',
      };
    else throw Error('Unexpected Slack fixture call: ' + method);
    return new Response(JSON.stringify({ok: true, ...value}));
  }
  assert.equal(target.origin, 'https://api.github.com');
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.Authorization, 'Bearer fixture-token');
  github++;
  const endpoint = target.pathname.replace('/repos/fixture/research/', '');
  const value =
    endpoint === 'commits'
      ? [
          {
            sha: 'a'.repeat(40),
            parents: [],
            commit: {
              tree: {sha: 'b'.repeat(40)},
              message: 'Fixture',
              committer: {date: '2026-01-01T00:00:00Z'},
            },
          },
        ]
      : endpoint.startsWith('git/commits/')
        ? {sha: 'a'.repeat(40), parents: [], tree: {sha: 'b'.repeat(40)}}
        : endpoint.startsWith('git/trees/')
          ? {
              sha: 'b'.repeat(40),
              truncated: false,
              tree: [
                {
                  path: 'README.md',
                  type: 'blob',
                  mode: '100644',
                  sha: blob,
                  size: Buffer.byteLength(rawBody),
                },
              ],
            }
          : endpoint === 'git/blobs/' + blob
            ? {
                sha: blob,
                encoding: 'base64',
                size: Buffer.byteLength(rawBody),
                content: Buffer.from(rawBody).toString('base64'),
              }
            : undefined;
  assert.ok(value, endpoint);
  return new Response(JSON.stringify(value));
};
await atomicJson(path.join(agent, 'models.json'), {
  providers: {
    fixture: {
      baseUrl: origin + '/v1',
      api: 'openai-completions',
      apiKey: 'fixture-key',
      models: [
        {
          id: 'fixture-model',
          name: 'Fixture',
          reasoning: false,
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          compat: {supportsDeveloperRole: false},
        },
      ],
    },
  },
});
let store;
let passed = false;
try {
  store = await TaskStore.acquire(root);
  let research = await TaskGithubResearch.open(store, configFile);
  const config = () => ({
    provider: 'fixture',
    model: 'fixture-model',
    agentDir: agent,
    githubResearch: research,
  });
  let seq = 0;
  async function enqueue(published = true) {
    const item = (
      await store.enqueue({
        request: 'Research fixture/research configuration.',
        outcome: 'Explain observed configuration and limits.',
        sources: [
          {
            workspace_id: 'TONE',
            channel_id: 'CSOURCE',
            message_ts: `1700000000.${String(++seq).padStart(6, '0')}`,
          },
        ],
        inbox: {
          workspace_id: 'TONE',
          channel_id: 'DASSIST',
          owner_user_id: 'UOWNER',
          bot_user_id: 'UBOT',
        },
      })
    ).item;
    if (published)
      item.task.slack.parent_ts = `1700000001.${String(seq).padStart(6, '0')}`;
    await store.save(item.task);
    return item.task;
  }
  const task = await enqueue(false);
  assert.equal(task.slack.parent_ts, null);
  const messenger = new TaskMessenger(
    store,
    {user: 'fixture-user', bot: 'fixture-bot'},
    true,
  );
  const exactReservation = 'fixture-existing-reservation';
  let reservations = 0;
  // The real ledger is covered by the coordinator E2E suite. Here verify that
  // the exact callback identity, not a guessed latest entry, reaches the child.
  const reservationFixture = {
    backlog: {
      reservations: [
        {kind: 'investigation', reference: task.id, id: 'not-this-reservation'},
      ],
    },
    async reserveModel(kind, reference, onReserved) {
      assert.equal(kind, 'investigation');
      assert.equal(reference, task.id);
      reservations++;
      onReserved(exactReservation);
      return true;
    },
  };
  let result = await runNextTask(
    store,
    config(),
    new AbortController().signal,
    messenger,
    undefined,
    undefined,
    undefined,
    task.id,
    reservationFixture,
  );
  if (childFailure) throw childFailure;
  assert.equal(result.status, 'review', JSON.stringify(result));
  assert.equal(connections, 1);
  assert.equal(frames.length, 2);
  assert.equal(liveSockets, 0);
  const savedTask = (await store.locate(task.id)).task;
  assert.ok(savedTask.slack.parent_ts);
  task.slack = savedTask.slack;
  assert.equal(
    deliveries.filter(d => d.method === 'chat.postMessage' && !d.thread_ts)
      .length,
    1,
  );
  checks.push('new task gets its durable Slack parent before research setup');
  const publication = await taskPublication(store, savedTask);
  await messenger.reply(task.id, publication.text, false, publication.key);
  await messenger.reply(task.id, publication.text, false, publication.key);
  assert.equal(
    deliveries.filter(d => d.method === 'chat.postMessage').length,
    2,
  );
  assert.equal(
    deliveries.find(d => d.method === 'chat.postMessage' && d.thread_ts)
      .thread_ts,
    task.slack.parent_ts,
  );
  checks.push(
    'actual SDK versions, native transport, nested adapter evidence, citations, duplicate-call cache, exact-thread idempotent publication',
  );
  const recordDir = path.join(root, 'runs/github-research', task.id);
  const admissionName = (await readdir(recordDir)).find(
    n => n.endsWith('.json') && !n.endsWith('-result.json'),
  );
  const admission = JSON.parse(
    await readFile(path.join(recordDir, admissionName), 'utf8'),
  );
  assert.equal(admission.binding.sessionId, result.session_id);
  assert.equal(
    admission.binding.threadKey,
    `TONE:DASSIST:${task.slack.parent_ts}`,
  );
  assert.equal(admission.binding.reservationId, exactReservation);
  assert.equal(reservations, 1);
  const saved = JSON.parse(
    await readFile(
      path.join(recordDir, admissionName.replace('.json', '-result.json')),
      'utf8',
    ),
  );
  assert.equal(saved.details.research.cleanupComplete, true);
  checks.push('binding and original result persistence');
  await store.move(task.id, 'queued');
  await store.close();
  store = await TaskStore.acquire(root);
  research = await TaskGithubResearch.open(store, configFile);
  scenario = 'restart';
  result = await runNextTask(
    store,
    config(),
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    task.id,
  );
  if (childFailure) throw childFailure;
  assert.equal(result.status, 'review');
  assert.equal(connections, 1);
  assert.equal(result.session_id, savedTask.session.id);
  const messages = (await readFile(savedTask.session.file, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .map(r => r.message)
    .filter(m => m?.toolName === 'github_research_run');
  assert.equal(messages.filter(m => m.usage).length, 1);
  assert.equal(messages[0].usage.totalTokens, 60);
  assert.ok(messages.slice(1).every(m => m.nestedCalls === undefined));
  checks.push(
    'restart reuses result in exact session without a new child or duplicate child usage',
  );
  await assert.rejects(
    TaskGithubResearch.open(store),
    /research_config_required/,
  );
  const absentToken = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  await assert.rejects(
    TaskGithubResearch.open(store, configFile),
    /research_credentials_unavailable/,
  );
  process.env.GH_TOKEN = absentToken;
  const snapshotFile = path.join(snapshot, 'dist/github-research.js');
  const original = await readFile(snapshotFile, 'utf8');
  await writeFile(snapshotFile, original + '\n// altered fixture\n');
  await assert.rejects(
    TaskGithubResearch.open(store, configFile),
    /research_package_changed/,
  );
  await writeFile(snapshotFile, original);
  checks.push(
    'omitted capability, missing credentials and altered snapshot fail closed',
  );
  const ownerReceipt = {
    schema_version: 1,
    id: digest('owner-context-fixture'),
    source: {
      workspace_id: 'TONE',
      channel_id: 'DASSIST',
      message_ts: '1700000100.000001',
      thread_ts: task.slack.parent_ts,
    },
    kind: 'task_reply',
    author_id: 'UBOT',
    content_source: 'conversation',
    text: 'Please inspect the updated repository setting.',
    content_hash: digest('updated-setting'),
    candidate_task_ids: [task.id],
    task_id: task.id,
    disposition: 'routed',
    received_at: new Date().toISOString(),
  };
  const receiptFile = path.join(
    root,
    'intake/receipts',
    ownerReceipt.id + '.json',
  );
  await atomicJson(receiptFile, ownerReceipt);
  await store.move(task.id, 'queued');
  result = await runNextTask(
    store,
    config(),
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    task.id,
  );
  if (childFailure) throw childFailure;
  assert.equal(result.status, 'review');
  assert.equal(connections, 1);
  await atomicJson(receiptFile, {...ownerReceipt, author_id: 'UOWNER'});
  await store.move(task.id, 'queued');
  result = await runNextTask(
    store,
    config(),
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    task.id,
  );
  if (childFailure) throw childFailure;
  assert.equal(result.status, 'review');
  assert.equal(connections, 2);
  assert.equal(result.session_id, savedTask.session.id);
  checks.push(
    'reviewer input does not renew research; canonical owner task-thread input does',
  );
  scenario = 'concurrent';
  const a = await enqueue(),
    b = await enqueue();
  const concurrent = await Promise.all(
    [a, b].map(t =>
      runNextTask(
        store,
        config(),
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        undefined,
        t.id,
      ),
    ),
  );
  if (childFailure) throw childFailure;
  assert.ok(
    concurrent.every(r => r.status === 'review'),
    JSON.stringify(concurrent),
  );
  assert.equal(peakSockets, 1);
  assert.equal(connections, 4);
  checks.push(
    'two existing workers serialize the one native researcher without another pool',
  );
  const taskForDeadline = await enqueue();
  const active = await store.claimQueued(taskForDeadline.id);
  active.task.session.id = savedTask.session.id;
  const limited = research.forTask(
    active.task,
    [],
    Date.now() + 1000,
    active.task.claim_id,
  );
  let guarded;
  limited.factory({
    registerTool(tool) {
      if (tool.name === 'github_research_run') guarded = tool;
    },
    on() {},
  });
  await assert.rejects(
    guarded.execute(
      'deadline',
      {task: 'Inspect fixture/research.'},
      new AbortController().signal,
      undefined,
      {sessionManager: {getSessionId: () => savedTask.session.id}},
    ),
    /research_deadline_exhausted/,
  );
  assert.equal(connections, 4);
  checks.push('insufficient inherited deadline refuses before admission');
  scenario = 'cancel';
  controller = new AbortController();
  const cancelled = await enqueue();
  const stopped = await runNextTask(
    store,
    config(),
    controller.signal,
    undefined,
    undefined,
    undefined,
    undefined,
    cancelled.id,
  );
  assert.equal(stopped.error, 'cancelled');
  assert.equal(liveSockets, 0);
  checks.push('cancellation settles child and socket before worker returns');
  const cancelledDir = path.join(root, 'runs/github-research', cancelled.id);
  const cancelledName = (await readdir(cancelledDir)).find(
    n => n.endsWith('.json') && !n.endsWith('-result.json'),
  );
  const cancelledPath = path.join(cancelledDir, cancelledName);
  const cancelledAdmission = JSON.parse(await readFile(cancelledPath, 'utf8'));
  await atomicJson(
    path.join(artifact, 'cancelled-before-fault.json'),
    cancelledAdmission,
  );
  // Inject the actual crash window after durable admission but before result settlement.
  await atomicJson(cancelledPath, {...cancelledAdmission, state: 'admitted'});
  const priorConnections = connections;
  await store.close();
  store = await TaskStore.acquire(root);
  research = await TaskGithubResearch.open(store, configFile);
  scenario = 'restart-admitted';
  const held = await runNextTask(
    store,
    config(),
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    cancelled.id,
  );
  if (childFailure) throw childFailure;
  assert.equal(held.status, 'waiting');
  assert.equal(connections, priorConnections);
  assert.equal(held.session_id, stopped.session_id);
  checks.push(
    'persisted unfinished admission survives restart without a second invocation',
  );
  passed = true;
} finally {
  await writeFile(
    path.join(artifact, 'report.json'),
    JSON.stringify(
      {
        passed,
        checks,
        versions: {worker: VERSION, child: '0.99.2'},
        connections,
        peakSockets,
        frames: frames.length,
        github,
        deliveries,
        childFailure: childFailure?.stack,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(artifact, 'parent-requests.json'),
    JSON.stringify(parentPayloads),
  );
  await writeFile(
    path.join(artifact, 'child-requests.json'),
    JSON.stringify(frames),
  );
  await store?.close();
  globalThis.fetch = nativeFetch;
  globalThis.WebSocket = nativeSocket;
  for (const socket of wsServer.clients) socket.terminate();
  await new Promise(resolve => wsServer.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
