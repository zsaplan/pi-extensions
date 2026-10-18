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
  record,
} from './store.ts';
import type {TaskCommunication} from './worker.ts';
import {publicAnswer} from './public-answer.ts';
import {escapeSlack, SlackPresentation} from './slack-presentation.ts';
import {cardStatus, readCardCopy, type CardCopy} from './task-card.ts';
import {ticketLinks, ticketRow, ticketSourceText} from './task-tickets.ts';
import {
  intentPayload,
  markdownPayload,
  mrkdwn,
  payloadHash,
  payloadParams,
  slackPayload,
  type SlackPayload,
} from './slack-payload.ts';

interface PostIntent {
  schema_version: 1 | 2;
  payload?: SlackPayload;
  payload_hash?: string;
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
export async function parentPayload(
  item: LocatedTask,
  presentation: SlackPresentation,
  copy?: CardCopy,
  sourceText: string[] = [],
): Promise<SlackPayload> {
  const {task, status} = item;
  const separator = '\n' + randomUUID() + '\n';
  // One metadata budget for the entire payload, including the complete fallback.
  const [request, latest, goal, question, next, sources, heading] = (
    await presentation.render(
      [
        parentExcerpt(task.request, 400),
        copy?.summary ?? parentExcerpt(task.latest_update, 700),
        parentExcerpt(task.outcome, 300),
        task.pending_question ? parentExcerpt(task.pending_question, 500) : '',
        copy ? (copy.next ?? '') : parentExcerpt(task.next_action, 300),
        task.sources
          .slice(0, 3)
          .map(s => presentation.sourceLink(s))
          .join(', '),
        copy?.title ?? parentExcerpt(task.request, 72),
      ].join(separator),
      task.sources,
    )
  ).split(separator);
  const title = parentExcerpt(
    heading
      .replace(
        /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g,
        (_all, url: string, label?: string) => label ?? url,
      )
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' '),
    72,
  );
  const state = cardStatus(status);
  const action = next && next !== question ? next : '';
  const field = (label: string, text: string) =>
    mrkdwn('*' + label + '*\n> ' + text.replace(/\n/g, '\n> '));
  // Host-owned identifiers only: never expose the session file or copy metadata.
  const identifiers = [
    'Pi session ID: ' + (task.session.id ?? 'Not started'),
    'Task ID: ' + task.id,
  ];
  const fallback = [
    ...(copy ? [title] : []),
    request,
    'Status: ' + status + ' (' + state.label + ')',
    latest,
    'Goal: ' + goal,
    ...(question ? ['Pending question: ' + question] : []),
    ...(action ? ['Next: ' + action] : []),
    'Sources: ' + sources,
    identifiers.join('\n'),
  ];
  const tickets = ticketRow(
    ticketLinks([
      task.request,
      task.outcome,
      task.latest_update,
      task.pending_question ?? '',
      task.next_action,
      ...sourceText,
    ]),
    3500 - fallback.join('\n\n').length - '\n\nTickets: '.length,
  );
  if (tickets) fallback.splice(-2, 0, 'Tickets: ' + tickets);
  return slackPayload({
    text: fallback.join('\n\n'),
    blocks: [
      {type: 'header', text: {type: 'plain_text', text: title}},
      {
        type: 'section',
        text: mrkdwn('> ' + state.icon + ' *' + state.label + '*'),
      },
      {
        type: 'section',
        fields: [field('Summary', latest), field('Goal', goal)],
      },
      // Without reviewed compact copy, retain the original request too. Goal is
      // always visible and comes from the task, never optional presentation copy.
      ...(!copy ? [{type: 'section', text: field('Request', request)}] : []),
      ...(question
        ? [{type: 'section', text: field('Pending question', question)}]
        : []),
      ...(action ? [{type: 'section', text: field('Next', action)}] : []),
      ...(tickets
        ? [{type: 'context', elements: [mrkdwn('*Tickets:* ' + tickets)]}]
        : []),
      {type: 'context', elements: [mrkdwn('*Sources:* ' + sources)]},
      {
        type: 'context',
        elements: identifiers.map(text => ({
          type: 'plain_text' as const,
          text,
        })),
      },
    ],
  });
}
export async function parentText(
  item: LocatedTask,
  presentation: SlackPresentation,
): Promise<string> {
  return (await parentPayload(item, presentation)).text;
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
          ...(method === 'chat.update' ? {blocks: '[]'} : {}),
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
    const payload = intentPayload(record(intent));
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
          (payload.blocks
            ? message.client_msg_id === intent.id
            : message.text === intent.text) &&
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
    render: () => Promise<SlackPayload>,
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
      const payload = slackPayload(await render());
      intent = {
        schema_version: 2,
        payload,
        payload_hash: payloadHash(payload),
        id: randomUUID(),
        phase: 'prepared',
        task_id: item.task.id,
        channel: item.task.inbox.channel_id,
        text: payload.text,
        ...(inputHash ? {input_hash: inputHash} : {}),
        created_at: new Date().toISOString(),
        ...(thread ? {thread_ts: thread} : {}),
      };
      await atomicJson(file, intent);
    }
    const payload = intentPayload(record(intent));
    if (
      !['prepared', 'sending', 'sent'].includes(intent.phase) ||
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
          ...payloadParams(payload),
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
  // One notice per continuous capacity hold, not one notification per queued
  // request/poll. Reuse the delivery journal without inventing a real task or
  // changing any task's parent. An uncertain notice must reconcile first.
  capacity(
    taskId: string,
    incoming: string | SlackPayload | null,
  ): Promise<void> {
    return this.serialize(async () => {
      const payload =
        incoming === null
          ? null
          : slackPayload(
              typeof incoming === 'string' ? {text: incoming} : incoming,
            );
      const file = path.join(this.store.root, 'runs', 'slack', 'capacity.json');
      let state:
        | {
            id: string;
            text: string;
            active: boolean;
            rendered?: string;
            payload?: SlackPayload;
            rendered_payload?: SlackPayload;
          }
        | undefined;
      try {
        state = (await readJson(file)) as typeof state;
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (
        state &&
        (!/^[a-f0-9-]{36}$/.test(state.id) ||
          typeof state.text !== 'string' ||
          state.text.length > 3500 ||
          typeof state.active !== 'boolean' ||
          (state.rendered !== undefined &&
            typeof state.rendered !== 'string') ||
          (state.payload && slackPayload(state.payload).text !== state.text) ||
          (state.rendered_payload &&
            slackPayload(state.rendered_payload).text !== state.rendered))
      )
        throw new StoreError('invalid_capacity_notice');
      if (!payload && !state?.active) return;
      const item = await this.destination(taskId);
      const coordinator = {...item, task: {...item.task, id: 'coordinator'}};
      if (state?.active) {
        const ts = await this.post(
          coordinator,
          `capacity-${state.id}`,
          async () => state!.payload ?? {text: state!.text},
        );
        const current = state.rendered_payload ?? {
          text: state.rendered ?? state.text,
        };
        if (!payload) {
          const cleared = slackPayload({
            text: 'Assistant capacity. The earlier capacity hold has cleared. No queued work is currently blocked by a capacity limit; this is not a task-completion notice.',
            blocks: [
              {
                type: 'header',
                text: {type: 'plain_text', text: 'Capacity hold cleared'},
              },
              {
                type: 'section',
                text: mrkdwn(
                  'No queued work is currently blocked by a capacity limit. This is not a task-completion notice.',
                ),
              },
            ],
          });
          await this.write('chat.update', {
            channel: item.task.inbox.channel_id,
            ts,
            ...payloadParams(cleared),
          });
          await atomicJson(file, {
            ...state,
            active: false,
            rendered: cleared.text,
            rendered_payload: cleared,
          });
        } else if (payloadHash(payload) !== payloadHash(current)) {
          await this.write('chat.update', {
            channel: item.task.inbox.channel_id,
            ts,
            ...payloadParams(payload),
          });
          await atomicJson(file, {
            ...state,
            rendered: payload.text,
            rendered_payload: payload,
          });
        }
        return;
      }
      state = {
        id: randomUUID(),
        text: payload!.text,
        payload: payload!,
        active: true,
      };
      await atomicJson(file, state);
      await this.post(
        coordinator,
        `capacity-${state.id}`,
        async () => state!.payload!,
      );
    });
  }
  sync(taskId: string): Promise<unknown> {
    return this.serialize(() => this.syncNow(taskId));
  }
  private async renderParent(item: LocatedTask): Promise<SlackPayload> {
    return parentPayload(
      item,
      this.verified.get(JSON.stringify(item.task.inbox))!,
      await readCardCopy(this.store.root, item),
      await ticketSourceText(this.store.root, item.task),
    );
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
        this.renderParent(item),
      );
      await this.store.save(item.task);
      item = await this.store.locate(taskId);
    }
    // Updating the same message is safe to retry; suppress unchanged editorial updates.
    const rendered = await this.renderParent(item);
    const hash = payloadHash(rendered);
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
        ...payloadParams(rendered),
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
    markdown?: string,
  ): Promise<unknown> {
    return this.serialize(() =>
      this.replyNow(taskId, text, needsResponse, deliveryKey, markdown),
    );
  }
  private async replyNow(
    taskId: string,
    text: string,
    needsResponse: boolean,
    deliveryKey?: string,
    markdown?: string,
  ): Promise<unknown> {
    const safe = publicAnswer(text);
    const rich =
      markdown === undefined ? undefined : publicAnswer(markdown, 12000);
    await this.syncNow(taskId);
    const item = await this.destination(taskId);
    const prefix = needsResponse ? `<@${item.task.inbox.owner_user_id}> ` : '';
    const legacyText = prefix + escapeSlack(safe);
    const presentation = this.verified.get(JSON.stringify(item.task.inbox))!;
    const timestamp = await this.post(
      item,
      `reply-${deliveryKey ? digest(deliveryKey) : digest(legacyText + (rich ?? ''))}`,
      async () => {
        const fallback =
          prefix + (await presentation.render(safe, item.task.sources));
        return rich === undefined
          ? {text: fallback}
          : markdownPayload(
              fallback,
              await presentation.render(rich, item.task.sources, 'markdown'),
              needsResponse ? item.task.inbox.owner_user_id : undefined,
            );
      },
      item.task.slack.parent_ts!,
      digest(
        JSON.stringify({
          text: safe,
          needsResponse,
          ...(rich === undefined ? {} : {markdown: rich}),
        }),
      ),
      rich === undefined ? legacyText : undefined,
    );
    return {task_id: taskId, message_ts: timestamp};
  }
}
