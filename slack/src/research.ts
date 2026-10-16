import {
  conversationDisplayName,
  formatSlackTimestamp,
  getPermalink,
  listConversations,
  listUserConversations,
  messageAuthor,
  readConversationHistory,
  readThreadReplies,
  resolveConversation,
  type SlackApiCaller,
  type SlackConversation,
  type SlackMessage,
} from './slack.ts';

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_CHANNELS = 100;
const DEFAULT_MAX_MESSAGES_PER_CHANNEL = 200;
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_THREAD_REPLY_LIMIT = 50;
const MAX_QUERY_TERMS = 12;
const SNIPPET_LENGTH = 260;

export type SlackResearchChannelSource = 'member' | 'visible';

export interface SlackResearchOptions {
  query: string;
  channels?: string[];
  channelSource?: SlackResearchChannelSource;
  channelTypes?: string;
  user?: string;
  lookbackDays?: number;
  oldest?: string;
  latest?: string;
  maxChannels?: number;
  maxMessagesPerChannel?: number;
  maxResults?: number;
  includeArchived?: boolean;
  includeThreadReplies?: boolean;
  threadReplyLimit?: number;
  includePermalinks?: boolean;
}

export interface SlackResearchHit {
  channel: SlackConversation;
  message: SlackMessage;
  score: number;
  matchedTerms: string[];
  snippet: string;
  threadTs?: string;
  isThreadReply?: boolean;
  permalink?: string;
}

