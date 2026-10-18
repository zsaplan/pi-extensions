import path from 'node:path';
import {associatedSources} from './related-work.ts';
import {reviewerDisposition} from './reviewer-handoff.ts';
import {readdir} from 'node:fs/promises';
import {
  bindDiscovery,
  literalMention,
  type DiscoveryOptions,
} from './discovery.ts';
import {
  ReadonlySlackClient,
  SlackError,
  object,
  objects,
  transientSlackRead,
  type JsonObject,
} from './slack.ts';
import {
  absent,
  atomicJson,
  updateJson,
  digest,
  identifier,
  inbox,
  readJson,
  SLACK_ID,
  SLACK_TS,
  source,
  sourceKey,
  StoreError,
  TaskStore,
  type Inbox,
  type Source,
} from './store.ts';

export interface Receipt {
  schema_version: 1;
  id: string;
  source: Source;
  kind: 'mention' | 'channel_thread' | 'direct' | 'source_reply' | 'task_reply';
  author_id: string | null;
  text: string;
  content_hash: string;
  // Optional for existing state. Conversation reads take precedence over indexed search text.
  content_source?: 'search' | 'conversation';
  // Evidence only, never owner input or reference/operation authority.
  evidence_kind?: 'reviewer_result';
  candidate_task_ids: string[];
  disposition: 'pending' | 'ignored' | 'routed' | 'blocked';
  task_id?: string;
  reason?: string;
  received_at: string;
}
interface FeedState {
  checkpoint?: number;
  last_success_at?: string;
  error?: string;
}
interface IntakeState {
  schema_version: 1;
  feeds: Record<string, FeedState>;
  cooldowns: Record<string, number>;
}
interface Feed {
  id: string;
  kind: Receipt['kind'];
  channel?: string;
  root?: string;
  since?: number;
  group?: string;
  taskIds: string[];
}
export interface IntakeReport {
  schema_version: 1;
  stage: 'intake';
  at: string;
  status: 'passed' | 'partial';
  feeds: {
    id: string;
    status: 'passed' | 'failed';
    saved?: number;
    error?: string;
  }[];
  retry_after_seconds: number;
  writes_performed: 0;
  thread_coverage?: {total: number; selected: number; deferred: number};
}
export async function receipts(store: TaskStore): Promise<Receipt[]> {
  const directory = path.join(store.root, 'intake', 'receipts');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
  return Promise.all(
    files
      .filter(file => /^[a-f0-9]{64}\.json$/.test(file))
      .sort()
      .map(
        async file => (await readJson(path.join(directory, file))) as Receipt,
      ),
  );
}
export async function saveReceipt(
  store: TaskStore,
  receipt: Receipt,
  expectedHash?: string,
): Promise<boolean> {
  store.assertOwner();
  if (!/^[a-f0-9]{64}$/.test(receipt.id))
    throw new StoreError('invalid_receipt');
  return updateJson(
    path.join(store.root, 'intake', 'receipts', `${receipt.id}.json`),
    current => {
      store.assertOwner();
      const prior = current as Receipt | undefined;
      if (expectedHash !== undefined) {
        // A newer edit must stay pending rather than be overwritten by a slow classification result.
        return prior?.content_hash === expectedHash
          ? {
              ...receipt,
              content_source: prior.content_source ?? receipt.content_source,
            }
          : undefined;
      }
      // Search may format or index the same message differently. Never downgrade a full conversation read.
      if (
        prior?.content_source === 'conversation' &&
        receipt.content_source === 'search'
      )
        return undefined;
      if (prior?.content_hash === receipt.content_hash) {
        // Re-evaluate a deferred/legacy shared-bot message after delivery settles.
        // Only canonical intake may promote it; normal handled results stay deduplicated.
        if (
          receipt.content_source === 'conversation' &&
          receipt.evidence_kind === 'reviewer_result' &&
          receipt.disposition === 'pending' &&
          prior.disposition === 'ignored' &&
          ['own_bot', 'assistant_delivery_pending'].includes(prior.reason ?? '')
        )
          return receipt;
        // A different permitted discovery feed can validate a search false positive.
        if (
          prior.disposition === 'ignored' &&
          prior.reason === 'not_literal_mention' &&
          receipt.disposition === 'pending'
        )
          return {
            ...receipt,
            ...(prior.task_id ? {task_id: prior.task_id} : {}),
          };
        if (
          receipt.content_source !== 'conversation' ||
          prior.content_source === 'conversation'
        )
          return undefined;
        return {...prior, content_source: 'conversation'};
      }
      return {
        ...receipt,
        ...(prior?.task_id ? {task_id: prior.task_id} : {}),
        candidate_task_ids: [
          ...new Set([
            ...receipt.candidate_task_ids,
            ...(prior?.task_id ? [prior.task_id] : []),
          ]),
        ],
      };
    },
  );
}
function nextCursor(data: JsonObject): string {
  const cursor = data.response_metadata
    ? object(data.response_metadata).next_cursor
    : '';
  if (cursor !== undefined && typeof cursor !== 'string')
    throw new SlackError('invalid_response');
  if (data.has_more === true && !cursor)
    throw new SlackError('incomplete_pagination');
  return cursor || '';
}
export async function pollIntake(
  store: TaskStore,
  client: ReadonlySlackClient,
  conversation: string,
  signal: AbortSignal,
  inboxOnly = false,
  discovery: DiscoveryOptions = {},
  threadLimit?: number,
  recoverReads = false,
  onUnavailable?: () => void,
): Promise<IntakeReport> {
  const now = Math.floor(Date.now() / 1000);
  const stateFile = path.join(store.root, 'intake', 'state.json');
  let state: IntakeState;
  try {
    state = (await readJson(stateFile)) as IntakeState;
    if (state.schema_version !== 1)
      throw new StoreError('invalid_intake_state');
  } catch (error) {
    if (!absent(error)) throw error;
    state = {schema_version: 1, feeds: {}, cooldowns: {}};
  }
  let lastRead = '';
  const call = async (
    identity: 'user' | 'bot',
    method: Parameters<ReadonlySlackClient['call']>[1],
    params: Record<string, string> = {},
  ) => {
    lastRead = `${identity}:${method}`;
    if ((state.cooldowns[method] ?? 0) > Date.now() / 1000)
      throw new SlackError('rate_limited');
    try {
      return await client.call(identity, method, params, signal);
    } catch (error) {
      if (error instanceof SlackError && error.retryAfterSeconds) {
        state.cooldowns[method] = Date.now() / 1000 + error.retryAfterSeconds;
        await atomicJson(stateFile, state);
      }
      throw error;
    }
  };
  let selected: Inbox;
  let bot: JsonObject;
  try {
    const user = await call('user', 'auth.test');
    bot = await call('bot', 'auth.test');
    if (user.bot_id || !bot.bot_id || user.team_id !== bot.team_id)
      throw new StoreError('identity_mismatch');
    selected = inbox({
      workspace_id: user.team_id,
      channel_id: conversation,
      owner_user_id: user.user_id,
      bot_user_id: bot.user_id,
    });
    const info = object(
      (await call('bot', 'conversations.info', {channel: conversation}))
        .channel,
    );
    if (
      info.id !== conversation ||
      info.is_im !== true ||
      info.user !== selected.owner_user_id ||
      info.is_archived === true
    )
      throw new StoreError('inbox_mismatch');
  } catch (error) {
    onUnavailable?.();
    if (
      !recoverReads ||
      !(error instanceof SlackError) ||
      !transientSlackRead(error.code)
    )
      throw error;
    const report: IntakeReport = {
      schema_version: 1,
      stage: 'intake',
      at: new Date().toISOString(),
      status: 'partial',
      feeds: [
        {id: `preflight:${lastRead}`, status: 'failed', error: error.code},
      ],
      retry_after_seconds: Math.max(
        0,
        ...Object.values(state.cooldowns).map(t =>
          Math.ceil(t - Date.now() / 1000),
        ),
      ),
      writes_performed: 0,
    };
    store.assertOwner();
    await atomicJson(
      path.join(store.root, 'intake', 'last-cycle.json'),
      report,
    );
    return report;
  }
  const bindingFile = path.join(store.root, 'inbox.json');
  try {
    if (
      JSON.stringify(await readJson(bindingFile)) !== JSON.stringify(selected)
    )
      throw new StoreError('inbox_mismatch');
  } catch (error) {
    if (!absent(error)) throw error;
    await atomicJson(bindingFile, selected);
  }
  const tasks = await store.list();
  if (
    tasks.some(
      item => JSON.stringify(item.task.inbox) !== JSON.stringify(selected),
    )
  )
    throw new StoreError('inbox_mismatch');
  if (inboxOnly && (discovery.mentionGroup || discovery.watchChannel))
    throw new StoreError('discovery_requires_full_intake');
  const discoverySince = await bindDiscovery(store, selected, discovery, now);
  const feeds: Feed[] = [
    ...(!inboxOnly
      ? [{id: 'mentions', kind: 'mention' as const, taskIds: []}]
      : []),
    ...(!inboxOnly && discovery.mentionGroup
      ? [
          {
            id: `group:${discovery.mentionGroup}`,
            kind: 'mention' as const,
            group: discovery.mentionGroup,
            taskIds: [],
          },
        ]
      : []),
    ...(!inboxOnly && discovery.watchChannel
      ? [
          {
            id: `channel:${discovery.watchChannel}`,
            kind: 'channel_thread' as const,
            channel: discovery.watchChannel,
            since: discoverySince,
            taskIds: [],
          },
        ]
      : []),
    {id: 'inbox', kind: 'direct', channel: conversation, taskIds: []},
  ];
  const associations = recoverReads
    ? await associatedSources(
        store,
        tasks.map(t => t.task),
        await receipts(store),
      )
    : [];
  for (const item of tasks.filter(item => item.status !== 'done')) {
    for (const src of [
      ...item.task.sources,
      ...associations
        .filter(a => a.task_id === item.task.id)
        .map(a => a.source),
    ]) {
      const root = src.thread_ts ?? src.message_ts;
      const id = `source:${src.channel_id}:${root}`;
      let feed = feeds.find(feed => feed.id === id);
      if (!feed) {
        feed = {
          id,
          kind: 'source_reply',
          channel: src.channel_id,
          root,
          since: Number(src.message_ts),
          taskIds: [],
        };
        feeds.push(feed);
      }
      feed.since = Math.min(feed.since ?? Infinity, Number(src.message_ts));
      if (!feed.taskIds.includes(item.task.id)) feed.taskIds.push(item.task.id);
    }
    if (item.task.slack.parent_ts)
      feeds.push({
        id: `task:${item.task.id}`,
        kind: 'task_reply',
        channel: conversation,
        root: item.task.slack.parent_ts,
        since: Number(item.task.slack.parent_ts),
        taskIds: [item.task.id],
      });
  }
  const report: IntakeReport = {
    schema_version: 1,
    stage: 'intake',
    at: new Date().toISOString(),
    status: 'passed',
    feeds: [],
    retry_after_seconds: 0,
    writes_performed: 0,
  };
  const threadFeeds = feeds.filter(f => f.root);
  const selectedThreads =
    threadLimit === undefined
      ? threadFeeds
      : [...threadFeeds]
          .sort(
            (a, b) =>
              (state.feeds[a.id]?.last_success_at ?? '').localeCompare(
                state.feeds[b.id]?.last_success_at ?? '',
              ) || a.id.localeCompare(b.id),
          )
          .slice(0, threadLimit);
  if (threadLimit !== undefined)
    report.thread_coverage = {
      total: threadFeeds.length,
      selected: selectedThreads.length,
      deferred: threadFeeds.length - selectedThreads.length,
    };
  for (const feed of feeds.filter(
    f => !f.root || selectedThreads.includes(f),
  )) {
    store.assertOwner();
    if (signal.aborted) {
      report.status = 'partial';
      report.feeds.push({id: feed.id, status: 'failed', error: 'cancelled'});
      break;
    }
    const previous = state.feeds[feed.id] ?? {};
    const lower = Math.max(
      feed.kind === 'channel_thread' ? feed.since! : 0,
      (previous.checkpoint ?? feed.since ?? now - 86400) - 600,
    );
    let saved = 0;
    const accept = async (message: JsonObject, channel: string) => {
      const timestamp = identifier(message.ts, SLACK_TS);
      if (Number(timestamp) < lower || Number(timestamp) > now) return;
      if (
        feed.kind === 'channel_thread' &&
        ((message.thread_ts && message.thread_ts !== timestamp) ||
          (message.subtype && message.subtype !== 'bot_message'))
      )
        return;
      // A task-thread reply is handled only by its exact thread feed, not as a fresh DM request.
      if (
        feed.kind === 'direct' &&
        message.thread_ts &&
        message.thread_ts !== timestamp
      )
        return;
      let root =
        typeof message.thread_ts === 'string'
          ? identifier(message.thread_ts, SLACK_TS)
          : undefined;
      if (!root && typeof message.permalink === 'string') {
        const value = new URL(message.permalink).searchParams.get('thread_ts');
        if (value) root = identifier(value, SLACK_TS);
      }
      if (feed.root && timestamp === feed.root) return;
      if (feed.root) root = feed.root;
      const src = source({
        workspace_id: selected.workspace_id,
        channel_id: channel,
        message_ts: timestamp,
        ...(root ? {thread_ts: root} : {}),
      });
      const text = typeof message.text === 'string' ? message.text : '';
      const author =
        typeof message.user === 'string'
          ? identifier(message.user, /^[UW][A-Z0-9]+$/)
          : null;
      const id = digest(sourceKey(src));
      const contentHash = digest(JSON.stringify({text, author}));
      const file = path.join(store.root, 'intake', 'receipts', `${id}.json`);
      let prior: Receipt | undefined;
      try {
        prior = (await readJson(file)) as Receipt;
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const taskParent = tasks.find(
        item =>
          item.task.inbox.channel_id === channel &&
          item.task.slack.parent_ts === root,
      );
      const kind = taskParent ? 'task_reply' : feed.kind;
      const candidates = new Set(feed.taskIds);
      if (taskParent) candidates.add(taskParent.task.id);
      for (const item of tasks) {
        if (
          item.task.sources.some(
            s =>
              sourceKey(s) === sourceKey(src) ||
              (s.channel_id === src.channel_id &&
                (s.thread_ts ?? s.message_ts) ===
                  (src.thread_ts ?? src.message_ts)),
          )
        )
          candidates.add(item.task.id);
      }
      if (prior?.task_id) candidates.add(prior.task_id);
      const ownBot =
        author === selected.bot_user_id || message.bot_id === bot.bot_id;
      const reviewer =
        ownBot &&
        author === selected.bot_user_id &&
        taskParent?.status !== 'done' &&
        Boolean(taskParent) &&
        kind === 'task_reply' &&
        feed.kind === 'task_reply' &&
        message.thread_ts === taskParent!.task.slack.parent_ts;
      const reason = !text.trim()
        ? 'empty_message'
        : reviewer
          ? await reviewerDisposition(store, taskParent!.task, message)
          : ownBot
            ? 'own_bot'
            : kind === 'task_reply' && author !== selected.owner_user_id
              ? 'not_owner'
              : feed.kind === 'direct' && author !== selected.owner_user_id
                ? 'not_owner'
                : feed.kind === 'mention' &&
                    !literalMention(
                      text,
                      selected.owner_user_id,
                      feed.group,
                      'search',
                    )
                  ? 'not_literal_mention'
                  : !text.trim()
                    ? 'empty_message'
                    : undefined;
      if (
        await saveReceipt(store, {
          schema_version: 1,
          id,
          source: src,
          kind,
          author_id: author,
          text,
          content_hash: contentHash,
          content_source: feed.kind === 'mention' ? 'search' : 'conversation',
          ...(reviewer && !reason
            ? {evidence_kind: 'reviewer_result' as const}
            : {}),
          candidate_task_ids: [...candidates],
          disposition: reason ? 'ignored' : 'pending',
          ...(reason ? {reason} : {}),
          received_at: new Date().toISOString(),
          ...(prior?.task_id ? {task_id: prior.task_id} : {}),
        })
      )
        saved++;
    };
    try {
      let mentionQuery = `<@${selected.owner_user_id}>`;
      if (feed.group) {
        const groups = objects(
          (
            await call('bot', 'usergroups.list', {
              include_disabled: 'false',
              include_users: 'false',
            })
          ).usergroups,
        );
        const group = groups.find(group => group.id === feed.group);
        if (
          !group ||
          group.team_id !== selected.workspace_id ||
          group.date_delete !== 0 ||
          typeof group.handle !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(group.handle)
        )
          throw new StoreError('invalid_mention_group');
        mentionQuery = `@${group.handle}`;
      }
      if (feed.kind === 'channel_thread') {
        const channel = object(
          (await call('user', 'conversations.info', {channel: feed.channel!}))
            .channel,
        );
        if (
          channel.id !== feed.channel ||
          channel.is_im === true ||
          channel.is_mpim === true ||
          channel.is_archived === true ||
          (channel.context_team_id &&
            channel.context_team_id !== selected.workspace_id)
        )
          throw new StoreError('invalid_watch_channel');
      }
      if (feed.kind === 'mention') {
        // Slack's date modifiers and search coalescing are not an exact event feed.
        const after = new Date((lower - 86400) * 1000)
          .toISOString()
          .slice(0, 10);
        const before = new Date((now + 86400) * 1000)
          .toISOString()
          .slice(0, 10);
        let pages = 1;
        for (let page = 1; page <= pages; page++) {
          const data = await call('user', 'search.messages', {
            query: `${mentionQuery} after:${after} before:${before}`,
            count: '100',
            page: String(page),
            sort: 'timestamp',
            sort_dir: 'asc',
          });
          const result = object(data.messages);
          const pagination = result.pagination
            ? object(result.pagination)
            : object(result.paging);
          const count = pagination.page_count ?? pagination.pages;
          if (
            typeof count !== 'number' ||
            !Number.isInteger(count) ||
            count < 0 ||
            count > 100
          )
            throw new SlackError('search_window_too_large');
          pages = Math.max(pages, count);
          for (const message of objects(result.matches))
            await accept(
              message,
              identifier(object(message.channel).id, SLACK_ID),
            );
        }
      } else {
        let cursor = '';
        const seen = new Set<string>();
        do {
          const data = await call(
            feed.kind === 'direct' ? 'bot' : 'user',
            feed.kind === 'direct' || feed.kind === 'channel_thread'
              ? 'conversations.history'
              : 'conversations.replies',
            {
              channel: feed.channel!,
              ...(feed.root ? {ts: feed.root} : {}),
              oldest: String(lower),
              latest: String(now),
              inclusive: 'true',
              limit: '100',
              ...(cursor ? {cursor} : {}),
            },
          );
          for (const message of objects(data.messages))
            await accept(message, feed.channel!);
          cursor = nextCursor(data);
          if (cursor && (seen.has(cursor) || seen.size >= 100))
            throw new SlackError('incomplete_pagination');
          seen.add(cursor);
        } while (cursor);
      }
      // Commit receipts before advancing this feed. Other feeds have independent checkpoints.
      state.feeds[feed.id] = {
        checkpoint: now,
        last_success_at: new Date().toISOString(),
      };
      report.feeds.push({id: feed.id, status: 'passed', saved});
    } catch (error) {
      onUnavailable?.();
      const code =
        error instanceof SlackError || error instanceof StoreError
          ? error.code
          : 'intake_failed';
      state.feeds[feed.id] = {...previous, error: code};
      report.feeds.push({id: feed.id, status: 'failed', error: code});
      report.status = 'partial';
    }
    store.assertOwner();
    await atomicJson(stateFile, state);
  }
  report.retry_after_seconds = Math.max(
    0,
    ...Object.values(state.cooldowns).map(time =>
      Math.ceil(time - Date.now() / 1000),
    ),
  );
  await atomicJson(path.join(store.root, 'intake', 'last-cycle.json'), report);
  return report;
}
