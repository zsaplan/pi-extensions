import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {
  absent,
  readJson,
  record,
  SLACK_TS,
  StoreError,
  type Task,
  type TaskStore,
} from './store.ts';
import type {Receipt} from './intake.ts';
import type {JsonObject} from './slack.ts';

export function isReviewerResult(task: Task, receipt: Receipt): boolean {
  return (
    receipt.evidence_kind === 'reviewer_result' &&
    receipt.content_source === 'conversation' &&
    receipt.kind === 'task_reply' &&
    receipt.author_id === task.inbox.bot_user_id &&
    receipt.source.workspace_id === task.inbox.workspace_id &&
    receipt.source.channel_id === task.inbox.channel_id &&
    Boolean(task.slack.parent_ts) &&
    receipt.source.thread_ts === task.slack.parent_ts
  );
}

// The shared bot identity is not proof that this coordinator sent a message.
// Read durable intents AFTER observing Slack: a post must have an intent before sending.
// Unknown same-bot messages wait while a send is uncertain; never guess across that race.
export async function reviewerDisposition(
  store: TaskStore,
  task: Task,
  message: JsonObject,
): Promise<'own_bot' | 'assistant_delivery_pending' | undefined> {
  const directory = path.join(store.root, 'runs', 'slack');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (!absent(error)) throw error;
    files = [];
  }
  const selected = files.filter(
    file =>
      file.startsWith(`${task.id}-`) &&
      file.endsWith('.json') &&
      file !== `${task.id}-render.json`,
  );
  if (selected.length > 5000) throw new StoreError('handoff_intent_limit');
  let uncertain = false;
  for (const file of selected) {
    const intent = record(await readJson(path.join(directory, file)));
    if (
      intent.schema_version !== 1 ||
      intent.task_id !== task.id ||
      intent.channel !== task.inbox.channel_id ||
      typeof intent.id !== 'string' ||
      !intent.id ||
      typeof intent.text !== 'string' ||
      !['prepared', 'sending', 'sent'].includes(String(intent.phase)) ||
      (intent.phase === 'sent' &&
        (typeof intent.message_ts !== 'string' ||
          !SLACK_TS.test(intent.message_ts)))
    )
      throw new StoreError('invalid_handoff_intent');
    if (intent.thread_ts !== task.slack.parent_ts) continue;
    if (
      intent.message_ts === message.ts ||
      (typeof message.client_msg_id === 'string' &&
        message.client_msg_id === intent.id)
    )
      return 'own_bot';
    if (intent.phase === 'sending') {
      if (intent.text === message.text) return 'own_bot';
      uncertain = true;
    }
  }
  return uncertain ? 'assistant_delivery_pending' : undefined;
}
