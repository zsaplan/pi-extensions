import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {ReadonlySlackClient, object, objects} from './slack.ts';
import type {Receipt} from './intake.ts';
import {referenceText} from './reference-session.ts';
import {
  absent,
  atomicJson,
  updateJson,
  digest,
  readJson,
  sourceKey,
  StoreError,
  type Source,
  type Task,
  type TaskStore,
} from './store.ts';

// Identity is a candidate filter, never approval or proof of the same outcome.
export function workLinks(text: string): string[] {
  const keys = new Set<string>();
  for (const raw of text.match(/https:\/\/[^\s<>|]+/g) ?? []) {
    try {
      const url = new URL(raw.replace(/[.,;)]+$/, ''));
      if (url.username || url.password || url.port) continue;
      const pr = url.pathname.match(
        /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:\/(?:files|commits|checks))?\/?$/,
      );
      if (url.hostname === 'github.com' && pr)
        keys.add(
          `github:${pr[1].toLowerCase()}/${pr[2].toLowerCase()}/pull/${pr[3]}`,
        );
    } catch {
      /* Non-URLs do not nominate work. */
    }
  }
  return [...keys].slice(0, 8);
}
export interface Association {
  schema_version: 1;
  task_id: string;
  receipt_id: string;
  receipt_hash: string;
  source: Source;
  resource: string;
  basis_receipt_id: string;
  basis_hash: string;
  context_hash: string;
}
interface Context {
  receipt_id: string;
  receipt_hash: string;
  source: Source;
  checked_at: string;
  human: boolean;
  messages: {ts: string; author: unknown; text: string}[];
  resources: string[];
  partial: boolean;
}
export function contextFingerprint(context: Context): string {
  return digest(JSON.stringify({...context, checked_at: undefined}));
}
const contextFile = (store: TaskStore, r: Receipt) =>
  path.join(
    store.root,
    'intake',
    'related-context',
    `${r.id}-${r.content_hash}.json`,
  );
const folder = (store: TaskStore, id: string) =>
  path.join(store.root, 'intake', 'associations', id);
const sameThread = (a: Source, b: Source) =>
  a.workspace_id === b.workspace_id &&
  a.channel_id === b.channel_id &&
  (a.thread_ts ?? a.message_ts) === (b.thread_ts ?? b.message_ts);

// Only locally journaled, still-current routing evidence can subscribe another
// thread. No primary source, session or Slack parent is changed.
export async function associatedSources(
  store: TaskStore,
  tasks: Task[],
  observed: Receipt[],
): Promise<Association[]> {
  const result: Association[] = [];
  for (const task of tasks) {
    let names: string[];
    try {
      names = await readdir(folder(store, task.id));
    } catch (e) {
      if (absent(e)) continue;
      throw e;
    }
    const files = names.filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (files.length > 3) throw new StoreError('associated_source_limit');
    for (const name of files.sort()) {
      const a = (await readJson(
        path.join(folder(store, task.id), name),
      )) as Association;
      if (
        a.schema_version !== 1 ||
        a.task_id !== task.id ||
        name !== `${a.receipt_id}.json` ||
        a.source.workspace_id !== task.inbox.workspace_id ||
        !/^[CG][A-Z0-9]+$/.test(a.source.channel_id)
      )
        throw new StoreError('invalid_source_association');
      const anchor = observed.find(r => r.id === a.receipt_id);
      const basis = observed.find(r => r.id === a.basis_receipt_id);
      if (
        !anchor ||
        !basis ||
        anchor.content_hash !== a.receipt_hash ||
        basis.content_hash !== a.basis_hash ||
        anchor.disposition !== 'routed' ||
        anchor.task_id !== task.id
      )
        continue;
      if (
        sourceKey(anchor.source) !== sourceKey(a.source) ||
        !task.sources.some(s => sourceKey(s) === sourceKey(basis.source)) ||
        !workLinks(basis.text).includes(a.resource)
      )
        throw new StoreError('invalid_source_association');
      const context = (await readJson(contextFile(store, anchor))) as Context;
      if (
        digest(JSON.stringify(context)) !== a.context_hash ||
        context.receipt_id !== anchor.id ||
        context.receipt_hash !== anchor.content_hash ||
        sourceKey(context.source) !== sourceKey(anchor.source) ||
        !context.human ||
        !context.resources.includes(a.resource)
      )
        throw new StoreError('invalid_source_association');
      result.push(a);
    }
  }
  return result;
}
export function associatedTaskIds(
  associations: Association[],
  receipt: Receipt,
): string[] {
  // A task-thread reply/reviewer result never gets cross-task routing authority.
  if (
    receipt.kind === 'task_reply' ||
    receipt.evidence_kind ||
    !receipt.author_id
  )
    return [];
  return [
    ...new Set(
      associations
        .filter(a => sameThread(a.source, receipt.source))
        .map(a => a.task_id),
    ),
  ];
}

