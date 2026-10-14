import {POLL_INTERVAL_MS, type Config} from './config.ts';
import {
  ReadonlySlackClient,
  SlackError,
  object,
  objects,
  type JsonObject,
} from './slack.ts';

export interface Check {
  name: string;
  status: 'passed' | 'failed' | 'unverified';
  details?: JsonObject;
  error?: string;
  required_scopes?: string[];
  retry_after_seconds?: number;
}

export interface PreflightReport {
  schema_version: 1;
  stage: 'read-only-preflight';
  status: 'passed' | 'incomplete' | 'blocked' | 'cancelled';
  started_at: string;
  finished_at: string;
  interval_ms: number;
  search_api: Config['searchApi'];
  checks: Check[];
  retryable: boolean;
  retry_after_seconds: number;
  discovery_complete: false;
  tasks_started: 0;
  writes_performed: 0;
}

const RETRYABLE = new Set([
  'rate_limited',
  'ratelimited',
  'transport_error',
  'service_unavailable',
  'internal_error',
  'fatal_error',
]);

function id(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new SlackError('invalid_response');
  }
  return value;
}

function hasMore(data: JsonObject): boolean | null {
  if (data.has_more === true) return true;
  const metadata = data.response_metadata;
  if (metadata && typeof metadata === 'object') {
    const cursor = object(metadata).next_cursor;
    if (typeof cursor === 'string') return Boolean(cursor);
  }
  return typeof data.has_more === 'boolean' ? data.has_more : null;
}