export interface SlackResearchResult {
  query: string;
  terms: string[];
  lookbackDays: number;
  oldest: string;
  latest?: string;
  channelSource: SlackResearchChannelSource;
  channelTypes: string;
  searchedChannels: SlackConversation[];
  searchedMessages: number;
  hits: SlackResearchHit[];
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

export function extractQueryTerms(query: string): string[] {
  const quotedTerms: string[] = [];
  const withoutQuoted = query.replace(
    /"([^"]+)"|'([^']+)'/g,
    (
      _match,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
    ) => {
      quotedTerms.push(doubleQuoted ?? singleQuoted ?? '');
      return ' ';
    },
  );
  const words = withoutQuoted
    .split(/[^\p{L}\p{N}_@#.-]+/u)
    .map(word => word.trim())
    .filter(word => word.length >= 2);

  const terms = unique([...quotedTerms, ...words]);
  return terms.slice(0, MAX_QUERY_TERMS);
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;

  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

export function scoreSlackText(
  text: string,
  query: string,
  terms: string[],
): {score: number; matchedTerms: string[]} {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  let score = 0;
  const matchedTerms: string[] = [];

  if (normalizedQuery.length >= 3 && normalizedText.includes(normalizedQuery)) {
    score += 10;
  }

  for (const term of terms) {
    const occurrences = countOccurrences(normalizedText, term);
    if (occurrences === 0) continue;

    matchedTerms.push(term);
    score += occurrences * Math.max(1, Math.min(6, term.length / 3));
  }

  return {score, matchedTerms};
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function buildSnippet(text: string, terms: string[]): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= SNIPPET_LENGTH) return collapsed;

  const lower = collapsed.toLowerCase();
  const hitIndex = terms
    .map(term => lower.indexOf(term))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];

  if (hitIndex === undefined) return `${collapsed.slice(0, SNIPPET_LENGTH)}…`;

  const contextBefore = Math.floor(SNIPPET_LENGTH / 3);
  const start = Math.max(0, hitIndex - contextBefore);
  const end = Math.min(collapsed.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${
    end < collapsed.length ? '…' : ''
  }`;
}

function toUnixOldest(lookbackDays: number): string {
  const seconds = Math.floor(Date.now() / 1000) - lookbackDays * 24 * 60 * 60;
  return String(seconds);
}

export function parseSlackTimeBound(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;

  const milliseconds = Date.parse(trimmed);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(
      `Invalid Slack time bound "${value}". Use Unix seconds, a Slack timestamp, or an ISO date/time.`,
    );
  }

  return String(Math.floor(milliseconds / 1000));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function normalizeChannelSource(
  value: SlackResearchChannelSource | undefined,
): SlackResearchChannelSource {
  return value === 'visible' ? 'visible' : 'member';
}

async function resolveResearchChannels(
  client: SlackApiCaller,
  options: SlackResearchOptions,
  maxChannels: number,
  channelSource: SlackResearchChannelSource,
  channelTypes: string,
  signal?: AbortSignal,
): Promise<SlackConversation[]> {
  if (options.channels?.length) {
    const resolved: SlackConversation[] = [];
    for (const channel of options.channels.slice(0, maxChannels)) {
      resolved.push(await resolveConversation(client, channel, signal));
    }
    return resolved;
  }

  const listOptions = {
    includeArchived: options.includeArchived,
    limit: maxChannels,
    types: channelTypes,
  };

  if (channelSource === 'visible') {
    return listConversations(client, listOptions, signal);
  }

  return listUserConversations(
    client,
    {
      ...listOptions,
      user: options.user,
    },
    signal,
  );
}

function addScoredHit(
  hits: SlackResearchHit[],
  channel: SlackConversation,
  message: SlackMessage,
  query: string,
  terms: string[],
  threadTs?: string,
): void {
  const text = message.text ?? '';
  const {score, matchedTerms} = scoreSlackText(text, query, terms);
  if (score <= 0) return;

  hits.push({
    channel,
    isThreadReply: Boolean(threadTs),
    matchedTerms,
    message,
    score,
    snippet: buildSnippet(text, matchedTerms),
    threadTs,
  });
}

async function hydratePermalinks(
  client: SlackApiCaller,
  hits: SlackResearchHit[],
  signal?: AbortSignal,
): Promise<void> {
  for (const hit of hits) {
    hit.permalink = await getPermalink(
      client,
      hit.channel.id,
      hit.message.ts,
      signal,
    );
  }
}

export async function researchSlackMessages(
  client: SlackApiCaller,
  options: SlackResearchOptions,
  signal?: AbortSignal,
): Promise<SlackResearchResult> {
  const terms = extractQueryTerms(options.query);
  if (terms.length === 0) {
    throw new Error('Slack research query must include at least one term.');
  }

  const lookbackDays = boundedInteger(
    options.lookbackDays,
    DEFAULT_LOOKBACK_DAYS,
    1,
    365,
  );
  const maxChannels = boundedInteger(
    options.maxChannels,
    DEFAULT_MAX_CHANNELS,
    1,
    200,
  );
  const maxMessagesPerChannel = boundedInteger(
    options.maxMessagesPerChannel,
    DEFAULT_MAX_MESSAGES_PER_CHANNEL,
    1,
    1000,
  );
  const maxResults = boundedInteger(
    options.maxResults,
    DEFAULT_MAX_RESULTS,
    1,
    50,
  );
  const threadReplyLimit = boundedInteger(
    options.threadReplyLimit,
    DEFAULT_THREAD_REPLY_LIMIT,
    1,
    100,
  );
  const oldest =
    parseSlackTimeBound(options.oldest) ?? toUnixOldest(lookbackDays);
  const latest = parseSlackTimeBound(options.latest);
  const channelSource = normalizeChannelSource(options.channelSource);
  const channelTypes = options.channelTypes?.trim() || 'public_channel';

  const channels = await resolveResearchChannels(
    client,
    options,
    maxChannels,
    channelSource,
    channelTypes,
    signal,
  );
  const hits: SlackResearchHit[] = [];
  let searchedMessages = 0;

  for (const channel of channels) {
    const messages = await readConversationHistory(
      client,
      channel.id,
      {
        latest,
        limit: maxMessagesPerChannel,
        oldest,
      },
      signal,
    );
    searchedMessages += messages.length;

    for (const message of messages) {
      addScoredHit(hits, channel, message, options.query, terms);

      if (!options.includeThreadReplies || !message.reply_count) continue;

      const threadTs = message.thread_ts ?? message.ts;
      const replies = await readThreadReplies(
        client,
        channel.id,
        threadTs,
        {
          latest,
          limit: threadReplyLimit,
          oldest,
        },
        signal,
      );
      const replyMessages = replies.filter(reply => reply.ts !== message.ts);
      searchedMessages += replyMessages.length;

      for (const reply of replyMessages) {
        addScoredHit(hits, channel, reply, options.query, terms, threadTs);
      }
    }
  }

  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.message.ts.localeCompare(left.message.ts);
  });

  const selectedHits = hits.slice(0, maxResults);
  if (options.includePermalinks) {
    await hydratePermalinks(client, selectedHits, signal);
  }

  return {
    channelSource,
    channelTypes,
    hits: selectedHits,
    latest,
    lookbackDays,
    oldest,
    query: options.query,
    searchedChannels: channels,
    searchedMessages,
    terms,
  };
}

export function formatResearchHit(
  hit: SlackResearchHit,
  index: number,
): string {
  const thread = hit.isThreadReply
    ? ` · thread reply to ${hit.threadTs ?? '(unknown thread)'}`
    : '';
  const lines = [
    `${index + 1}. ${conversationDisplayName(hit.channel)} · ${formatSlackTimestamp(
      hit.message.ts,
    )} · ${hit.message.ts}${thread}`,
    `   author: ${messageAuthor(hit.message)} · score: ${hit.score.toFixed(
      1,
    )} · terms: ${hit.matchedTerms.join(', ')}`,
    `   ${hit.snippet}`,
  ];

  if (hit.permalink) lines.push(`   permalink: ${hit.permalink}`);
  return lines.join('\n');
}

export function formatResearchResult(result: SlackResearchResult): string {
  const latest = result.latest
    ? ` through ${formatSlackTimestamp(result.latest)}`
    : '';
  const header = [
    `Slack research for "${result.query}"`,
    `Terms: ${result.terms.join(', ')}`,
    `Window: from ${formatSlackTimestamp(result.oldest)}${latest}.`,
    `Source: ${result.channelSource} conversations; types: ${result.channelTypes}.`,
    `Searched ${result.searchedMessages} messages across ${
      result.searchedChannels.length
    } channels.`,
    `Found ${result.hits.length} result(s).`,
  ].join('\n');

  if (result.hits.length === 0) return header;

  return `${header}\n\n${result.hits
    .map((hit, index) => formatResearchHit(hit, index))
    .join('\n\n')}`;
}
