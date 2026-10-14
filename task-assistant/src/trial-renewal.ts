import path from 'node:path';
import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {
  absent,
  atomicJson,
  digest,
  exactKeys,
  readJson,
  record,
  StoreError,
  type TaskStore,
} from './store.ts';
import type {AutoTrialState} from './auto-trial.ts';

export interface RenewalRequest {
  file: string;
  workers: number;
  sessionLibrary?: string;
}
interface Window {
  approval: Record<string, unknown>;
  state: AutoTrialState;
}
interface History {
  schema_version: 1;
  windows: Window[];
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// A new approval appends a new window. The original closed ledger is never edited.
// Reusing an approval resumes only its existing, unexpired window after a crash.
export class TrialRenewal {
  private constructor(
    private store: TaskStore,
    private history: History,
  ) {}
  get state() {
    return this.history.windows.at(-1)!.state;
  }
  get id() {
    return String(this.history.windows.at(-1)!.approval.id);
  }
  private get file() {
    return path.join(this.store.root, 'runs', 'auto-trial-renewals.json');
  }
  static async open(
    store: TaskStore,
    original: AutoTrialState,
    request: RenewalRequest,
  ): Promise<TrialRenewal> {
    if (!original.closed_at)
      throw new StoreError('renewal_requires_closed_trial');
    const tasks = (await store.list()).sort((a, b) =>
      a.task.id.localeCompare(b.task.id),
    );
    if (
      !tasks.length ||
      tasks.length !== original.admissions.length ||
      tasks.some(
        ({task}) =>
          !task.slack.parent_ts || !task.session.id || !task.session.file,
      )
    )
      throw new StoreError('renewal_requires_published_tasks');
    const bindings = tasks.map(({task}) => ({
      task_id: task.id,
      session: task.session,
      parent_ts: task.slack.parent_ts,
      inbox: task.inbox,
      sources: task.sources,
    }));
    const scope = {
      root: store.root,
      seconds: original.scope.seconds,
      workers: request.workers,
      session_library: path.resolve(
        request.sessionLibrary ?? path.join(getAgentDir(), 'sessions'),
      ),
      tasks: bindings,
    };
    const approval = record(await readJson(request.file));
    const validateApproval = (value: Record<string, unknown>) => {
      exactKeys(value, [
        'schema_version',
        'id',
        'previous_window_hash',
        'scope',
        'approved_at',
      ]);
      if (
        value.schema_version !== 1 ||
        typeof value.id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          value.id,
        ) ||
        typeof value.previous_window_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.previous_window_hash) ||
        typeof value.approved_at !== 'string' ||
        !Number.isFinite(Date.parse(value.approved_at)) ||
        Date.parse(value.approved_at) > Date.now() ||
        !same(value.scope, scope)
      )
        throw new StoreError('invalid_trial_renewal');
    };
    validateApproval(approval);
    let history: History;
    try {
      history = (await readJson(
        path.join(store.root, 'runs', 'auto-trial-renewals.json'),
      )) as History;
    } catch (error) {
      if (!absent(error)) throw error;
      history = {schema_version: 1, windows: []};
    }
    if (
      history.schema_version !== 1 ||
      !Array.isArray(history.windows) ||
      history.windows.length > 100
    )
      throw new StoreError('invalid_trial_renewal_history');
    const ids = new Set<string>();
    let previous = original;
    for (const window of history.windows) {
      const state = window.state;
      validateApproval(window.approval);
      if (
        !previous.closed_at ||
        ids.has(String(window.approval.id)) ||
        window.approval.previous_window_hash !==
          digest(JSON.stringify(previous)) ||
        state.schema_version !== 1 ||
        !same(state.scope, original.scope) ||
        !same(state.admissions, original.admissions) ||
        !Number.isFinite(Date.parse(state.started_at)) ||
        Date.parse(state.expires_at) - Date.parse(state.started_at) !==
          original.scope.seconds * 1000 ||
        Date.parse(state.started_at) < Date.parse(previous.closed_at) ||
        (state.closed_at !== undefined &&
          (!Number.isFinite(Date.parse(state.closed_at)) ||
            Date.parse(state.closed_at) < Date.parse(state.started_at)))
      )
        throw new StoreError('invalid_trial_renewal_history');
      ids.add(String(window.approval.id));
      previous = state;
    }
    const existing = history.windows.find(
      window => window.approval.id === approval.id,
    );
    if (existing) {
      if (
        existing !== history.windows.at(-1) ||
        existing.state.closed_at ||
        Date.now() >= Date.parse(existing.state.expires_at)
      )
        throw new StoreError('auto_trial_closed');
      if (!same(existing.approval, approval))
        throw new StoreError('invalid_trial_renewal');
    } else {
      if (
        !previous.closed_at ||
        approval.previous_window_hash !== digest(JSON.stringify(previous)) ||
        history.windows.length >= 100
      )
        throw new StoreError('renewal_requires_latest_closed_window');
      const now = Date.now();
      history.windows.push({
        approval,
        state: {
          schema_version: 1,
          scope: original.scope,
          admissions: original.admissions,
          started_at: new Date(now).toISOString(),
          expires_at: new Date(
            now + original.scope.seconds * 1000,
          ).toISOString(),
        },
      });
      store.assertOwner();
      await atomicJson(
        path.join(store.root, 'runs', 'auto-trial-renewals.json'),
        history,
      );
    }
    return new TrialRenewal(store, history);
  }
  async close() {
    this.store.assertOwner();
    this.state.closed_at = new Date().toISOString();
    await atomicJson(this.file, this.history);
  }
}
