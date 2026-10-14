import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {
  ReadonlySlackClient,
  SlackError,
  object,
  objects,
  extendCooldown,
} from './slack.ts';
import {
  absent,
  atomicJson,
  digest,
  identifier,
  readJson,
  SLACK_TS,
  StoreError,
  TaskStore,
  type LocatedTask,
} from './store.ts';
import type {TaskCommunication} from './worker.ts';
import {publicAnswer} from './public-answer.ts';
import {escapeSlack, SlackPresentation} from './slack-presentation.ts';

interface PostIntent {
  schema_version: 1;
  id: string;
  phase: 'prepared' | 'sending' | 'sent';
  task_id: string;
  channel: string;
  thread_ts?: string;
  text: string;
  created_at: string;
  message_ts?: string;
  // Freeze the rendered body, but reject a different logical answer under the same key.
  input_hash?: string;
}
// Parent summaries are bounded, but a clipped URL must never become a different link.
function parentExcerpt(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  let end = maximum;
  for (const token of text.matchAll(
    /<[^<>\n]*>|\[[^\]\n]+\]\(https?:\/\/[^)\s<>]+\)|https?:\/\/[^\s<>]+/g,
  )) {
    if (token.index < end && token.index + token[0].length > end)
      end = token.index;
  }
  for (const word of text.matchAll(/\S+/g)) {
    if (word.index < end && word.index + word[0].length > end) end = word.index;
  }
  return text.slice(0, end).trimEnd() + '…';
}
function parentText(
  item: LocatedTask,
  presentation: SlackPresentation,
): Promise<string> {
  const {task, status} = item;
  return presentation.render(
    [
      `*Task ${task.id}*`,
      `*Status:* ${status}`,
      `*Request:* ${parentExcerpt(task.request, 400)}`,
      `*Outcome:* ${parentExcerpt(task.outcome, 300)}`,
      `*Latest:* ${parentExcerpt(task.latest_update, 700)}`,
      `*Next:* ${parentExcerpt(task.next_action, 300)}`,
      `*Needed input:* ${parentExcerpt(task.pending_question ?? 'None', 500)}`,
      `*Sources:* ${task.sources
        .slice(0, 3)
        .map(s => presentation.sourceLink(s))
        .join(', ')}`,
      `*Pi session:* ${task.session.id ?? 'Not started'}`,
    ].join('\n'),
    task.sources,
  );
}
export class TaskMessenger implements TaskCommunication {
  private verified = new Map<string, SlackPresentation>();
  private tail: Promise<unknown> = Promise.resolve();
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }
  private reads: ReadonlySlackClient;
  constructor(
    private store: TaskStore,
    private tokens: {user: string; bot: string},
    private allowWrites: boolean,
  ) {
    this.reads = new ReadonlySlackClient(
      tokens,
      path.join(store.root, 'runs', 'slack', 'cooldowns.json'),
    );
  }
  private async destination(taskId: string): Promise<LocatedTask> {
    this.store.assertOwner();
    if (!this.allowWrites) throw new StoreError('slack_approval_required');
    const item = await this.store.locate(taskId);
    if (!item.task.session.id)
      throw new StoreError('session_required_before_posting');
    const selected = item.task.inbox;
    const binding = JSON.stringify(selected);
    if (!this.verified.has(binding)) {
      const bot = await this.reads.call('bot', 'auth.test');
      const info = object(
        (
          await this.reads.call('bot', 'conversations.info', {
            channel: selected.channel_id,
          })
        ).channel,
      );
      if (
        bot.team_id !== selected.workspace_id ||
        bot.user_id !== selected.bot_user_id ||
        info.id !== selected.channel_id ||
        info.is_im !== true ||
        info.user !== selected.owner_user_id ||
        info.is_archived === true
      )
        throw new StoreError('slack_destination_mismatch');
      this.verified.set(
        binding,
        new SlackPresentation(this.reads, selected, bot.url),
      );
    }
    return item;
  }
  private async write(
    method: 'chat.postMessage' | 'chat.update',
    params: Record<string, string>,
  ): Promise<string> {
    this.store.assertOwner();
    if (!this.allowWrites) throw new StoreError('slack_approval_required');
    if (params.text.length > 3500)
      throw new StoreError('slack_message_too_long');
    const cooldownFile = path.join(
      this.store.root,
      'runs',
      'slack',
      'cooldowns.json',
    );
    let cooldowns: Record<string, number> = {};
    try {
      cooldowns = (await readJson(cooldownFile)) as Record<string, number>;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if ((cooldowns[method] ?? 0) > Date.now())
      throw new SlackError('rate_limited', {
        retryAfterSeconds: Math.ceil((cooldowns[method] - Date.now()) / 1000),
      });
    let response: Response;
    try {
      response = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.tokens.bot}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          ...params,
          mrkdwn: 'true',
          unfurl_links: 'false',
          unfurl_media: 'false',
          parse: 'none',
          link_names: 'false',
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new StoreError('slack_write_uncertain');
    }
    if (response.status === 429) {
      const delay = Math.max(
        1,
        Number(response.headers.get('Retry-After')) || 60,
      );
      await extendCooldown(cooldownFile, method, delay);
      throw new SlackError('rate_limited', {retryAfterSeconds: delay});
    }
    if (!response.ok) throw new StoreError('slack_write_uncertain');
    const data = object(await response.json());
    if (data.ok !== true || data.channel !== params.channel)
      throw new StoreError('slack_write_uncertain');
    return identifier(data.ts, SLACK_TS);
  }
  private async reconcile(
    intent: PostIntent,
    item: LocatedTask,
  ): Promise<string> {
    const matches: string[] = [];
    let cursor = '';
    const seen = new Set<string>();
    const deadline = Date.now() + 30000;
    do {
      const data = await this.reads.call(
        'bot',
        intent.thread_ts ? 'conversations.replies' : 'conversations.history',
        {
          channel: intent.channel,
          ...(intent.thread_ts ? {ts: intent.thread_ts} : {}),
          oldest: String(Date.parse(intent.created_at) / 1000 - 30),
          inclusive: 'true',
          limit: '100',
          ...(cursor ? {cursor} : {}),
        },
      );
      for (const message of objects(data.messages)) {
        if (
          message.user === item.task.inbox.bot_user_id &&
          message.text === intent.text &&
          (!intent.thread_ts || message.thread_ts === intent.thread_ts)
        )
          matches.push(identifier(message.ts, SLACK_TS));
      }
      const next = data.response_metadata
        ? object(data.response_metadata).next_cursor
        : '';
      if (next !== undefined && typeof next !== 'string')
        throw new StoreError('slack_write_uncertain');
      cursor = typeof next === 'string' ? next : '';
      if (data.has_more === true && !cursor)
        throw new StoreError('slack_write_uncertain');
      if (
        cursor &&
        (seen.has(cursor) || seen.size >= 10 || Date.now() > deadline)
      )
        throw new StoreError('slack_write_uncertain');
      seen.add(cursor);
    } while (cursor);
    // Absence after an uncertain network result is not proof of failure. Never blindly repost.
    if (matches.length !== 1)
      throw new StoreError('slack_write_needs_reconciliation');
    return matches[0];
  }
  private async post(
    item: LocatedTask,
    key: string,
    render: () => Promise<string>,
    thread?: string,
    inputHash?: string,
    legacyText?: string,
  ): Promise<string> {
    const file = path.join(
      this.store.root,
      'runs',
      'slack',
      `${item.task.id}-${key}.json`,
    );
    let intent: PostIntent;
    try {
      intent = (await readJson(file)) as PostIntent;
    } catch (error) {
      if (!absent(error)) throw error;
      const text = await render();
      if (text.length > 3500) throw new StoreError('slack_message_too_long');
      intent = {
        schema_version: 1,
        id: randomUUID(),
        phase: 'prepared',
        task_id: item.task.id,
        channel: item.task.inbox.channel_id,
        text,
        ...(inputHash ? {input_hash: inputHash} : {}),
        created_at: new Date().toISOString(),
        ...(thread ? {thread_ts: thread} : {}),
      };
      await atomicJson(file, intent);
    }
    if (
      intent.task_id !== item.task.id ||
      intent.channel !== item.task.inbox.channel_id ||
      intent.thread_ts !== thread ||
      (thread !== undefined &&
        (intent.input_hash
          ? intent.input_hash !== inputHash
          : intent.text !== legacyText))
    )
      throw new StoreError('slack_intent_mismatch');
    if (intent.phase === 'sent' && intent.message_ts) return intent.message_ts;
    if (intent.phase === 'sending')
      intent.message_ts = await this.reconcile(intent, item);
    else {
      intent.phase = 'sending';
      await atomicJson(file, intent);
      try {
        intent.message_ts = await this.write('chat.postMessage', {
          channel: intent.channel,
          text: intent.text,
          client_msg_id: intent.id,
          ...(thread ? {thread_ts: thread} : {}),
        });
      } catch (error) {
        if (error instanceof SlackError && error.code === 'rate_limited') {
          intent.phase = 'prepared';
          await atomicJson(file, intent);
        }
        throw error;
      }
    }
    intent.phase = 'sent';
    await atomicJson(file, intent);
    return intent.message_ts!;
  }
  sync(taskId: string): Promise<unknown> {
    return this.serialize(() => this.syncNow(taskId));
  }
  private async syncNow(taskId: string): Promise<unknown> {
    let item = await this.destination(taskId);
    const journals = path.join(this.store.root, 'runs', 'slack');
    let files: string[] = [];
    try {
      files = await readdir(journals);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    for (const file of files.filter(
      file => file.startsWith(`${taskId}-`) && file.endsWith('.json'),
    )) {
      const intent = (await readJson(path.join(journals, file))) as PostIntent;
      if (intent.phase !== 'sending') continue;
      if (
        intent.task_id !== taskId ||
        intent.channel !== item.task.inbox.channel_id
      )
        throw new StoreError('slack_intent_mismatch');
      intent.message_ts = await this.reconcile(intent, item);
      intent.phase = 'sent';
      await atomicJson(path.join(journals, file), intent);
      if (!intent.thread_ts) {
        item.task.slack.parent_ts = intent.message_ts;
        await this.store.save(item.task);
      }
    }
    if (!item.task.slack.parent_ts) {
      item.task.slack.parent_ts = await this.post(item, 'parent', () =>
        parentText(item, this.verified.get(JSON.stringify(item.task.inbox))!),
      );
      await this.store.save(item.task);
      item = await this.store.locate(taskId);
    }
    // Updating the same message is safe to retry; suppress unchanged editorial updates.
    const rendered = await parentText(
      item,
      this.verified.get(JSON.stringify(item.task.inbox))!,
    );
    const hash = digest(rendered);
    const renderFile = path.join(
      this.store.root,
      'runs',
      'slack',
      `${taskId}-render.json`,
    );
    let prior: {hash?: string} = {};
    try {
      prior = (await readJson(renderFile)) as {hash?: string};
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (prior.hash !== hash) {
      await this.write('chat.update', {
        channel: item.task.inbox.channel_id,
        ts: item.task.slack.parent_ts!,
        text: rendered,
      });
      await atomicJson(renderFile, {hash});
    }
    return {task_id: taskId, parent_ts: item.task.slack.parent_ts};
  }
  reply(
    taskId: string,
    text: string,
    needsResponse: boolean,
    deliveryKey?: string,
  ): Promise<unknown> {
    return this.serialize(() =>
      this.replyNow(taskId, text, needsResponse, deliveryKey),
    );
  }
  private async replyNow(
    taskId: string,
    text: string,
    needsResponse: boolean,
    deliveryKey?: string,
  ): Promise<unknown> {
    const safe = publicAnswer(text);
    await this.syncNow(taskId);
    const item = await this.destination(taskId);
    const prefix = needsResponse ? `<@${item.task.inbox.owner_user_id}> ` : '';
    const legacyText = prefix + escapeSlack(safe);
    const presentation = this.verified.get(JSON.stringify(item.task.inbox))!;
    const timestamp = await this.post(
      item,
      `reply-${deliveryKey ? digest(deliveryKey) : digest(legacyText)}`,
      async () => prefix + (await presentation.render(safe, item.task.sources)),
      item.task.slack.parent_ts!,
      digest(JSON.stringify({text: safe, needsResponse})),
      legacyText,
    );
    return {task_id: taskId, message_ts: timestamp};
  }
}
