import path from 'node:path';
import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {literalMention, type DiscoveryOptions} from './discovery.ts';
import type {Receipt} from './intake.ts';
import type {AutoTrialState} from './auto-trial.ts';
import {
  absent,
  atomicJson,
  digest,
  exactKeys,
  inbox,
  readJson,
  record,
  source,
  sourceKey,
  StoreError,
  type Inbox,
  type Source,
  type TaskStore,
} from './store.ts';

interface Admission {
  source: Source;
  reserved_at: string;
}
interface State {
  schema_version: 1;
  approval: Record<string, unknown>;
  admissions: Admission[];
}
export interface RegularOptions {
  file: string;
  workers: number;
  provider: string;
  model: string;
  sessionLibrary?: string;
  conversation: string;
  discovery: DiscoveryOptions;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const key = (s: Source) =>
  `${s.workspace_id}:${s.channel_id}:${s.thread_ts ?? s.message_ts}`;
const id = (s: Source) => `task-${digest(sourceKey(s)).slice(0, 32)}`;
const validTime = (s: unknown): s is string =>
  typeof s === 'string' && Number.isFinite(Date.parse(s));

// An explicit operating-mode transition, never a renewed/deleted trial deadline.
export class RegularUse {
  private occupied = 0;
  private constructor(
    private store: TaskStore,
    private state: State,
    private original: AutoTrialState,
    private selected: Inbox,
  ) {}
  get ids() {
    return [
      ...this.original.admissions,
      ...this.state.admissions.map(a => a.source),
    ].map(id);
  }
  get approvalId() {
    return this.state.approval.id;
  }
  private get file() {
    return path.join(this.store.root, 'runs', 'regular-use.json');
  }
  private get scope() {
    return record(this.state.approval.scope);
  }
  get limits() {
    return {
      max_open_tasks: Number(this.scope.max_open_tasks),
      new_tasks_per_day: Number(this.scope.new_tasks_per_day),
    };
  }
  get usage() {
    return {
      ...this.limits,
      open_or_reserved: this.occupied,
      reserved_last_day: this.state.admissions.filter(
        a => Date.parse(a.reserved_at) >= Date.now() - 86400000,
      ).length,
    };
  }
  static async open(
    store: TaskStore,
    options: RegularOptions,
  ): Promise<RegularUse> {
    const originalFile = path.join(store.root, 'runs', 'auto-trial.json');
    const historyFile = path.join(
      store.root,
      'runs',
      'auto-trial-renewals.json',
    );
    const original = (await readJson(originalFile)) as AutoTrialState;
    const history = record(await readJson(historyFile));
    if (
      !original.closed_at ||
      !Array.isArray(history.windows) ||
      !history.windows.length ||
      history.windows.some(w => !record(record(w).state).closed_at)
    )
      throw new StoreError('regular_requires_closed_trial');
    const selected = inbox(await readJson(path.join(store.root, 'inbox.json')));
    const approval = record(await readJson(options.file));
    exactKeys(approval, [
      'schema_version',
      'id',
      'approved_at',
      'trial_hash',
      'history_hash',
      'scope',
      'tasks',
    ]);
    const scope = record(approval.scope);
    exactKeys(scope, [
      'root',
      'conversation',
      'group',
      'channel',
      'workers',
      'provider',
      'model',
      'session_library',
      'max_open_tasks',
      'new_tasks_per_day',
    ]);
    if (
      approval.schema_version !== 1 ||
      typeof approval.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        approval.id,
      ) ||
      !validTime(approval.approved_at) ||
      Date.parse(approval.approved_at) > Date.now() ||
      approval.trial_hash !== digest(JSON.stringify(original)) ||
      approval.history_hash !== digest(JSON.stringify(history)) ||
      !Array.isArray(approval.tasks) ||
      !approval.tasks.length ||
      approval.tasks.length !== original.admissions.length ||
      typeof scope.max_open_tasks !== 'number' ||
      typeof scope.new_tasks_per_day !== 'number' ||
      ![1, 2, 3].includes(Number(scope.max_open_tasks)) ||
      ![1, 2, 3, 4, 5].includes(Number(scope.new_tasks_per_day))
    )
      throw new StoreError('invalid_regular_approval');
    const expected = {
      root: store.root,
      conversation: options.conversation,
      group: options.discovery.mentionGroup,
      channel: options.discovery.watchChannel,
      workers: options.workers,
      provider: options.provider,
      model: options.model,
      session_library: path.resolve(
        options.sessionLibrary ?? path.join(getAgentDir(), 'sessions'),
      ),
      max_open_tasks: scope.max_open_tasks,
      new_tasks_per_day: scope.new_tasks_per_day,
    };
    if (
      !same(scope, expected) ||
      scope.conversation !== original.scope.conversation ||
      scope.group !== original.scope.group ||
      scope.channel !== original.scope.channel ||
      selected.channel_id !== scope.conversation
    )
      throw new StoreError('regular_scope_mismatch');
    let saved: State | undefined;
    try {
      saved = (await readJson(
        path.join(store.root, 'runs', 'regular-use.json'),
      )) as State;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const tasks = (await store.list()).sort((a, b) =>
      a.task.id.localeCompare(b.task.id),
    );
    const bindings = tasks.map(({task}) => ({
      task_id: task.id,
      session: task.session,
      parent_ts: task.slack.parent_ts,
      inbox: task.inbox,
      sources: task.sources,
    }));
    if (
      !saved &&
      (!same(bindings, approval.tasks) ||
        tasks.some(
          t =>
            !t.task.session.id ||
            !t.task.session.file ||
            !t.task.slack.parent_ts,
        ))
    )
      throw new StoreError('regular_task_mismatch');
    if (
      saved &&
      (saved.schema_version !== 1 ||
        !same(saved.approval, approval) ||
        !Array.isArray(saved.admissions))
    )
      throw new StoreError('regular_scope_mismatch');
    const state = saved ?? {
      schema_version: 1 as const,
      approval,
      admissions: [],
    };
    const seen = new Set(original.admissions.map(key));
    for (const entry of state.admissions) {
      source(entry.source);
      if (
        !validTime(entry.reserved_at) ||
        Date.parse(entry.reserved_at) <
          Date.parse(String(approval.approved_at)) ||
        seen.has(key(entry.source))
      )
        throw new StoreError('invalid_regular_state');
      seen.add(key(entry.source));
    }
    const result = new RegularUse(store, state, original, selected);
    await result.validate();
    if (!saved) {
      store.assertOwner();
      await atomicJson(result.file, state);
    }
    return result;
  }
  async validate(): Promise<void> {
    const tasks = await this.store.list();
    for (const {task} of tasks) {
      const src = [
        ...this.original.admissions,
        ...this.state.admissions.map(a => a.source),
      ].find(s => id(s) === task.id);
      const binding = (
        this.state.approval.tasks as Record<string, unknown>[]
      ).find(t => t.task_id === task.id);
      if (
        !src ||
        !same(task.inbox, this.selected) ||
        sourceKey(task.sources[0]) !== sourceKey(src) ||
        task.sources.some(s => key(s) !== key(src)) ||
        (binding &&
          (!same(task.session, binding.session) ||
            task.slack.parent_ts !== binding.parent_ts ||
            !same(task.sources, binding.sources)))
      )
        throw new StoreError('regular_task_mismatch');
    }
    if (
      (this.state.approval.tasks as Record<string, unknown>[]).some(
        t => !tasks.some(x => x.task.id === t.task_id),
      )
    )
      throw new StoreError('regular_task_mismatch');
    this.occupied =
      tasks.filter(t => t.status !== 'done').length +
      this.state.admissions.filter(
        a => !tasks.some(t => t.task.id === id(a.source)),
      ).length;
  }
  eligible(receipt: Receipt, selected: Inbox, related: boolean): boolean {
    if (
      !same(selected, this.selected) ||
      receipt.source.workspace_id !== selected.workspace_id ||
      this.original.scope.excluded.includes(key(receipt.source))
    )
      return false;
    if (related) return true;
    const reserved = [
      ...this.original.admissions,
      ...this.state.admissions.map(a => a.source),
    ].find(s => key(s) === key(receipt.source));
    if (reserved) return sourceKey(reserved) === sourceKey(receipt.source);
    if (
      this.occupied >= this.limits.max_open_tasks ||
      this.usage.reserved_last_day >= this.limits.new_tasks_per_day ||
      Number(receipt.source.message_ts) * 1000 <
        Date.parse(String(this.state.approval.approved_at))
    )
      return false;
    return (
      (receipt.kind === 'mention' &&
        literalMention(
          receipt.text,
          selected.owner_user_id,
          this.original.scope.group,
          receipt.content_source ?? 'search',
        )) ||
      (receipt.kind === 'channel_thread' &&
        receipt.source.channel_id === this.original.scope.channel &&
        (receipt.source.thread_ts ?? receipt.source.message_ts) ===
          receipt.source.message_ts) ||
      (receipt.kind === 'direct' &&
        receipt.content_source === 'conversation' &&
        receipt.author_id === selected.owner_user_id &&
        receipt.source.channel_id === selected.channel_id &&
        (!receipt.source.thread_ts ||
          receipt.source.thread_ts === receipt.source.message_ts))
    );
  }
  async reserve(receipt: Receipt): Promise<void> {
    const reserved = [
      ...this.original.admissions,
      ...this.state.admissions.map(a => a.source),
    ].find(s => key(s) === key(receipt.source));
    if (reserved) {
      if (sourceKey(reserved) !== sourceKey(receipt.source))
        throw new StoreError('regular_source_mismatch');
      return;
    }
    await this.validate();
    if (!this.eligible(receipt, this.selected, false))
      throw new StoreError('regular_capacity_or_scope');
    this.state.admissions.push({
      source: source(receipt.source),
      reserved_at: new Date().toISOString(),
    });
    this.store.assertOwner();
    await atomicJson(this.file, this.state);
    this.occupied++;
  }
}
