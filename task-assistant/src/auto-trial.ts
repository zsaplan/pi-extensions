import path from 'node:path';
import {literalMention, type DiscoveryOptions} from './discovery.ts';
import type {Receipt} from './intake.ts';
import {TrialRenewal, type RenewalRequest} from './trial-renewal.ts';
import {
  absent,
  atomicJson,
  digest,
  readJson,
  source,
  sourceKey,
  StoreError,
  type Inbox,
  type Source,
  type TaskStore,
} from './store.ts';

const filename = (store: TaskStore) =>
  path.join(store.root, 'runs', 'auto-trial.json');
const threadKey = (value: Source) =>
  `${value.workspace_id}:${value.channel_id}:${value.thread_ts ?? value.message_ts}`;
const taskId = (value: Source) =>
  `task-${digest(sourceKey(value)).slice(0, 32)}`;
export interface AutoTrialState {
  schema_version: 1;
  scope: {
    limit: number;
    seconds: number;
    conversation: string;
    group: string;
    channel: string;
    excluded: string[];
  };
  started_at: string;
  expires_at: string;
  admissions: Source[];
  closed_at?: string;
}

export async function requireAutoTrialScope(
  store: TaskStore,
  enabled: boolean,
  regular = false,
): Promise<void> {
  try {
    await readJson(path.join(store.root, 'runs', 'regular-use.json'));
    if (!regular) throw new StoreError('regular_use_scope_required');
  } catch (error) {
    if (!absent(error)) throw error;
  }
  try {
    await readJson(filename(store));
    if (!enabled && !regular) throw new StoreError('auto_trial_scope_required');
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

// Reservations precede enqueue: a crash cannot replenish the total task budget.
// Only the coordinator writes this ledger; intake never admits work.
export class AutoTrial {
  private constructor(
    private store: TaskStore,
    readonly state: AutoTrialState,
    private renewal?: TrialRenewal,
  ) {}
  get continuationId(): string | undefined {
    return this.renewal?.id;
  }
  get ids(): string[] {
    return this.state.admissions.map(taskId);
  }
  static async open(
    store: TaskStore,
    limit: number,
    seconds: number,
    conversation: string,
    discovery: DiscoveryOptions,
    excludedFile: string,
    renewal?: RenewalRequest,
  ): Promise<AutoTrial> {
    const raw = await readJson(excludedFile);
    if (!Array.isArray(raw) || raw.length > 100)
      throw new StoreError('invalid_excluded_threads');
    const scope: AutoTrialState['scope'] = {
      limit,
      seconds,
      conversation,
      group: discovery.mentionGroup!,
      channel: discovery.watchChannel!,
      excluded: [...new Set(raw.map(value => threadKey(source(value))))].sort(),
    };
    let saved: AutoTrialState;
    try {
      saved = (await readJson(filename(store))) as AutoTrialState;
      if (
        saved.schema_version !== 1 ||
        JSON.stringify(saved.scope) !== JSON.stringify(scope) ||
        !Array.isArray(saved.admissions) ||
        saved.admissions.length > limit ||
        !Number.isFinite(Date.parse(saved.started_at)) ||
        Date.parse(saved.expires_at) - Date.parse(saved.started_at) !==
          seconds * 1000
      )
        throw new StoreError('auto_trial_scope_mismatch');
      saved.admissions = saved.admissions.map(source);
      if (
        new Set(saved.admissions.map(threadKey)).size !==
        saved.admissions.length
      )
        throw new StoreError('auto_trial_scope_mismatch');
      if (renewal) {
        const original = new AutoTrial(store, saved);
        await original.validate();
        const window = await TrialRenewal.open(store, saved, renewal);
        return new AutoTrial(store, window.state, window);
      }
      if (saved.closed_at || Date.now() >= Date.parse(saved.expires_at))
        throw new StoreError('auto_trial_closed');
    } catch (error) {
      if (!absent(error)) throw error;
      if (renewal) throw new StoreError('renewal_requires_closed_trial');
      if ((await store.list()).length)
        throw new StoreError('auto_trial_requires_fresh_root');
      for (const file of [
        'inbox.json',
        'runs/pilot.json',
        'intake/discovery.json',
      ]) {
        try {
          await readJson(path.join(store.root, file));
          throw new StoreError('auto_trial_requires_fresh_root');
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
      const now = Date.now();
      saved = {
        schema_version: 1,
        scope,
        started_at: new Date(now).toISOString(),
        expires_at: new Date(now + seconds * 1000).toISOString(),
        admissions: [],
      };
      await atomicJson(filename(store), saved);
    }
    const trial = new AutoTrial(store, saved);
    await trial.validate();
    return trial;
  }
  async validate(): Promise<void> {
    for (const item of await this.store.list()) {
      const original = this.state.admissions.find(
        value => taskId(value) === item.task.id,
      );
      if (
        !original ||
        item.task.inbox.channel_id !== this.state.scope.conversation ||
        sourceKey(item.task.sources[0]) !== sourceKey(original) ||
        item.task.sources.some(
          value => threadKey(value) !== threadKey(original),
        )
      )
        throw new StoreError('auto_trial_task_mismatch');
    }
  }
  eligible(receipt: Receipt, selected: Inbox, related: boolean): boolean {
    if (
      receipt.source.workspace_id !== selected.workspace_id ||
      this.state.scope.excluded.includes(threadKey(receipt.source))
    )
      return false;
    if (related) return true;
    if (this.renewal) return false;
    const reserved = this.state.admissions.find(
      value => threadKey(value) === threadKey(receipt.source),
    );
    if (reserved) return sourceKey(reserved) === sourceKey(receipt.source);
    if (
      this.ids.length >= this.state.scope.limit ||
      receipt.source.channel_id === selected.channel_id
    )
      return false;
    return (
      (receipt.kind === 'mention' &&
        literalMention(
          receipt.text,
          selected.owner_user_id,
          this.state.scope.group,
          receipt.content_source ?? 'search',
        )) ||
      (receipt.kind === 'channel_thread' &&
        receipt.source.channel_id === this.state.scope.channel &&
        (receipt.source.thread_ts ?? receipt.source.message_ts) ===
          receipt.source.message_ts &&
        Number(receipt.source.message_ts) * 1000 >=
          Date.parse(this.state.started_at))
    );
  }
  async reserve(receipt: Receipt): Promise<void> {
    const existing = this.state.admissions.find(
      value => threadKey(value) === threadKey(receipt.source),
    );
    if (existing) {
      if (sourceKey(existing) !== sourceKey(receipt.source))
        throw new StoreError('auto_trial_source_mismatch');
      return;
    }
    if (this.renewal) throw new StoreError('renewal_no_new_tasks');
    if (this.ids.length >= this.state.scope.limit)
      throw new StoreError('auto_trial_capacity');
    this.state.admissions.push(source(receipt.source));
    this.store.assertOwner();
    await atomicJson(filename(this.store), this.state);
  }
  async close(): Promise<void> {
    if (this.renewal) return this.renewal.close();
    this.state.closed_at = new Date().toISOString();
    this.store.assertOwner();
    await atomicJson(filename(this.store), this.state);
  }
}
