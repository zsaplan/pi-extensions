// Repeatable local end-to-end replay; add --provider for real-model/source-review evidence.
// Synthetic Slack, sessions and task root only. No live Slack or operational systems.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskStore, digest, sourceKey} from '../dist/store.js';
import {AutoTrial} from '../dist/auto-trial.js';
import {ReadonlySlackClient} from '../dist/slack.js';
import {pollIntake, receipts, saveReceipt} from '../dist/intake.js';
import {
  classifyPending,
  recoverRuns,
  runNextTask,
  taskPublication,
} from '../dist/worker.js';
import {TaskMessenger} from '../dist/task-slack.js';
import {
  OwnerReferences,
  requireSessionLibrary,
} from '../dist/owner-references.js';
const pkg = fileURLToPath(new URL('..', import.meta.url));
await fs.mkdir(path.join(pkg, 'tmp/owner-references'), {recursive: true});
const directory = await fs.mkdtemp(
  path.join(pkg, 'tmp/owner-references/replay-'),
);
const root = path.join(directory, 'state'),
  library = path.join(directory, 'library'),
  agent = path.join(directory, 'agent');
await fs.mkdir(library);
await fs.mkdir(agent);
const provider = process.argv.includes('--provider');
const config = {
  provider: provider ? 'openai-codex' : 'fixture',
  model: provider ? 'gpt-6.1-sol' : 'fixture',
  sessionLibrary: library,
  ...(provider ? {} : {agentDir: agent}),
};
await fs.writeFile(
  path.join(agent, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: 'https://fixture.invalid/v1',
        api: 'openai-completions',
        apiKey: 'fixture-key',
        models: [
          {
            id: 'fixture',
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
  }),
);
const guid = '11111111-2222-7333-8444-555555555555';
const sessionFile = path.join(
  library,
  `2026-10-13T00-00-00-000Z_${guid}.jsonl`,
);
const at = '2026-10-13T00:00:00.000Z';
const entry = (id, parentId, more) => ({id, parentId, timestamp: at, ...more});
const sourceSession =
  [
    {
      type: 'session',
      version: 3,
      id: guid,
      timestamp: at,
      cwd: '/not-an-allowed-source',
    },
    entry('root', null, {
      type: 'message',
      message: {
        role: 'user',
        content: 'Review the TEMP-policy behavior.',
        timestamp: 1,
      },
    }),
    entry('abandoned', 'root', {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'ABANDONED_BRANCH: production recovery verified.',
          },
        ],
        timestamp: 2,
      },
    }),
    entry('kept', 'root', {
      type: 'message',
      message: {
        role: 'user',
        content: 'Review complete; no external work was requested.',
        timestamp: 3,
      },
    }),
    entry('compact', 'kept', {
      type: 'compaction',
      firstKeptEntryId: 'kept',
      tokensBefore: 100,
      summary:
        'REVIEW8428: Review completed. A rebuild can temporarily empty lists; recurrence/root cause are not established. No rebuild was executed.',
    }),
    entry('final', 'compact', {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Review completed, not a production-recovery check. Contact customer@example.com. token=SECRET_SHOULD_BE_REDACTED',
          },
          {type: 'thinking', thinking: 'PRIVATE_REASONING_MUST_NOT_APPEAR'},
        ],
        timestamp: 4,
      },
    }),
    entry('private', 'final', {
      type: 'custom',
      customType: 'credentials',
      data: {secret: 'PRIVATE_STATE_MUST_NOT_APPEAR'},
    }),
  ]
    .map(x => JSON.stringify(x))
    .join('\n') + '\n';
