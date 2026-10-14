// Opt-in: real model classification, synthetic Slack receipts, no Slack access or task execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskStore, atomicJson, digest, sourceKey} from '../dist/store.js';
import {saveReceipt, receipts} from '../dist/intake.js';
import {classifyPending} from '../dist/worker.js';

const pkg = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(pkg, 'tmp/discovery-scope'), {recursive: true});
const directory = await mkdtemp(
  path.join(pkg, 'tmp/discovery-scope/provider-'),
);
const root = path.join(directory, 'state');
const selected = {
  workspace_id: 'TFIXTURE',
  channel_id: 'DFIXTURE',
  owner_user_id: 'UOWNER',
  bot_user_id: 'UBOT',
};
const config = {provider: 'openai-codex', model: 'gpt-6.1-sol'};
const now = Math.floor(Date.now() / 1000);
const timestamp = offset => `${now + offset}.000001`;
const fixtures = [
  {
    channel: 'COWNER',
    kind: 'mention',
    text: '<@UOWNER> Draft a local staging-preview note for Poppy (POPPY4827). Ask me for the launch date; do not publish or deploy.',
  },
  {
    channel: 'CTEAM',
    kind: 'mention',
    text: '<@SGROUP> Example team: draft a local staging storage cleanup checklist for Willow (WILLOW6538). Ask me for retention days. Do not delete anything.',
  },
  {
    channel: 'CWATCH',
    kind: 'channel_thread',
    text: 'Please draft a local incident note for Maple (MAPLE9172): 3 of 20 synthetic parsing jobs failed, recovery is unverified. Ask for the incident window. No production actions.',
  },
  {
    channel: 'CWATCH',
    kind: 'channel_thread',
    text: 'Thanks everyone, have a good afternoon!',
  },
];
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  if (new URL(String(url)).hostname === 'slack.com')
    throw Error('Live Slack forbidden');
  return originalFetch(url, ...args);
};
let store;
const checks = {};
const snapshots = [];
let failure;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240000);
try {
  store = await TaskStore.acquire(root);
  await atomicJson(path.join(root, 'inbox.json'), selected);
  for (const [index, fixture] of fixtures.entries()) {
    const source = {
      workspace_id: selected.workspace_id,
      channel_id: fixture.channel,
      message_ts: timestamp(-200 + index),
    };
    const row = {
      schema_version: 1,
      id: digest(sourceKey(source)),
      source,
      kind: fixture.kind,
      author_id: 'UOTHER',
      text: fixture.text,
      content_hash: digest(
        JSON.stringify({text: fixture.text, author: 'UOTHER'}),
      ),
      content_source: fixture.kind === 'mention' ? 'search' : 'conversation',
      candidate_task_ids: [],
      disposition: 'pending',
      received_at: new Date().toISOString(),
    };
    fixture.receipt_id = row.id;
    await saveReceipt(store, row);
  }
  snapshots.push({
    result: await classifyPending(store, config, controller.signal),
    tasks: await store.list(),
    receipts: await receipts(store),
  });
  let rows = await receipts(store);
  checks.three_actionable_tasks =
    (await store.list()).length === 3 &&
    fixtures
      .slice(0, 3)
      .every(
        f => rows.find(r => r.id === f.receipt_id)?.disposition === 'routed',
      );
  checks.chatter_ignored =
    rows.find(r => r.id === fixtures[3].receipt_id)?.disposition === 'ignored';
  assert.ok(checks.three_actionable_tasks && checks.chatter_ignored);
  const prior = rows.find(r => r.id === fixtures[2].receipt_id);
  const source = {
    ...prior.source,
    message_ts: timestamp(-10),
    thread_ts: prior.source.message_ts,
  };
  const text =
    'For Maple: the incident window is October 13, 2026, 03:00–03:15 UTC. Recovery remains unverified.';
  const followup = {
    schema_version: 1,
    id: digest(sourceKey(source)),
    source,
    kind: 'source_reply',
    author_id: 'UOTHER',
    text,
    content_hash: digest(JSON.stringify({text, author: 'UOTHER'})),
    content_source: 'conversation',
    candidate_task_ids: [prior.task_id],
    disposition: 'pending',
    received_at: new Date().toISOString(),
  };
  await saveReceipt(store, followup);
  await store.close();
  store = await TaskStore.acquire(root);
  snapshots.push({
    result: await classifyPending(
      store,
      config,
      controller.signal,
      (await store.list()).map(item => item.task),
    ),
    tasks: await store.list(),
    receipts: await receipts(store),
  });
  rows = await receipts(store);
  checks.source_update_routed_without_duplicate =
    rows.find(r => r.id === followup.id)?.task_id === prior.task_id &&
    rows.find(r => r.id === followup.id)?.disposition === 'routed' &&
    (await store.list()).length === 3;
  checks.idle_does_not_resolve_model =
    (
      await classifyPending(
        store,
        {provider: 'forbidden', model: 'forbidden'},
        controller.signal,
      )
    ).handled === 0;
  checks.no_worker_sessions = (await store.list()).every(
    t => t.task.session.id === null,
  );
  assert.ok(Object.values(checks).every(Boolean));
} catch (error) {
  failure = error instanceof Error ? error.message : 'failed';
  process.exitCode = 2;
} finally {
  clearTimeout(timer);
  await store?.close();
  globalThis.fetch = originalFetch;
  const runtime = {};
  for (const name of ['worker', 'intake', 'discovery'])
    runtime[name] = createHash('sha256')
      .update(await readFile(path.join(pkg, 'dist', name + '.js')))
      .digest('hex');
  const report = {
    result: failure ? 'failed' : 'requires_source_based_classification_review',
    failure,
    config,
    node: process.version,
    checks,
    fixtures,
    snapshots,
    runtime,
    live_slack: false,
    task_execution: false,
  };
  await writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    {mode: 0o600},
  );
  console.log(
    JSON.stringify({
      directory,
      result: report.result,
      failure,
      checks,
      tasks: snapshots.at(-1)?.tasks.map(t => ({
        id: t.task.id,
        request: t.task.request,
        outcome: t.task.outcome,
      })),
    }),
  );
}
