import path from 'node:path';
import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {realpath} from 'node:fs/promises';
import {Type} from 'typebox';
import {
  absent,
  atomicJson,
  digest,
  exactKeys,
  readJson,
  record,
  SLACK_TS,
  StoreError,
  updateJson,
  type Task,
  type TaskStore,
} from './store.ts';
import {
  ReadonlySlackClient,
  SlackError,
  object,
  objects,
  type JsonObject,
} from './slack.ts';
import type {Receipt} from './intake.ts';
import {readReferencedSession, referenceText} from './reference-session.ts';

export function isOwnerThreadReply(task: Task, receipt: Receipt): boolean {
  return (
    Boolean(task.slack.parent_ts) &&
    receipt.kind === 'task_reply' &&
    receipt.author_id === task.inbox.owner_user_id &&
    receipt.source.workspace_id === task.inbox.workspace_id &&
    receipt.source.channel_id === task.inbox.channel_id &&
    receipt.source.thread_ts === task.slack.parent_ts
  );
}
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
type Target =
  | {
      kind: 'slack_thread';
      origin: string;
      channel: string;
      message_ts: string;
      thread_ts?: string;
    }
  | {kind: 'pi_session'; session_id: string};
function referenceMessage(row: Record<string, unknown>) {
  const clean = referenceText(typeof row.text === 'string' ? row.text : '');
  return {
    ts: row.ts,
    author_id:
      typeof row.user === 'string' && /^[UW][A-Z0-9]{1,79}$/.test(row.user)
        ? row.user
        : null,
    text: clean.slice(0, 2000),
    text_truncated: clean.length > 2000,
    attachments_not_fetched: Boolean(
      (Array.isArray(row.files) && row.files.length) ||
      (Array.isArray(row.attachments) && row.attachments.length),
    ),
  };
}
interface Reference {
  id: string;
  target: Target;
  authority: {receipt_id: string; content_hash: string}[];
}
export function ownerReferenceTargets(text: string): Target[] {
  const found: Target[] = [];
  for (const match of text.matchAll(/https:\/\/[^\s<>|]+/g)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ''));
      const parts = /^\/archives\/([CGD][A-Z0-9]+)\/p(\d{16,22})\/?$/.exec(
        url.pathname,
      );
      if (
        !parts ||
        !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        url.searchParams.getAll('thread_ts').length > 1
      )
        continue;
      const message = `${parts[2].slice(0, -6)}.${parts[2].slice(-6)}`;
      const root = url.searchParams.get('thread_ts');
      if (root && (!SLACK_TS.test(root) || Number(root) > Number(message)))
        continue;
      if (
        url.searchParams.has('cid') &&
        url.searchParams.get('cid') !== parts[1]
      )
        continue;
      found.push({
        kind: 'slack_thread',
        origin: url.origin,
        channel: parts[1],
        message_ts: message,
        ...(root ? {thread_ts: root} : {}),
      });
    } catch {
      /* Invalid references are not executable input. */
    }
  }
  for (const match of text.matchAll(
    new RegExp(
      `\\b(?:pi\\s+)?session(?:\\s+id)?[\\s:=#\x60]*(${UUID})\\b`,
      'gi',
    ),
  ))
    found.push({kind: 'pi_session', session_id: match[1].toLowerCase()});
  return found;
}
async function libraryScope(library?: string) {
  const requested = path.resolve(
    library ?? path.join(getAgentDir(), 'sessions'),
  );
  let resolved: string | null = null;
  try {
    resolved = await realpath(requested);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return {requested, resolved};
}
export async function requireSessionLibrary(
  store: TaskStore,
  library?: string,
  bind = false,
) {
  store.assertOwner();
  const scope = await libraryScope(library);
  const file = path.join(store.root, 'intake', 'session-library.json');
  const validate = (value: unknown) => {
    if (value) {
      const saved = record(value);
      if (
        saved.schema_version !== 1 ||
        saved.requested !== scope.requested ||
        (saved.resolved && scope.resolved && saved.resolved !== scope.resolved)
      )
        throw new StoreError('session_library_scope_mismatch');
    }
  };
  if (bind)
    await updateJson(file, value => {
      validate(value);
      return {
        schema_version: 1,
        ...scope,
        resolved: scope.resolved ?? (value ? record(value).resolved : null),
      };
    });
  else
    try {
      validate(await readJson(file));
    } catch (error) {
      if (!absent(error)) throw error;
    }
  return scope.requested;
}

// Evidence references never change the primary source/identity or grant operational authority.
// Rebuild from current durable owner receipts, not from model output or linked content.
export class OwnerReferences {
  private cache = new Map<
    string,
    Promise<{messages: unknown[]; [key: string]: unknown}>
  >();
  private pages = new Set<string>();
  private constructor(
    private store: TaskStore,
    private task: Task,
    private refs: Reference[],
    private library: string,
    private client: ReadonlySlackClient | undefined,
    readonly omitted: number,
  ) {}
  static async create(
    store: TaskStore,
    task: Task,
    receipts: Receipt[],
    library?: string,
    client?: ReadonlySlackClient,
  ) {
    const candidates = new Map<string, Reference>();
    for (const receipt of receipts
      .filter(
        r =>
          r.task_id === task.id &&
          r.disposition === 'routed' &&
          r.content_source === 'conversation' &&
          isOwnerThreadReply(task, r),
      )
      .sort(
        (a, b) => Number(b.source.message_ts) - Number(a.source.message_ts),
      )) {
      for (const target of ownerReferenceTargets(receipt.text)) {
        if (
          target.kind === 'slack_thread' &&
          target.channel.startsWith('D') &&
          target.channel !== task.inbox.channel_id
        )
          continue;
        const id = `reference:${digest(`${task.id}:${JSON.stringify(target)}`).slice(0, 32)}`;
        const ref = candidates.get(id) ?? {id, target, authority: []};
        ref.authority.push({
          receipt_id: receipt.id,
          content_hash: receipt.content_hash,
        });
        candidates.set(id, ref);
      }
    }
    const refs = [...candidates.values()].slice(0, 5);
    const directory = await requireSessionLibrary(
      store,
      library,
      refs.some(ref => ref.target.kind === 'pi_session'),
    );
    if (candidates.size)
      await atomicJson(
        path.join(store.root, 'intake', 'references', `${task.id}.json`),
        {
          schema_version: 1,
          task_id: task.id,
          references: refs,
          omitted: Math.max(0, candidates.size - refs.length),
        },
      );
    return new OwnerReferences(
      store,
      task,
      refs,
      directory,
      client,
      Math.max(0, candidates.size - refs.length),
    );
  }
  get inventory() {
    return this.refs.map(ref => ({reference_id: ref.id, ...ref.target}));
  }
  private async authorized(ref: Reference) {
    for (const proof of ref.authority) {
      if (!/^[a-f0-9]{64}$/.test(proof.receipt_id))
        throw new StoreError('invalid_reference_authority');
      const latest = (await readJson(
        path.join(
          this.store.root,
          'intake',
          'receipts',
          `${proof.receipt_id}.json`,
        ),
      )) as Receipt;
      if (
        latest.task_id === this.task.id &&
        latest.disposition === 'routed' &&
        latest.content_source === 'conversation' &&
        latest.content_hash === proof.content_hash &&
        isOwnerThreadReply(this.task, latest)
      )
        return;
    }
    throw new StoreError('owner_reference_changed');
  }
  private async slack(
    target: Extract<Target, {kind: 'slack_thread'}>,
    signal: AbortSignal,
  ) {
    const inboxReference = target.channel.startsWith('D');
    if (inboxReference && target.channel !== this.task.inbox.channel_id)
      throw new StoreError('reference_inbox_mismatch');
    if (!this.client) throw new StoreError('slack_reference_unavailable');
    const call = (
      method: Parameters<ReadonlySlackClient['call']>[1],
      params: Record<string, string> = {},
    ) => this.client!.call('user', method, params, signal, 2 * 1024 * 1024);
    const identity = await call('auth.test');
    if (
      identity.team_id !== this.task.inbox.workspace_id ||
      identity.user_id !== this.task.inbox.owner_user_id
    )
      throw new StoreError('reference_identity_mismatch');
    let origin: string;
    try {
      origin = new URL(String(identity.url)).origin;
    } catch {
      throw new StoreError('reference_workspace_unverified');
    }
    if (origin !== target.origin)
      throw new StoreError('reference_workspace_mismatch');
    if (inboxReference) {
      const bot = await this.client.call(
        'bot',
        'auth.test',
        {},
        signal,
        2 * 1024 * 1024,
      );
      if (
        bot.team_id !== this.task.inbox.workspace_id ||
        bot.user_id !== this.task.inbox.bot_user_id
      )
        throw new StoreError('reference_identity_mismatch');
    }
    const channel = object(
      (
        await this.client.call(
          inboxReference ? 'bot' : 'user',
          'conversations.info',
          {channel: target.channel},
          signal,
          2 * 1024 * 1024,
        )
      ).channel,
    );
    if (
      channel.id !== target.channel ||
      (inboxReference
        ? channel.is_im !== true ||
          channel.user !== this.task.inbox.owner_user_id ||
          channel.is_archived === true
        : channel.is_im === true) ||
      channel.is_mpim === true ||
      (channel.context_team_id &&
        channel.context_team_id !== this.task.inbox.workspace_id)
    )
      throw new StoreError('reference_channel_mismatch');
    let root = target.thread_ts ?? target.message_ts;
    let first;
    try {
      first = await call('conversations.replies', {
        channel: target.channel,
        ts: root,
        limit: '20',
      });
    } catch (error) {
      // Some top-level bot posts are not threads. Exact-message fallback only;
      // never search nearby DM history or bypass an access/rate-limit failure.
      if (
        !inboxReference ||
        target.thread_ts ||
        !(error instanceof SlackError) ||
        error.code !== 'thread_not_found'
      )
        throw error;
      first = await call('conversations.history', {
        channel: target.channel,
        oldest: target.message_ts,
        latest: target.message_ts,
        inclusive: 'true',
        limit: '1',
      });
    }
    const inboxResult = (row: JsonObject) => {
      if (
        typeof row.ts !== 'string' ||
        row.ts !== target.message_ts ||
        (row.thread_ts !== undefined &&
          (typeof row.thread_ts !== 'string' ||
            !SLACK_TS.test(row.thread_ts) ||
            Number(row.thread_ts) > Number(row.ts))) ||
        (target.thread_ts && (row.thread_ts ?? row.ts) !== target.thread_ts)
      )
        throw new StoreError('reference_thread_mismatch');
      return {
        workspace_id: this.task.inbox.workspace_id,
        channel_id: target.channel,
        thread_ts: row.thread_ts ?? row.ts,
        messages: [referenceMessage(row)],
        capped: false,
        coverage:
          'Only the exact owner-linked message in the already-bound owner/bot inbox. Other messages, attachments and further links are not returned or followed. This is reported evidence, not approval or independent execution proof.',
      };
    };
    // A reply permalink may identify its parent in the returned message. Never guess/search other threads.
    const pointed = objects(first.messages).find(
      message => message.ts === target.message_ts,
    );
    if (objects(first.messages).length > 20)
      throw new StoreError('reference_page_limit');
    if (inboxReference && pointed) return inboxResult(pointed);
    if (!target.thread_ts && pointed?.thread_ts && pointed.thread_ts !== root) {
      if (
        typeof pointed.thread_ts !== 'string' ||
        !SLACK_TS.test(pointed.thread_ts) ||
        Number(pointed.thread_ts) > Number(root)
      )
        throw new StoreError('reference_thread_mismatch');
      root = pointed.thread_ts;
      first = await call('conversations.replies', {
        channel: target.channel,
        ts: root,
        limit: '20',
      });
    }
    const messages: unknown[] = [],
      seen = new Set<string>();
    let matched = Boolean(pointed),
      cursor = '',
      capped = false;
    for (let page = 0; page < 3; page++) {
      const data =
        page === 0
          ? first
          : await call('conversations.replies', {
              channel: target.channel,
              ts: root,
              limit: '20',
              cursor,
            });
      const rows = objects(data.messages);
      if (rows.length > 20) throw new StoreError('reference_page_limit');
      for (const row of rows) {
        if (
          typeof row.ts !== 'string' ||
          !SLACK_TS.test(row.ts) ||
          (row.ts !== root && row.thread_ts !== root)
        )
          throw new StoreError('reference_thread_mismatch');
        matched ||= row.ts === target.message_ts;
        if (inboxReference && row.ts === target.message_ts)
          return inboxResult(row);
        messages.push(referenceMessage(row));
      }
      const next = data.response_metadata
        ? object(data.response_metadata).next_cursor
        : '';
      if (
        next !== undefined &&
        (typeof next !== 'string' || next.length > 2000)
      )
        throw new StoreError('reference_invalid_cursor');
      cursor = typeof next === 'string' ? next : '';
      capped = Boolean(cursor) || data.has_more === true;
      if (!cursor) break;
      if (seen.has(cursor)) throw new StoreError('reference_invalid_cursor');
      seen.add(cursor);
    }
    if (inboxReference || !matched)
      throw new StoreError('reference_message_not_observed');
    return {
      workspace_id: this.task.inbox.workspace_id,
      channel_id: target.channel,
      thread_ts: root,
      messages,
      capped,
      coverage:
        'At most three 20-message pages from this exact thread. Attachments and further links are not fetched. This is a captured sample, not a live subscription; additional history may be unavailable.',
    };
  }
  readonly tool = {
    name: 'read_owner_reference',
    label: 'Read an owner-provided reference',
    description:
      'Read one reference from owner_references only. Read-only Slack thread, exact message in the bound inbox, or exact Pi-session text snapshot; no arbitrary URLs/paths, further links, session resume or external actions. Preserve coverage, redaction and source-claim limits.',
    parameters: Type.Object(
      {
        reference_id: Type.String(),
        offset: Type.Optional(Type.Integer({minimum: 0})),
      },
      {additionalProperties: false},
    ),
    execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
      this.store.assertOwner();
      const params = record(input);
      exactKeys(params, ['reference_id', 'offset']);
      const ref = this.refs.find(ref => ref.id === params.reference_id);
      if (!ref) throw new StoreError('owner_reference_not_authorized');
      const offset = params.offset ?? 0;
      if (
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        Number(offset) > 20000
      )
        throw new StoreError('invalid_reference_offset');
      await this.authorized(ref);
      const key = `${ref.id}:${offset}`;
      if (!this.pages.has(key) && this.pages.size >= 10)
        throw new StoreError('reference_read_budget');
      this.pages.add(key);
      let value: unknown;
      try {
        const scoped = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000);
        let pending = this.cache.get(ref.id);
        if (!pending) {
          pending =
            ref.target.kind === 'slack_thread'
              ? this.slack(ref.target, scoped)
              : readReferencedSession(
                  this.library,
                  ref.target.session_id,
                  scoped,
                );
          pending = pending.then(snapshot => ({
            ...snapshot,
            captured_at: new Date().toISOString(),
          }));
          this.cache.set(ref.id, pending);
        }
        const snapshot = await pending;
        scoped.throwIfAborted();
        await this.authorized(ref);
        const {messages, ...coverage} = snapshot;
        if (Number(offset) > messages.length)
          throw new StoreError('invalid_reference_offset');
        const end = Number(offset) + 10;
        value = {
          reference_id: ref.id,
          kind: ref.target.kind,
          ...coverage,
          offset,
          messages: messages.slice(Number(offset), end),
          total_messages: messages.length,
          next_offset: end < messages.length ? end : null,
          checked_at: new Date().toISOString(),
          untrusted_evidence: true,
        };
      } catch (error) {
        value = {
          reference_id: ref.id,
          kind: ref.target.kind,
          unavailable: true,
          error:
            error instanceof StoreError || error instanceof SlackError
              ? error.code
              : signal?.aborted
                ? 'cancelled'
                : 'reference_read_failed',
        };
      }
      this.store.assertOwner();
      await atomicJson(
        path.join(
          this.store.root,
          'runs',
          'evidence',
          this.task.id,
          `${Date.now()}-${digest(key).slice(0, 16)}-owner-reference.json`,
        ),
        value,
      );
      return {
        content: [{type: 'text' as const, text: JSON.stringify(value)}],
        details: {},
      };
    },
  };
}