export class RelatedWork {
  private reads = 0;
  canCheck(receipt: Receipt, tasks: {task: Task; status: string}[]): boolean {
    return (
      ['mention', 'channel_thread'].includes(receipt.kind) &&
      !receipt.evidence_kind &&
      Boolean(receipt.author_id) &&
      /^[CG][A-Z0-9]+$/.test(receipt.source.channel_id) &&
      tasks.some(
        ({task, status}) =>
          status !== 'done' &&
          this.observed.some(
            r =>
              task.sources.some(s => sourceKey(s) === sourceKey(r.source)) &&
              workLinks(r.text).length,
          ),
      )
    );
  }
  constructor(
    private store: TaskStore,
    private observed: Receipt[],
  ) {}

  async context(
    receipt: Receipt,
    client: ReadonlySlackClient,
    signal: AbortSignal,
    refresh = false,
  ): Promise<Context | undefined> {
    if (
      !['mention', 'channel_thread'].includes(receipt.kind) ||
      receipt.evidence_kind ||
      !receipt.author_id ||
      !/^[CG][A-Z0-9]+$/.test(receipt.source.channel_id)
    )
      return undefined;
    const file = contextFile(this.store, receipt);
    try {
      const saved = (await readJson(file)) as Context;
      if (
        saved.receipt_id !== receipt.id ||
        saved.receipt_hash !== receipt.content_hash ||
        sourceKey(saved.source) !== sourceKey(receipt.source)
      )
        throw new StoreError('invalid_related_context');
      if (!refresh) return saved;
    } catch (e) {
      if (!absent(e)) throw e;
    }
    if (this.reads >= 5) return undefined;
    this.reads++;
    const src = receipt.source,
      root = src.thread_ts ?? src.message_ts;
    const first = await client.call(
      'user',
      'conversations.replies',
      {channel: src.channel_id, ts: root, limit: '20'},
      signal,
      2 * 1024 * 1024,
    );
    const rows = objects(first.messages);
    const parent = rows.find(m => m.ts === root);
    if (!parent) throw new StoreError('related_thread_mismatch');
    let pointed = rows.find(m => m.ts === src.message_ts);
    if (!pointed) {
      const exact = await client.call(
        'user',
        'conversations.replies',
        {
          channel: src.channel_id,
          ts: root,
          oldest: src.message_ts,
          latest: src.message_ts,
          inclusive: 'true',
          limit: '2',
        },
        signal,
        2 * 1024 * 1024,
      );
      pointed = objects(exact.messages).find(m => m.ts === src.message_ts);
      if (pointed) rows.push(pointed);
    }
    if (
      !pointed ||
      pointed.user !== receipt.author_id ||
      (pointed.thread_ts && pointed.thread_ts !== root)
    )
      throw new StoreError('related_message_changed');
    if (typeof pointed.text !== 'string')
      throw new StoreError('invalid_related_message');
    const canonicalHash = digest(
      JSON.stringify({text: pointed.text, author: pointed.user}),
    );
    if (canonicalHash !== receipt.content_hash) {
      // Search formatting/edits are not canonical. Promote with a compare-and-
      // swap, then re-check eligibility next poll; never route the stale text.
      await updateJson(
        path.join(this.store.root, 'intake', 'receipts', `${receipt.id}.json`),
        current => {
          this.store.assertOwner();
          const prior = current as Receipt;
          if (
            prior?.content_hash !== receipt.content_hash ||
            prior.disposition !== 'pending'
          )
            return undefined;
          return {
            ...prior,
            text: pointed.text,
            content_hash: canonicalHash,
            content_source: 'conversation',
          };
        },
      );
      return undefined;
    }
    const messages = [
      ...new Map(
        [parent, ...rows.slice(-8), pointed].map(m => [m.ts, m]),
      ).values(),
    ].map(m => ({
      ts: String(m.ts),
      author: m.user ?? null,
      text: referenceText(
        typeof m.text === 'string' ? m.text.slice(0, 2000) : '',
      ),
    }));
    const context: Context = {
      receipt_id: receipt.id,
      receipt_hash: receipt.content_hash,
      source: src,
      checked_at: new Date().toISOString(),
      human: !pointed.bot_id && !pointed.subtype,
      messages,
      // Use the root and pointed request, not arbitrary intermediate reviews,
      // to nominate an entity. Review content cannot attach itself to a task.
      resources: workLinks(
        `${String(parent.text ?? '')}\n${String(pointed.text ?? '')}`,
      ),
      partial:
        first.has_more === true ||
        Boolean(
          first.response_metadata &&
          object(first.response_metadata).next_cursor,
        ) ||
        rows.length > messages.length ||
        rows.some(m => typeof m.text === 'string' && m.text.length > 2000),
    };
    this.store.assertOwner();
    await atomicJson(file, context);
    return context;
  }
  candidates(
    context: Context | undefined,
    tasks: {task: Task; status: string}[],
  ): string[] {
    if (!context?.human) return [];
    return tasks
      .filter(
        ({task, status}) =>
          status !== 'done' &&
          task.slack.parent_ts &&
          task.inbox.workspace_id === context.source.workspace_id &&
          this.observed.some(
            r =>
              task.sources.some(s => sourceKey(s) === sourceKey(r.source)) &&
              workLinks(r.text).some(key => context.resources.includes(key)),
          ),
      )
      .map(t => t.task.id);
  }
  async associate(
    task: Task,
    receipt: Receipt,
    context: Context,
  ): Promise<Association> {
    const basis = this.observed.find(
      r =>
        task.sources.some(s => sourceKey(s) === sourceKey(r.source)) &&
        workLinks(r.text).some(key => context.resources.includes(key)),
    );
    if (
      !context.human ||
      !basis ||
      receipt.author_id === task.inbox.bot_user_id ||
      receipt.kind === 'task_reply' ||
      receipt.evidence_kind
    )
      throw new StoreError('invalid_related_route');
    // A changed receipt cannot silently move an existing association elsewhere.
    if (receipt.task_id && receipt.task_id !== task.id)
      throw new StoreError('related_route_changed');
    const a: Association = {
      schema_version: 1,
      task_id: task.id,
      receipt_id: receipt.id,
      receipt_hash: receipt.content_hash,
      source: receipt.source,
      resource: workLinks(basis.text).find(k => context.resources.includes(k))!,
      basis_receipt_id: basis.id,
      basis_hash: basis.content_hash,
      context_hash: digest(JSON.stringify(context)),
    };
    const dir = folder(this.store, task.id);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (!absent(e)) throw e;
    }
    if (
      !names.includes(`${receipt.id}.json`) &&
      names.filter(n => n.endsWith('.json')).length >= 3
    )
      throw new StoreError('associated_source_limit');
    this.store.assertOwner();
    await atomicJson(path.join(dir, `${receipt.id}.json`), a);
    return a;
  }
}