await fs.writeFile(sessionFile, sourceSession);
await fs.writeFile(
  path.join(library, 'unrelated_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
  'UNRELATED_BODY_MUST_NOT_BE_READ',
);
const initialHash = digest(sourceSession),
  libraryReads = [];
const originalOpen = fs.open,
  originalRead = fs.readFile;
let observing = false;
const guard = file => {
  if (observing && String(file).startsWith(library + path.sep)) {
    assert.equal(
      String(file),
      sessionFile,
      'Only the exact owner-selected session body may be read',
    );
    libraryReads.push(String(file));
  }
};
fs.open = async (file, ...args) => {
  guard(file);
  return originalOpen(file, ...args);
};
fs.readFile = async (file, ...args) => {
  guard(file);
  return originalRead(file, ...args);
};
syncBuiltinESMExports();
const inbox = {
  workspace_id: 'TFIXTURE',
  channel_id: 'DFIXTURE',
  owner_user_id: 'UOWNER',
  bot_user_id: 'UBOT',
};
const discovery = {mentionGroup: 'SOPS', watchChannel: 'CBASE'},
  tokens = {user: 'fixture-user', bot: 'fixture-bot'};
const excluded = path.join(directory, 'excluded.json');
await fs.writeFile(excluded, '[]');
let sequence = 0,
  phase = 0,
  modelCalls = 0;
const timestamp = () =>
  `${Math.floor(Date.now() / 1000) - 1}.${String(++sequence).padStart(6, '0')}`;
const base = timestamp(),
  research = '1760000000.000001';
const link = `https://fixture.slack.com/archives/CRESEARCH/p${research.replace('.', '')}`;
const forbidden =
  'https://fixture.slack.com/archives/CFORBIDDEN/p1760000000000002';
const request =
  '<@UOWNER> Review the Elasticsearch rebuild/TEMP-policy concern. Use the research I will supply. If it is missing, ask for it. Read-only analysis; no production actions.';
const messages = [{channel: 'CBASE', ts: base, text: request, user: 'UOTHER'}];
const researchRows = Array.from({length: 12}, (_, i) => ({
  channel: 'CRESEARCH',
  ts: i ? `1760000000.${String(i + 1).padStart(6, '0')}` : research,
  thread_ts: research,
  user: 'URESEARCH',
  text:
    i === 11
      ? 'RESEARCH614: TEMP policies disappeared after rebuilding. Lists can be temporarily empty while rebuilding; recurrence and root cause are unverified.'
      : i === 0
        ? `Research continues below. Do not infer success. ${forbidden} token=xoxb-redact-this-secret`
        : 'Research context; decisive findings are at the end.',
}));
const coordinatorReplyTs = new Set();
const inboxReview = {
  channel: 'DFIXTURE',
  ts: '1760000001.000001',
  user: 'UBOT',
  text: 'INBOX512: Reviewer follow-up requests a regression test for cached mapping invalidation after rebuild. Changes requested, not approved. No production run or recovery was inspected. token=xoxb-hidden-reference',
  files: [{id: 'FNOTFETCHED'}],
};
const inboxLink = `https://fixture.slack.com/archives/DFIXTURE/p${inboxReview.ts.replace('.', '')}`;
let inboxFailure,
  wrongInboxPeer = false,
  groupInbox = false,
  inboxFallback = false,
  inboxMissing = false,
  oversizedInbox = false;
const network = [],
  cycles = [],
  checks = {},
  unavailable = [];
let interrupt;
let slackFailure,
  authWorkspace = 'TFIXTURE',
  authOwner = 'UOWNER',
  oversized = false,
  uncertain = false;
const plain = value =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(v => v.text ?? '').join('')
      : '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.origin === 'https://fixture.invalid') {
    modelCalls++;
    const body = JSON.parse(options.body),
      history = body.messages,
      payload = JSON.parse(
        plain(history.filter(m => m.role === 'user').at(-1).content),
      );
    const names = (body.tools ?? []).map(t => t.function.name);
    if (names.length && interrupt) {
      const abort = interrupt;
      interrupt = undefined;
      setTimeout(abort, 10);
      return new Promise((_, reject) =>
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('Synthetic cancellation')),
          {once: true},
        ),
      );
    }
    let text, calls;
    if (!names.length)
      text = JSON.stringify(
        payload.receipt.candidate_task_ids.length
          ? {action: 'route', task_id: payload.receipt.candidate_task_ids[0]}
          : {
              action: 'create',
              request: payload.receipt.text,
              outcome:
                'A concise evidence-backed review, not production execution.',
            },
      );
    else {
      assert.ok(
        names.every(n =>
          [
            'finish_task',
            'read_owner_reference',
            'read_source_thread',
            'write_artifact',
            'task_reply',
            'task_sync_slack',
          ].includes(n),
        ),
      );
      const since = history.slice(
        history.findLastIndex(m => m.role === 'user') + 1,
      );
      const read = since
        .filter(m => m.role === 'tool')
        .map(m => {
          try {
            return JSON.parse(plain(m.content));
          } catch {
            return {};
          }
        });
      if (
        since.some(
          m =>
            m.role === 'assistant' &&
            (m.tool_calls ?? []).some(c => c.function.name === 'finish_task'),
        )
      )
        text = 'Recorded.';
      else {
        let next;
        for (const ref of payload.owner_references ?? []) {
          const prior = read
            .filter(r => r.reference_id === ref.reference_id)
            .at(-1);
          if (!prior) next = {reference_id: ref.reference_id, offset: 0};
          else if (
            prior.next_offset !== null &&
            prior.next_offset !== undefined
          )
            next = {reference_id: ref.reference_id, offset: prior.next_offset};
          if (next) break;
        }
        if (next)
          calls = [
            {name: 'read_owner_reference', arguments: JSON.stringify(next)},
          ];
        else
          calls = [
            {
              name: 'finish_task',
              arguments: JSON.stringify(
                phase < 2
                  ? {
                      status: 'waiting',
                      summary: 'The research is still needed.',
                      next_action: 'Wait for the research.',
                      question:
                        payload.pending_question ??
                        'Can you share the rebuild research?',
                      reply:
                        phase === 1.5
                          ? 'That refers to your Slack account, not another reviewer.'
                          : null,
                    }
                  : {
                      status: phase === 3 ? 'done' : 'review',
                      summary:
                        phase === 3
                          ? 'Review completed per the owner.'
                          : 'Rebuild behavior is described, but cause is unverified.',
                      next_action: 'No production action authorized.',
                      question: null,
                      reply:
                        phase === 2.25
                          ? '*The reviewer reports a mapping mismatch in one sample.* This is reported evidence, not proof of production cause. Confirm the mapping before a rebuild; no action is approved.'
                          : phase === 2.5
                            ? '*The reviewer requests a regression test for mapping invalidation.* Changes are requested, not approved; no production run or recovery was checked.'
                            : phase === 3
                              ? '*Review completed, per your update.*\n\n- The review also reports temporary empty lists during rebuilding.\n- Neither these notes nor the research verify recurrence, root cause, or production recovery. No rebuild was executed.'
                              : '*The research describes a temporary list gap.*\n\n- TEMP policies reportedly disappeared after rebuilding.\n- That does not establish recurrence or root cause; production recovery remains unverified.',
                    },
              ),
            },
          ];
      }
    }
    const delta = calls
      ? {
          role: 'assistant',
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call_${modelCalls}_${index}`,
            type: 'function',
            function: call,
          })),
        }
      : {role: 'assistant', content: text};
    const chunk = (delta, finish_reason) =>
      JSON.stringify({
        id: `chat_${modelCalls}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'fixture',
        choices: [{index: 0, delta, finish_reason}],
      });
    return new Response(
      `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, calls ? 'tool_calls' : 'stop')}\n\ndata: [DONE]\n\n`,
      {headers: {'Content-Type': 'text/event-stream'}},
    );
  }
  if (url.origin !== 'https://slack.com') {
    if (provider && url.origin !== 'https://grafana.britecorepro.com')
      return realFetch(input, options);
    throw Error(`Unexpected network origin ${url.origin}`);
  }
  const method = url.pathname.replace('/api/', ''),
    params = Object.fromEntries(new URLSearchParams(options?.body));
  network.push({phase, method, params});
  const bot = options.headers.Authorization === 'Bearer fixture-bot';
  const reply = data => Response.json({ok: true, ...data});
  if (method === 'auth.test')
    return reply({
      team_id: authWorkspace,
      user_id: bot ? 'UBOT' : authOwner,
      url: 'https://fixture.slack.com/',
      ...(bot ? {bot_id: 'BBOT'} : {}),
    });
  if (method === 'users.info')
    return reply({
      user: {
        id: params.user,
        team_id: 'TFIXTURE',
        profile: {
          display_name:
            params.user === 'UOWNER' ? 'Owner Example' : 'Colleague Example',
        },
      },
    });
  if (method === 'conversations.info')
    return reply({
      channel:
        params.channel === 'DFIXTURE'
          ? {
              id: 'DFIXTURE',
              is_im: true,
              is_mpim: groupInbox,
              user: wrongInboxPeer ? 'UOTHER' : 'UOWNER',
            }
          : {id: params.channel, context_team_id: 'TFIXTURE'},
    });
  if (method === 'usergroups.list')
    return reply({
      usergroups: [
        {id: 'SOPS', team_id: 'TFIXTURE', date_delete: 0, handle: 'cloud-ops'},
      ],
    });
  if (method === 'search.messages')
    return reply({
      messages: {
        pagination: {page_count: 1},
        matches: params.query.startsWith('@cloud-ops')
          ? []
          : [{...messages[0], channel: {id: 'CBASE'}}],
      },
    });
  if (
    method === 'conversations.replies' ||
    method === 'conversations.history'
  ) {
    assert.notEqual(
      params.channel,
      'CFORBIDDEN',
      'No transitive/source-authored reference reads',
    );
    assert.notEqual(
      params.channel,
      'DOTHER',
      'No reads outside the bound inbox',
    );
    if (params.channel === 'DFIXTURE' && inboxFailure)
      return Response.json({ok: false, error: inboxFailure});
    if (params.channel === 'DFIXTURE' && oversizedInbox)
      return reply({messages: [{text: 'x'.repeat(2 * 1024 * 1024)}]});
    if (
      params.ts === inboxReview.ts &&
      inboxFallback &&
      method === 'conversations.replies'
    )
      return Response.json({ok: false, error: 'thread_not_found'});
    if (params.channel === 'CRESEARCH' && slackFailure)
      return Response.json({ok: false, error: slackFailure});
    if (params.channel === 'CRESEARCH' && oversized)
      return reply({messages: [{text: 'x'.repeat(2 * 1024 * 1024)}]});
    const rows = params.channel === 'CRESEARCH' ? researchRows : messages;
    return reply({
      messages: rows
        .filter(
          m =>
            m.channel === params.channel &&
            !(inboxMissing && m.ts === inboxReview.ts) &&
            (!params.oldest || Number(m.ts) >= Number(params.oldest)) &&
            (!params.latest || Number(m.ts) <= Number(params.latest)) &&
            (method === 'conversations.history'
              ? !m.thread_ts
              : m.ts === params.ts || m.thread_ts === params.ts),
        )
        .map(({channel, ...m}) => m),
      has_more: false,
      response_metadata: {next_cursor: ''},
    });
  }
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
    if (message.thread_ts) coordinatorReplyTs.add(message.ts);
    if (uncertain) {
      uncertain = false;
      throw Error('Synthetic post accepted, response lost');
    }
    return reply({channel: message.channel, ts: message.ts});
  }
  if (method === 'chat.update') {
    const message = messages.find(m => m.ts === params.ts);
    assert.ok(message);
    message.text = params.text;
    return reply({channel: params.channel, ts: params.ts});
  }
  throw Error(`Unexpected method ${method}`);
};
let store, auto, taskId, failure;
const signal = new AbortController().signal;
const replies = () =>
  messages.filter(
    m => m.user === 'UBOT' && m.thread_ts && coordinatorReplyTs.has(m.ts),
  );
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
try {
  store = await TaskStore.acquire(root);
  auto = await AutoTrial.open(store, 1, 600, 'DFIXTURE', discovery, excluded);
  for (phase of [0, 1, 1.5, 2, 2.25, 2.5, 3, 4]) {
    const client = new ReadonlySlackClient(
      tokens,
      path.join(root, 'cooldowns.json'),
    );
    let messenger = new TaskMessenger(store, tokens, true);
    await recoverRuns(store);
    assert.equal(
      (await pollIntake(store, client, 'DFIXTURE', signal, false, discovery))
        .status,
      'passed',
    );
    const triage = await classifyPending(
      store,
      config,
      signal,
      undefined,
      auto,
    );
    assert.equal(triage.blocked, 0);
    if (!provider && phase === 1) {
      const stop = new AbortController();
      interrupt = () => stop.abort();
      const cancelled = await runNextTask(
        store,
        config,
        stop.signal,
        messenger,
        client,
      );
      assert.equal(cancelled.error, 'cancelled');
      const journal = await readJson(path.join(root, 'runs', taskId + '.json'));
      assert.equal(
        journal.pending_question_delivery.key,
        cycles[0].journal.publication_key,
      );
      await store.close();
      store = await TaskStore.acquire(root);
      auto = await AutoTrial.open(
        store,
        1,
        600,
        'DFIXTURE',
        discovery,
        excluded,
      );
      messenger = new TaskMessenger(store, tokens, true);
      await recoverRuns(store);
      checks.cancelled_question_key = true;
    }
    observing = true;
    const result = await runNextTask(store, config, signal, messenger, client);
    observing = false;
    assert.equal(result.error, undefined, JSON.stringify(result));
    const items = await store.list();
    assert.equal(items.length, 1);
    taskId = items[0].task.id;
    await auto.validate();
    assert.equal(items[0].task.sources.length, 1);
    await messenger.sync(taskId);
    const answer = await taskPublication(store, items[0].task);
    if (answer)
      await messenger.reply(
        taskId,
        answer.text,
        answer.needsResponse,
        answer.key,
      );
    const journal = await readJson(path.join(root, 'runs', taskId + '.json'));
    cycles.push({
      phase,
      result,
      task: items[0],
      journal,
      reply_count: replies().length,
    });
    if (phase === 0) {
      assert.equal(items[0].status, 'waiting');
      assert.equal(replies().length, 1);
      messages.push({
        channel: 'CBASE',
        ts: timestamp(),
        thread_ts: base,
        user: 'UOTHER',
        text: `No new findings; the same research is still missing. ${forbidden}`,
      });
    } else if (phase === 1) {
      assert.equal(
        replies().length,
        1,
        'Unchanged pending question must remain silent',
      );
      messages.push({
        channel: 'DFIXTURE',
        ts: timestamp(),
        thread_ts: items[0].task.slack.parent_ts,
        user: 'UOWNER',
        text: 'I have not found the research yet. Before I send it, what does UOWNER mean in this task? Please answer that clarification; the research request is still pending.',
      });
    } else if (phase === 1.5) {
      assert.equal(
        replies().length,
        2,
        'A genuine owner question still receives an answer',
      );
      assert.equal(items[0].status, 'waiting');
      assert.ok(journal.outcome.question && journal.outcome.reply);
      assert.equal(
        answer.text,
        journal.outcome.reply,
        'The actual answer takes precedence over the pending question',
      );
      assert.notEqual(
        replies()[1].text,
        `<@UOWNER> ${journal.outcome.question}`,
      );
      checks.waiting_clarification_delivered = true;
      messages.push({
        channel: 'DFIXTURE',
        ts: timestamp(),
        thread_ts: items[0].task.slack.parent_ts,
        user: 'UOWNER',
        text: `Here is the research: ${link}. Please use it to answer the concern.`,
      });
    } else if (phase === 2) {
      assert.equal(replies().length, 3);
      const review = {
        channel: 'DFIXTURE',
        ts: timestamp(),
        thread_ts: items[0].task.slack.parent_ts,
        user: 'UBOT',
        text: `HANDOFF421: A separate reviewer reports a stale index mapping in one supplied sample, not a confirmed live cause. Confirm the mapping before another rebuild. No production actions or closure authorized. Further background: ${forbidden}. Pi session 99999999-2222-3333-8444-555555555555.`,
      };
      messages.push(review);
    } else if (phase === 2.25) {
      assert.equal(
        replies().length,
        4,
        'Reviewer result should advance the task once',
      );
      assert.equal(
        libraryReads.length,
        0,
        'Reviewer text cannot authorize session reads',
      );
      assert.equal(items[0].status, 'review');
      messages.push(inboxReview, {
        channel: 'DFIXTURE',
        ts: '1760000001.000002',
        thread_ts: inboxReview.ts,
        user: 'UBOT',
        text: 'DM_NEIGHBOR_NOT_REQUESTED',
      });
      messages.push({
        channel: 'DFIXTURE',
        ts: timestamp(),
        thread_ts: items[0].task.slack.parent_ts,
        user: 'UOWNER',
        text: `The reviewer posted a follow-up here: ${inboxLink}. Read that result, summarize the remaining issue, and do not repeat the review or treat it as approval.`,
      });
    } else if (phase === 2.5) {
      assert.equal(replies().length, 5);
      assert.equal(items[0].status, 'review');
      checks.reviewer_handoff = true;
      messages.push({
        channel: 'DFIXTURE',
        ts: timestamp(),
        thread_ts: items[0].task.slack.parent_ts,
        user: 'UOWNER',
        text: `I completed the review in Pi session ${guid}. Acknowledge that the review is done, distinguish reported work from execution/recovery, and do not ask me to paste the notes or perform production actions.`,
      });
    } else if (phase === 3) {
      assert.equal(replies().length, 6);
      assert.equal(items[0].status, 'done');
    } else {
      assert.equal(result.status, 'idle');
      assert.equal(replies().length, 6);
    }
    await store.close();
    store = await TaskStore.acquire(root);
    auto = await AutoTrial.open(store, 1, 600, 'DFIXTURE', discovery, excluded);
  }
  checks.exact_task_session = cycles.every(
    c => c.task.task.session.id === cycles[0].task.task.session.id,
  );
  checks.no_extra_admission = auto.ids.length === 1;
  checks.read_both_references =
    network.some(n => n.params.channel === 'CRESEARCH') &&
    libraryReads.length > 0;
  checks.read_only_session =
    (await fs.readFile(sessionFile, 'utf8')) === sourceSession;
  const task = (await store.locate(taskId)).task;
  const transcript = await fs.readFile(task.session.file, 'utf8');
  checks.source_facts =
    transcript.includes('RESEARCH614') &&
    transcript.includes('REVIEW8428') &&
    transcript.includes('HANDOFF421') &&
    transcript.includes('INBOX512');
  checks.withheld = [
    'ABANDONED_BRANCH',
    'PRIVATE_REASONING_MUST_NOT_APPEAR',
    'PRIVATE_STATE_MUST_NOT_APPEAR',
    'SECRET_SHOULD_BE_REDACTED',
    'customer@example.com',
    'xoxb-redact-this-secret',
    'UNRELATED_BODY_MUST_NOT_BE_READ',
    'DM_NEIGHBOR_NOT_REQUESTED',
    'xoxb-hidden-reference',
  ].every(s => !transcript.includes(s));
  if (!provider) {
    // Boundary failures are specified here before exercising the compiled evidence capability:
    // forged owner/thread/workspace; arbitrary IDs/paths; edits; denial/caps; identity mismatch;
    // ambiguous/symlink/malformed/oversize sessions; changed library; uncertain publication.
    const authorize = async (text, change = {}) => {
      const source = {
        workspace_id: 'TFIXTURE',
        channel_id: 'DFIXTURE',
        thread_ts: task.slack.parent_ts,
        message_ts: timestamp(),
      };
      const receipt = {
        schema_version: 1,
        id: digest(sourceKey(source)),
        source,
        kind: 'task_reply',
        author_id: 'UOWNER',
        text,
        content_hash: digest(text),
        candidate_task_ids: [taskId],
        disposition: 'routed',
        content_source: 'conversation',
        task_id: taskId,
        received_at: new Date().toISOString(),
        ...change,
      };
      await saveReceipt(store, receipt);
      const refs = await OwnerReferences.create(
        store,
        task,
        [receipt],
        library,
        new ReadonlySlackClient(
          tokens,
          path.join(root, 'boundary-cooldowns.json'),
        ),
      );
      return {
        refs,
        receipt,
        read: async () =>
          JSON.parse(
            (
              await refs.tool.execute(
                'read',
                {reference_id: refs.inventory[0].reference_id},
                signal,
              )
            ).content[0].text,
          ),
      };
    };
    for (const change of [
      {author_id: 'UOTHER'},
      {content_source: 'search'},
      {kind: 'source_reply'},
      {task_id: 'task-' + 'a'.repeat(32)},
      {
        source: {
          workspace_id: 'TOTHER',
          channel_id: 'DFIXTURE',
          thread_ts: task.slack.parent_ts,
          message_ts: timestamp(),
        },
      },
      {
        source: {
          workspace_id: 'TFIXTURE',
          channel_id: 'DFIXTURE',
          thread_ts: base,
          message_ts: timestamp(),
        },
      },
    ])
      assert.equal((await authorize(link, change)).refs.inventory.length, 0);
    const allowed = await authorize(link);
    await assert.rejects(
      () =>
        allowed.refs.tool.execute(
          'bad',
          {reference_id: 'file:///etc/passwd'},
          signal,
        ),
      /owner_reference_not_authorized/,
    );
    await assert.rejects(() =>
      allowed.refs.tool.execute(
        'bad',
        {
          reference_id: allowed.refs.inventory[0].reference_id,
          path: '/etc/passwd',
        },
        signal,
      ),
    );
    await saveReceipt(store, {
      ...allowed.receipt,
      text: 'Removed the reference.',
      content_hash: digest('Removed the reference.'),
    });
    await assert.rejects(() => allowed.read(), /owner_reference_changed/);
    const failRead = async (text, code) => {
      const test = await authorize(text);
      const value = await test.read();
      unavailable.push(value);
      assert.equal(value.error, code);
      assert.equal(value.unavailable, true);
    };
    assert.equal(
      (await authorize(inboxLink.replace('DFIXTURE', 'DOTHER'))).refs.inventory
        .length,
      0,
    );
    const exactInbox = await (await authorize(inboxLink)).read();
    assert.equal(exactInbox.messages.length, 1);
    assert.equal(exactInbox.messages[0].ts, inboxReview.ts);
    assert.equal(exactInbox.messages[0].attachments_not_fetched, true);
    assert.equal(exactInbox.untrusted_evidence, true);
    assert.doesNotMatch(
      JSON.stringify(exactInbox),
      /DM_NEIGHBOR_NOT_REQUESTED|xoxb-hidden-reference/,
    );
    wrongInboxPeer = true;
    await failRead(inboxLink, 'reference_channel_mismatch');
    wrongInboxPeer = false;
    groupInbox = true;
    await failRead(inboxLink, 'reference_channel_mismatch');
    groupInbox = false;
    inboxFailure = 'missing_scope';
    const historyBefore = network.filter(
      n => n.method === 'conversations.history',
    ).length;
    await failRead(inboxLink, 'missing_scope');
    assert.equal(
      network.filter(n => n.method === 'conversations.history').length,
      historyBefore,
    );
    inboxFailure = undefined;
    oversizedInbox = true;
    await failRead(inboxLink, 'response_too_large');
    oversizedInbox = false;
    inboxFallback = true;
    const fallback = await (await authorize(inboxLink)).read();
    assert.equal(fallback.messages.length, 1);
    assert.equal(fallback.messages[0].ts, inboxReview.ts);
    const historyCall = network
      .filter(n => n.method === 'conversations.history')
      .at(-1);
    assert.equal(historyCall.params.oldest, inboxReview.ts);
    assert.equal(historyCall.params.latest, inboxReview.ts);
    assert.equal(historyCall.params.limit, '1');
    inboxMissing = true;
    await failRead(inboxLink, 'reference_message_not_observed');
    inboxMissing = false;
    inboxFallback = false;
    const linkedReply = {
      ...inboxReview,
      ts: '1760000001.000003',
      thread_ts: inboxReview.ts,
      text: 'EXACT_REPLY619',
    };
    messages.push(linkedReply);
    const replyLink =
      inboxLink.replace(
        inboxReview.ts.replace('.', ''),
        linkedReply.ts.replace('.', ''),
      ) +
      '?thread_ts=' +
      inboxReview.ts;
    const linked = await (await authorize(replyLink)).read();
    assert.equal(linked.messages.length, 1);
    assert.equal(linked.messages[0].text, 'EXACT_REPLY619');
    checks.same_inbox_exact_message = true;
    await failRead(
      link.replace('fixture.slack.com', 'foreign.slack.com'),
      'reference_workspace_mismatch',
    );
    authWorkspace = 'TOTHER';
    await failRead(link, 'reference_identity_mismatch');
    authWorkspace = 'TFIXTURE';
    authOwner = 'UOTHER';
    await failRead(link, 'reference_identity_mismatch');
    authOwner = 'UOWNER';
    slackFailure = 'missing_scope';
    await failRead(link, 'missing_scope');
    slackFailure = undefined;
    oversized = true;
    await failRead(link, 'response_too_large');
    oversized = false;
    await failRead(
      'Pi session 99999999-2222-3333-8444-555555555555',
      'session_reference_not_found',
    );
    await fs.mkdir(path.join(library, 'copy'));
    await fs.copyFile(
      sessionFile,
      path.join(library, 'copy', path.basename(sessionFile)),
    );
    await failRead(`Pi session ${guid}`, 'ambiguous_session_reference');
    await fs.rm(path.join(library, 'copy'), {recursive: true});
    await fs.rename(sessionFile, sessionFile + '.original');
    await fs.symlink(sessionFile + '.original', sessionFile);
    await failRead(`Pi session ${guid}`, 'reference_symlink');
    await fs.unlink(sessionFile);
    await fs.rename(sessionFile + '.original', sessionFile);
    await fs.writeFile(
      sessionFile,
      sourceSession.replace(guid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    );
    await failRead(`Pi session ${guid}`, 'invalid_session_reference');
    await fs.writeFile(sessionFile, sourceSession + '{');
    await failRead(`Pi session ${guid}`, 'invalid_session_reference');
    await fs.writeFile(sessionFile, 'x'.repeat(8 * 1024 * 1024 + 1));
    await failRead(`Pi session ${guid}`, 'session_reference_too_large');
    await fs.writeFile(sessionFile, sourceSession);
    await assert.rejects(
      () => requireSessionLibrary(store, agent),
      /session_library_scope_mismatch/,
    );
    const messenger = new TaskMessenger(store, tokens, true),
      before = replies().length;
    uncertain = true;
    await assert.rejects(
      () =>
        messenger.reply(
          taskId,
          'One genuine new owner question?',
          true,
          'uncertain-reference-case',
        ),
      /slack_write_uncertain/,
    );
    await messenger.reply(
      taskId,
      'One genuine new owner question?',
      true,
      'uncertain-reference-case',
    );
    assert.equal(
      replies().length,
      before + 1,
      'Uncertain send reconciles instead of repeating',
    );
    checks.boundary_failures = true;
  }
  await auto.close();
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
} catch (error) {
  failure = error.stack ?? String(error);
  process.exitCode = 2;
} finally {
  observing = false;
  await store?.close();
  globalThis.fetch = realFetch;
  fs.open = originalOpen;
  fs.readFile = originalRead;
  syncBuiltinESMExports();
  const runtime = {};
  for (const name of [
    'worker',
    'intake',
    'reviewer-handoff',
    'owner-references',
    'reference-session',
    'slack',
    'task-slack',
    'auto-trial',
  ])
    runtime[name] = createHash('sha256')
      .update(await fs.readFile(path.join(pkg, 'dist', name + '.js')))
      .digest('hex');
  const report = {
    at: new Date().toISOString(),
    directory,
    provider: config.provider,
    model: config.model,
    live_slack: false,
    live_production: false,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: pkg,
      encoding: 'utf8',
    }).trim(),
    runtime,
    checks,
    failure,
    session_hash_before: initialHash,
    session_hash_after: digest(await fs.readFile(sessionFile, 'utf8')),
    libraryReads,
    network,
    cycles,
    replies: replies(),
    unavailable,
    result: failure
      ? 'failed'
      : provider
        ? 'requires_source_based_answer_review'
        : 'passed',
  };
  await fs.writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      report: path.join(directory, 'report.json'),
      result: report.result,
      failure,
      checks,
    }),
  );
}
