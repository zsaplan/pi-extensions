import process from 'node:process';
import {STATUSES, StoreError, TaskStore, type Status} from './store.ts';

export function options(
  args: string[],
  allowed: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    const value = args[++index];
    if (
      !allowed.includes(key) ||
      result.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new StoreError('invalid_arguments');
    result.set(key, value);
  }
  return result;
}
export function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new StoreError('invalid_arguments');
  return value;
}
export async function inputJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 65536) throw new StoreError('input_too_large');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new StoreError('invalid_json');
  }
}
export function output(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}
export async function queueCommand(
  command: string,
  args: string[],
): Promise<void> {
  const values = options(
    args,
    command === 'move' ? ['--root', '--task-id', '--status'] : ['--root'],
  );
  const root = required(values, '--root');
  // Read and validate input before taking the coordinator lock.
  const input = command === 'enqueue' ? await inputJson() : undefined;
  const store = await TaskStore.acquire(root);
  try {
    if (command === 'enqueue') {
      const {result, item} = await store.enqueue(input);
      output({
        schema_version: 1,
        result,
        task_id: item.task.id,
        status: item.status,
        task_path: item.directory,
      });
    } else if (command === 'list') {
      output({
        schema_version: 1,
        tasks: (await store.list()).map(item => ({
          task_id: item.task.id,
          status: item.status,
          task_path: item.directory,
        })),
      });
    } else {
      const status = required(values, '--status');
      if (!STATUSES.includes(status as Status))
        throw new StoreError('invalid_arguments');
      const item = await store.move(
        required(values, '--task-id'),
        status as Status,
      );
      output({
        schema_version: 1,
        task_id: item.task.id,
        status: item.status,
        task_path: item.directory,
      });
    }
  } finally {
    await store.close();
  }
}
