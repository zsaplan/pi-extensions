import path from 'node:path';
import {lstat} from 'node:fs/promises';
import {
  absent,
  atomicJson,
  digest,
  exactKeys,
  readJson,
  record,
  StoreError,
  type LocatedTask,
  type Status,
  type TaskStore,
} from './store.ts';
import {publicAnswer} from './public-answer.ts';

export interface CardCopy {
  title: string;
  summary: string;
  next: string | null;
}
export function cardCopy(value: unknown): CardCopy {
  const data = record(value);
  exactKeys(data, ['title', 'summary', 'next']);
  const title = publicAnswer(data.title, 72);
  if (/[\r\n]/.test(title)) throw new StoreError('invalid_card_title');
  return {
    title,
    summary: publicAnswer(data.summary, 700),
    next: data.next === null ? null : publicAnswer(data.next, 400),
  };
}
// Presentation is never task state or approval. A new claim invalidates old copy,
// even when its summary happens to be identical.
export function cardBasis({task, status}: LocatedTask): string {
  return digest(
    JSON.stringify([
      task.id,
      task.claim_id,
      task.session.id,
      task.inbox,
      status,
      task.request,
      task.outcome,
      task.latest_update,
      task.next_action,
      task.pending_question,
      task.sources,
    ]),
  );
}
export const cardFile = (root: string, id: string) =>
  path.join(root, 'runs', 'cards', id + '.json');
export async function saveCardCopy(
  store: TaskStore,
  id: string,
  copy: CardCopy,
): Promise<void> {
  store.assertOwner();
  const item = await store.locate(id);
  await atomicJson(cardFile(store.root, id), {
    schema_version: 1,
    basis: cardBasis(item),
    copy: cardCopy(copy),
  });
}
export async function readCardCopy(
  root: string,
  item: LocatedTask,
): Promise<CardCopy | undefined> {
  const file = cardFile(root, item.task.id);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 16384)
      throw new StoreError('invalid_card_copy');
    const data = record(await readJson(file));
    exactKeys(data, ['schema_version', 'basis', 'copy']);
    if (data.schema_version !== 1) throw new StoreError('invalid_card_copy');
    if (data.basis !== cardBasis(item)) return undefined;
    return cardCopy(data.copy);
  } catch (error) {
    if (!absent(error)) throw error;
    return undefined;
  }
}
export function cardStatus(status: Status): {icon: string; label: string} {
  return {
    queued: {icon: '🟦', label: 'Queued'},
    active: {icon: '🔵', label: 'In progress'},
    waiting: {icon: '🟠', label: 'Waiting'},
    review: {icon: '🟣', label: 'Review'},
    done: {icon: '✅', label: 'Task closed'},
  }[status];
}
