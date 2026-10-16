import {
  ChannelPaginationError,
  conversationPages,
  isLikelyConversationId,
  normalizeConversationName,
  SlackApiError,
  type SlackApiCaller,
  type SlackApiEnvelope,
  type SlackConversation,
} from './slack.ts';

export interface ChannelResolutionOptions {
  includePrivate?: boolean;
  includeArchived?: boolean;
  maxPages?: number;
}
export interface ChannelResolution {
  status:
    | 'found'
    | 'not_found'
    | 'incomplete'
    | 'rate_limited'
    | 'missing_scope'
    | 'unavailable';
  query: string;
  channel?: SlackConversation;
  source?: 'id' | 'cache' | 'member' | 'visible';
  pagesScanned: number;
  uniqueChannelsScanned: number;
  reason?: string;
  retryAfterSeconds?: number;
}
// Runtime-only, bounded, token/API-isolated cache. Cached IDs are always revalidated.
const cache = new Map<string, {id: string; expires: number}>();
const CACHE_TTL_MS = 5 * 60 * 1000;
function metadata(channel: SlackConversation): SlackConversation {
  return {
    id: channel.id,
    name: channel.name,
    is_private: channel.is_private,
    is_archived: channel.is_archived,
    is_member: channel.is_member,
  };
}
function eligible(
  channel: SlackConversation,
  options: ChannelResolutionOptions,
): boolean {
  return (
    Boolean(channel.id) &&
    !channel.is_im &&
    !channel.is_mpim &&
    (Boolean(options.includePrivate) || !channel.is_private) &&
    (Boolean(options.includeArchived) || !channel.is_archived)
  );
}

export async function resolveChannel(
  client: SlackApiCaller,
  input: string,
  options: ChannelResolutionOptions = {},
  signal?: AbortSignal,
): Promise<ChannelResolution> {
  const query = normalizeConversationName(input);
  if (!query || query.length > 100)
    throw new Error('Provide a channel name or ID (1–100 characters).');
  const maxPages = options.maxPages ?? 6;
  if (!Number.isSafeInteger(maxPages) || maxPages < 2 || maxPages > 20)
    throw new Error(
      'maxPages must be 2–20 (total across member and visible searches).',
    );
  const deadline = AbortSignal.timeout(60000);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  boundedSignal.throwIfAborted();
  let pagesScanned = 0;
  const ids = new Set<string>();
  const result = (
    status: ChannelResolution['status'],
    extra: Partial<ChannelResolution> = {},
  ): ChannelResolution => ({
    status,
    query,
    pagesScanned,
    uniqueChannelsScanned: ids.size,
    ...extra,
  });
  const key = client.resolutionCacheKey
    ? JSON.stringify([
        client.resolutionCacheKey,
        query,
        Boolean(options.includePrivate),
        Boolean(options.includeArchived),
      ])
    : undefined;
  function found(
    channel: SlackConversation,
    source: ChannelResolution['source'],
  ): ChannelResolution {
    if (key && source !== 'id') {
      if (cache.size >= 200 && !cache.has(key))
        cache.delete(cache.keys().next().value!);
      cache.set(key, {id: channel.id, expires: Date.now() + CACHE_TTL_MS});
    }
    return result('found', {
      channel: metadata(channel),
      source,
      reason:
        'Exact match visible to the selected token. This does not establish permission for another token to read or post.',
    });
  }
  async function info(id: string): Promise<SlackConversation | undefined> {
    const response = await client.call<
      SlackApiEnvelope & {channel?: SlackConversation}
    >('conversations.info', {channel: id}, boundedSignal);
    return response.channel?.id === id ? response.channel : undefined;
  }
  try {
    if (isLikelyConversationId(input)) {
      const channel = await info(input.trim().toUpperCase());
      return channel && eligible(channel, options)
        ? found(channel, 'id')
        : result('not_found', {
            reason: 'ID is unavailable or outside the requested channel scope.',
          });
    }
    const cached = key ? cache.get(key) : undefined;
    if (key && cached) {
      if (cached.expires > Date.now()) {
        let channel: SlackConversation | undefined;
        try {
          channel = await info(cached.id);
        } catch (error) {
          cache.delete(key);
          if (
            !(error instanceof SlackApiError) ||
            error.slackError !== 'channel_not_found'
          )
            throw error;
        }
        if (
          channel &&
          eligible(channel, options) &&
          normalizeConversationName(channel.name ?? '') === query
        )
          return found(channel, 'cache');
      }
      cache.delete(key);
    }
    const types = options.includePrivate
      ? 'public_channel,private_channel'
      : 'public_channel';
    for (const source of ['member', 'visible'] as const) {
      const phaseBudget =
        source === 'member' ? Math.ceil(maxPages / 2) : maxPages - pagesScanned;
      try {
        for await (const page of conversationPages(
          client,
          source === 'member' ? 'users.conversations' : 'conversations.list',
          {
            types,
            includeArchived: options.includeArchived,
            maxPages: phaseBudget,
          },
          boundedSignal,
        )) {
          pagesScanned++;
          for (const channel of page) ids.add(channel.id);
          const matches = page.filter(
            channel =>
              eligible(channel, options) &&
              normalizeConversationName(channel.name ?? '') === query,
          );
          if (new Set(matches.map(channel => channel.id)).size > 1)
            return result('incomplete', {
              reason: 'Ambiguous exact-name matches. No channel selected.',
            });
          if (matches.length) return found(matches[0], source);
        }
      } catch (error) {
        // A bounded membership scan can fall back to the broader visible search.
        if (
          source === 'member' &&
          error instanceof ChannelPaginationError &&
          error.reason === 'page_budget'
        )
          continue;
        throw error;
      }
    }
    return result('not_found', {
      reason: `No exact match in ${options.includeArchived ? 'active/archived' : 'active'} ${options.includePrivate ? 'public/private' : 'public'} channels visible to this token. Inaccessible channels are not evidence of nonexistence; private channels require includePrivate=true and appropriate scopes.`,
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted)
      return result('incomplete', {
        reason:
          '60-second lookup deadline reached; no conclusion about channel existence.',
      });
    if (error instanceof ChannelPaginationError)
      return result('incomplete', {reason: error.message});
    if (error instanceof SlackApiError) {
      if (error.status === 429 || error.slackError === 'ratelimited') {
        const seconds = /retry after (\d+) seconds/.exec(error.message);
        return result('rate_limited', {
          reason:
            'Slack rate-limited this lookup. No automatic retry was performed; respect the cooldown before another bounded lookup.',
          ...(seconds ? {retryAfterSeconds: Number(seconds[1])} : {}),
        });
      }
      if (error.slackError === 'missing_scope')
        return result('missing_scope', {
          reason:
            'The selected token lacks a required channel-read scope. No token switch or broader retry was performed.',
        });
      return result('unavailable', {
        reason: `Slack rejected the lookup: ${error.slackError ?? error.status ?? 'API error'}.`,
      });
    }
    return result('unavailable', {
      reason:
        'Lookup failed before it could establish a match. No automatic retry or token switch was performed.',
    });
  }
}