export async function preflight(
  config: Config,
  signal: AbortSignal,
): Promise<PreflightReport> {
  const started = new Date();
  const client = new ReadonlySlackClient({
    user: config.userToken,
    bot: config.botToken,
  });
  const checks: Check[] = [];

  async function check(
    name: string,
    operation: () => Promise<JsonObject>,
  ): Promise<JsonObject | undefined> {
    try {
      const details = await operation();
      checks.push({name, status: 'passed', details});
      return details;
    } catch (error) {
      const safe =
        error instanceof SlackError
          ? error
          : new SlackError('invalid_response');
      checks.push({
        name,
        status: 'failed',
        error: safe.code,
        ...(safe.requiredScopes.length
          ? {required_scopes: safe.requiredScopes}
          : {}),
        ...(safe.retryAfterSeconds
          ? {retry_after_seconds: safe.retryAfterSeconds}
          : {}),
      });
      return undefined;
    }
  }

  function unverified(name: string, reason: string): void {
    checks.push({name, status: 'unverified', details: {reason}});
  }

  function finish(): PreflightReport {
    const failures = checks.filter(check => check.status === 'failed');
    const incomplete = checks.some(check => check.status === 'unverified');
    const retryable =
      failures.length > 0 &&
      failures.every(check => RETRYABLE.has(check.error ?? ''));
    return {
      schema_version: 1,
      stage: 'read-only-preflight',
      status: signal.aborted
        ? 'cancelled'
        : failures.length
          ? 'blocked'
          : incomplete
            ? 'incomplete'
            : 'passed',
      started_at: started.toISOString(),
      finished_at: new Date().toISOString(),
      interval_ms: POLL_INTERVAL_MS,
      search_api: config.searchApi,
      checks,
      retryable,
      retry_after_seconds: Math.max(
        0,
        ...failures.map(check => check.retry_after_seconds ?? 0),
      ),
      discovery_complete: false,
      tasks_started: 0,
      writes_performed: 0,
    };
  }

  const [user, bot] = await Promise.all(
    (['user', 'bot'] as const).map(identity =>
      check(`${identity}_identity`, async () => {
        const result = await client.call(identity, 'auth.test', {}, signal);
        if (identity === 'user' && result.bot_id)
          throw new SlackError('user_token_is_bot');
        const details: JsonObject = {
          team_id: id(result.team_id, /^T[A-Z0-9]+$/),
          user_id: id(result.user_id, /^[UW][A-Z0-9]+$/),
        };
        if (identity === 'bot')
          details.bot_id = id(result.bot_id, /^B[A-Z0-9]+$/);
        return details;
      }),
    ),
  );
  if (!user || !bot || signal.aborted) return finish();
  if (user.team_id !== bot.team_id) {
    checks.push({
      name: 'workspace_match',
      status: 'failed',
      error: 'workspace_mismatch',
    });
    return finish();
  }
  checks.push({name: 'workspace_match', status: 'passed'});

  await check('search_access', async () => {
    const cutoff = Math.floor(started.getTime() / 1000) - 24 * 60 * 60;
    const mention = `<@${user.user_id}>`;
    let messages: JsonObject[];
    let more: boolean | null;
    if (config.searchApi === 'legacy') {
      const data = await client.call(
        'user',
        'search.messages',
        {
          query: `${mention} after:${new Date(cutoff * 1000).toISOString().slice(0, 10)}`,
          count: '20',
          page: '1',
          sort: 'timestamp',
          sort_dir: 'desc',
        },
        signal,
      );
      const result = object(data.messages);
      messages = objects(result.matches);
      const pagination = result.pagination
        ? object(result.pagination)
        : undefined;
      const paging = result.paging ? object(result.paging) : undefined;
      const pages = pagination?.page_count ?? paging?.pages;
      more = typeof pages === 'number' ? pages > 1 : hasMore(data);
    } else {
      const data = await client.call(
        'user',
        'assistant.search.context',
        {
          query: mention,
          channel_types: 'public_channel,private_channel,mpim,im',
          content_types: 'messages',
          include_bots: 'true',
          limit: '20',
          sort: 'timestamp',
          sort_dir: 'desc',
          after: String(cutoff),
        },
        signal,
      );
      messages = objects(object(data.results).messages);
      more =
        typeof data.next_cursor === 'string' ? Boolean(data.next_cursor) : null;
    }
    const directMentions = messages.filter(message => {
      const text =
        config.searchApi === 'legacy' ? message.text : message.content;
      return typeof text === 'string' && text.includes(mention);
    }).length;
    return {
      first_page_results: messages.length,
      exact_mention_markup_matches: directMentions,
      additional_pages: more,
      lookback_hours: 24,
      time_filter:
        config.searchApi === 'legacy'
          ? 'overlapping_calendar_date'
          : 'unix_seconds',
      coverage_verified: false,
    };
  });

  if (signal.aborted) return finish();
  if (!config.conversation) {
    unverified(
      'assistant_conversation',
      'Supply --conversation to probe the intended inbox.',
    );
  } else {
    const conversation = config.conversation;
    const info = await check('assistant_conversation', async () => {
      const result = await client.call(
        'bot',
        'conversations.info',
        {channel: conversation},
        signal,
      );
      const channel = object(result.channel);
      if (channel.id !== conversation)
        throw new SlackError('conversation_mismatch');
      if (channel.is_archived === true)
        throw new SlackError('conversation_archived');
      if (channel.is_im === true && channel.user !== user.user_id) {
        throw new SlackError('conversation_owner_mismatch');
      }
      return {
        channel_id: conversation,
        kind:
          channel.is_im === true
            ? 'direct'
            : channel.is_private === true
              ? 'private'
              : 'public',
        posting_authorized: false,
      };
    });
    if (info && !signal.aborted) {
      await check('assistant_history', async () => {
        const data = await client.call(
          'bot',
          'conversations.history',
          {channel: conversation, limit: '1'},
          signal,
        );
        return {
          first_page_messages: objects(data.messages).length,
          additional_pages: hasMore(data),
        };
      });
    }
  }

  if (signal.aborted) return finish();
  if (!config.sourceThread) {
    unverified(
      'source_thread',
      'Supply --source-thread CHANNEL:ROOT_TIMESTAMP to verify a known example.',
    );
  } else {
    const thread = config.sourceThread;
    await check('source_thread', async () => {
      const data = await client.call(
        'user',
        'conversations.replies',
        {
          channel: thread.channel,
          ts: thread.ts,
          limit: '20',
        },
        signal,
      );
      const messages = objects(data.messages);
      if (messages[0]?.ts !== thread.ts)
        throw new SlackError('thread_root_not_returned');
      return {
        channel_id: thread.channel,
        root_ts: thread.ts,
        first_page_messages: messages.length,
        additional_pages: hasMore(data),
        coverage_verified: false,
      };
    });
  }
  return finish();
}
