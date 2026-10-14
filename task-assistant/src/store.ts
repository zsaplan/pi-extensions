import {createHash, randomUUID} from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

export const STATUSES = [
  'queued',
  'active',
  'waiting',
  'review',
  'done',
] as const;
export type Status = (typeof STATUSES)[number];
export interface Source {
  workspace_id: string;
  channel_id: string;
  message_ts: string;
  thread_ts?: string;
}
export interface Inbox {
  workspace_id: string;
  channel_id: string;
  owner_user_id: string;
  bot_user_id: string;
}
export interface EnqueueInput {
  request: string;
  outcome: string;
  sources: Source[];
  inbox: Inbox;
}
export interface Task extends EnqueueInput {
  schema_version: 1;
  id: string;
  created_at: string;
  updated_at: string;
  latest_update: string;
  next_action: string;
  pending_question: string | null;
  slack: {parent_ts: string | null};
  session: {id: string | null; file: string | null};
  // Optional for legacy records; binds recovery to this claim, not an older settled run.
  claim_id?: string;
}
export interface LocatedTask {
  task: Task;
  status: Status;
  directory: string;
}
export class StoreError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const SLACK_ID = /^[CDG][A-Z0-9]+$/;
export const SLACK_TS = /^\d{10,16}\.\d{6}$/;
const TASK_ID = /^task-[a-f0-9]{32}$/;

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StoreError('invalid_input');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new StoreError('invalid_input');
  return value;
}
export function identifier(value: unknown, pattern: RegExp): string {
  const result = string(value, 100);
  if (!pattern.test(result)) throw new StoreError('invalid_input');
  return result;
}
export function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
): void {
  if (Object.keys(value).some(key => !keys.includes(key)))
    throw new StoreError('invalid_input');
}
export function source(value: unknown): Source {
  const input = record(value);
  exactKeys(input, ['workspace_id', 'channel_id', 'message_ts', 'thread_ts']);
  const result: Source = {
    workspace_id: identifier(input.workspace_id, /^T[A-Z0-9]+$/),
    channel_id: identifier(input.channel_id, SLACK_ID),
    message_ts: identifier(input.message_ts, SLACK_TS),
  };
  if (input.thread_ts !== undefined) {
    result.thread_ts = identifier(input.thread_ts, SLACK_TS);
    if (Number(result.thread_ts) > Number(result.message_ts))
      throw new StoreError('invalid_input');
  }
  return result;
}
export function inbox(value: unknown): Inbox {
  const input = record(value);
  exactKeys(input, [
    'workspace_id',
    'channel_id',
    'owner_user_id',
    'bot_user_id',
  ]);
  const result = {
    workspace_id: identifier(input.workspace_id, /^T[A-Z0-9]+$/),
    channel_id: identifier(input.channel_id, /^D[A-Z0-9]+$/),
    owner_user_id: identifier(input.owner_user_id, /^[UW][A-Z0-9]+$/),
    bot_user_id: identifier(input.bot_user_id, /^[UW][A-Z0-9]+$/),
  };
  if (result.owner_user_id === result.bot_user_id)
    throw new StoreError('invalid_input');
  return result;
}
export function enqueueInput(value: unknown): EnqueueInput {
  const input = record(value);
  exactKeys(input, ['request', 'outcome', 'sources', 'inbox']);
  if (
    !Array.isArray(input.sources) ||
    !input.sources.length ||
    input.sources.length > 100
  )
    throw new StoreError('invalid_input');
  const result = {
    request: string(input.request),
    outcome: string(input.outcome),
    sources: input.sources.map(source),
    inbox: inbox(input.inbox),
  };
  if (
    result.sources.some(
      item => item.workspace_id !== result.inbox.workspace_id,
    ) ||
    new Set(result.sources.map(sourceKey)).size !== result.sources.length
  )
    throw new StoreError('invalid_input');
  return result;
}
export function sourceKey(value: Source): string {
  return `${value.workspace_id}:${value.channel_id}:${value.message_ts}`;
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export async function atomicJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  const directory = await open(path.dirname(file), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
// One process owns the root; intake and the work lane still need atomic read/modify/write transactions.
const jsonUpdates = new Map<string, Promise<void>>();
export async function updateJson(
  file: string,
  change: (current: unknown | undefined) => unknown | undefined,
): Promise<boolean> {
  const key = path.resolve(file);
  const previous = jsonUpdates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => {
    release = resolve;
  });
  jsonUpdates.set(key, tail);
  await previous;
  try {
    let current: unknown;
    try {
      current = await readJson(file);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const next = change(current);
    if (next === undefined) return false;
    await atomicJson(file, next);
    return true;
  } finally {
    release();
    if (jsonUpdates.get(key) === tail) jsonUpdates.delete(key);
  }
}
export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
export function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export class TaskStore {
  private compromised = false;
  private closed = false;
  private release: () => Promise<void> = async () => {};
  private catalogTail: Promise<unknown> = Promise.resolve();
  private catalog<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.catalogTail.then(operation);
    this.catalogTail = next.catch(() => {});
    return next;
  }
  private constructor(readonly root: string) {}

  static async acquire(root: string): Promise<TaskStore> {
    const store = new TaskStore(path.resolve(root));
    await mkdir(store.root, {recursive: true, mode: 0o700});
    try {
      store.release = await lockfile.lock(store.root, {
        stale: 10000,
        update: 2000,
        retries: {
          retries: 12,
          minTimeout: 1000,
          maxTimeout: 1000,
          randomize: false,
        },
        onCompromised: () => {
          store.compromised = true;
        },
      });
      for (const directory of [
        ...STATUSES,
        'staging',
        'sessions',
        'runs',
        'intake',
      ]) {
        await mkdir(path.join(store.root, directory), {
          recursive: true,
          mode: 0o700,
        });
      }
      // Unpublished drafts are never tasks. Clear only our staging area under the lock.
      for (const entry of await readdir(path.join(store.root, 'staging'))) {
        await rm(path.join(store.root, 'staging', entry), {
          recursive: true,
          force: true,
        });
      }
      return store;
    } catch (error) {
      await store.release().catch(() => {});
      throw new StoreError(
        (error as NodeJS.ErrnoException).code === 'ELOCKED'
          ? 'store_locked'
          : 'store_unavailable',
      );
    }
  }
  assertOwner(): void {
    if (this.compromised || this.closed)
      throw new StoreError('store_ownership_lost');
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.release();
  }
  list(): Promise<LocatedTask[]> {
    return this.catalog(() => this.snapshot());
  }
  private async snapshot(): Promise<LocatedTask[]> {
    this.assertOwner();
    const found: LocatedTask[] = [];
    const ids = new Set<string>();
    for (const status of STATUSES) {
      for (const entry of await readdir(path.join(this.root, status), {
        withFileTypes: true,
      })) {
        if (
          !entry.isDirectory() ||
          !TASK_ID.test(entry.name) ||
          ids.has(entry.name)
        )
          throw new StoreError('invalid_store');
        const directory = path.join(this.root, status, entry.name);
        const task = record(
          await readJson(path.join(directory, 'task.json')),
        ) as unknown as Task;
        if (
          task.schema_version !== 1 ||
          task.id !== entry.name ||
          'status' in task
        )
          throw new StoreError('invalid_store');
        enqueueInput({
          request: task.request,
          outcome: task.outcome,
          sources: task.sources,
          inbox: task.inbox,
        });
        found.push({task, status, directory});
        ids.add(task.id);
      }
    }
    return found;
  }
  async locate(id: string): Promise<LocatedTask> {
    identifier(id, TASK_ID);
    const found = (await this.list()).find(item => item.task.id === id);
    if (!found) throw new StoreError('task_not_found');
    return found;
  }
  // Selection and rename share the catalog lock; a task can have only one worker.
  claimQueued(id: string): Promise<LocatedTask | undefined> {
    identifier(id, TASK_ID);
    return this.catalog(async () => {
      const item = (await this.snapshot()).find(
        item => item.task.id === id && item.status === 'queued',
      );
      if (!item) return undefined;
      const directory = path.join(this.root, 'active', id);
      this.assertOwner();
      item.task.claim_id = randomUUID();
      item.task.updated_at = new Date().toISOString();
      await atomicJson(path.join(item.directory, 'task.json'), item.task);
      await rename(item.directory, directory);
      return {...item, status: 'active', directory};
    });
  }
  async enqueue(
    value: unknown,
  ): Promise<{result: 'created' | 'existing'; item: LocatedTask}> {
    this.assertOwner();
    const input = enqueueInput(value);
    const keys = new Set(input.sources.map(sourceKey));
    const existing = (await this.list()).filter(item =>
      item.task.sources.some(item => keys.has(sourceKey(item))),
    );
    if (existing.length > 1) throw new StoreError('source_conflict');
    if (existing.length) {
      const item = existing[0];
      if (JSON.stringify(item.task.inbox) !== JSON.stringify(input.inbox))
        throw new StoreError('inbox_conflict');
      // Attach additional source identities before returning, so replay can deduplicate any alias.
      const seen = new Set(item.task.sources.map(sourceKey));
      item.task.sources.push(
        ...input.sources.filter(item => !seen.has(sourceKey(item))),
      );
      await this.save(item.task);
      return {result: 'existing', item};
    }
    const id = `task-${digest(sourceKey(input.sources[0])).slice(0, 32)}`;
    const now = new Date().toISOString();
    const task: Task = {
      schema_version: 1,
      id,
      created_at: now,
      updated_at: now,
      ...input,
      latest_update: 'Queued for investigation.',
      next_action: 'Investigate the request.',
      pending_question: null,
      slack: {parent_ts: null},
      session: {id: null, file: null},
    };
    const stage = path.join(this.root, 'staging', `${id}-${randomUUID()}`);
    await mkdir(path.join(stage, 'artifacts'), {recursive: true, mode: 0o700});
    await atomicJson(path.join(stage, 'task.json'), task);
    for (const file of ['plan.md', 'evidence.md', 'handoffs.md']) {
      await writeFile(
        path.join(stage, file),
        `# ${file.replace('.md', '')}\n`,
        {mode: 0o600},
      );
    }
    this.assertOwner();
    const directory = path.join(this.root, 'queued', id);
    await this.catalog(async () => {
      this.assertOwner();
      await rename(stage, directory);
    });
    return {result: 'created', item: {task, status: 'queued', directory}};
  }
  async save(task: Task): Promise<void> {
    this.assertOwner();
    const item = await this.locate(task.id);
    if ('status' in task) throw new StoreError('invalid_input');
    enqueueInput({
      request: task.request,
      outcome: task.outcome,
      sources: task.sources,
      inbox: task.inbox,
    });
    task.updated_at = new Date().toISOString();
    await atomicJson(path.join(item.directory, 'task.json'), task);
  }
  async move(id: string, status: Status): Promise<LocatedTask> {
    this.assertOwner();
    if (!STATUSES.includes(status)) throw new StoreError('invalid_input');
    const item = await this.locate(id);
    if (item.status !== status) {
      const directory = path.join(this.root, status, id);
      await this.catalog(async () => {
        this.assertOwner();
        await rename(item.directory, directory);
      });
      return {...item, status, directory};
    }
    return item;
  }
  async append(
    id: string,
    filename: 'evidence.md' | 'handoffs.md',
    text: string,
  ): Promise<void> {
    const item = await this.locate(id);
    const file = await open(path.join(item.directory, filename), 'a', 0o600);
    try {
      await file.writeFile(text + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
