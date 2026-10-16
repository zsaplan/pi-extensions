import {createHash} from 'node:crypto';
import type {SlackConfig} from './config.ts';
import {
  messageContentSource,
  messageContentText,
  type MessageContent,
} from './message-content.ts';
import type {MessageBlocks} from './message-layout.ts';

export interface SlackResponseMetadata {
  next_cursor?: string;
  warnings?: string[];
}

export interface SlackApiEnvelope {
  ok?: boolean;
  error?: string;
  warning?: string;
  response_metadata?: SlackResponseMetadata;
}

export interface SlackAuthTestResponse extends SlackApiEnvelope {
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
  enterprise_id?: string;
}

export interface SlackConversation {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
}

export interface SlackMessage extends MessageContent {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

interface ConversationsListResponse extends SlackApiEnvelope {
  channels?: SlackConversation[];
}

interface ConversationsHistoryResponse extends SlackApiEnvelope {
  messages?: SlackMessage[];
  has_more?: boolean;
}

export interface ChatPostMessageResponse extends SlackApiEnvelope {
  channel?: string;
  ts?: string;
  message?: SlackMessage;
}

export interface ChatUpdateMessageResponse extends SlackApiEnvelope {
  channel?: string;
  ts?: string;
  text?: string;
  message?: SlackMessage;
}

export interface ChatDeleteMessageResponse extends SlackApiEnvelope {
  channel?: string;
  ts?: string;
}

interface ChatGetPermalinkResponse extends SlackApiEnvelope {
  permalink?: string;
}

export interface ConversationListOptions {
  maxPages?: number;
  types?: string;
  includeArchived?: boolean;
  limit?: number;
  nameContains?: string;
}

export interface UserConversationListOptions extends ConversationListOptions {
  user?: string;
}

export interface HistoryOptions {
  limit?: number;
  oldest?: string;
  latest?: string;
  inclusive?: boolean;
}

export interface PostMessageOptions {
  channel: string;
  text: string;
  threadTs?: string;
  mrkdwn?: boolean;
  replyBroadcast?: boolean;
  blocks?: MessageBlocks;
}

export interface UpdateMessageOptions {
  channel: string;
  ts: string;
  text: string;
  mrkdwn?: boolean;
  blocks?: MessageBlocks;
}

export interface DeleteMessageOptions {
  channel: string;
  ts: string;
}

export class SlackApiError extends Error {
  readonly method: string;
  readonly slackError?: string;
  readonly status?: number;

  constructor(
    method: string,
    message: string,
    options: {slackError?: string; status?: number} = {},
  ) {
    super(message);
    this.name = 'SlackApiError';
    this.method = method;
    this.slackError = options.slackError;
    this.status = options.status;
  }
}

export interface SlackApiCaller {
  readonly resolutionCacheKey?: string;
  call<T extends SlackApiEnvelope>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
}

function getSlackMethodUrl(config: SlackConfig, method: string): string {
  return `${config.apiBaseUrl}/${method}`;
}

const FORM_ENCODED_METHODS = new Set([
  'conversations.list',
  'users.conversations',
  'chat.getPermalink',
  'conversations.replies',
  'files.info',
  'conversations.info',
  'files.getUploadURLExternal',
]);

function formEncodeSlackBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

function parseSlackPayload(
  method: string,
  status: number,
  text: string,
): unknown {
  if (!text.trim()) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SlackApiError(
      method,
      `Slack API ${method} returned HTTP ${status} with non-JSON body.`,
      {status},
    );
  }
}

function getPayloadError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>).error;
  return typeof value === 'string' ? value : undefined;
}

export class SlackClient implements SlackApiCaller {
  private readonly config: SlackConfig;
  readonly resolutionCacheKey: string;

  constructor(config: SlackConfig) {
    this.config = config;
    this.resolutionCacheKey = createHash('sha256')
      .update(JSON.stringify([config.apiBaseUrl, config.token]))
      .digest('hex');
  }

  async call<T extends SlackApiEnvelope>(
    method: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const formEncoded = FORM_ENCODED_METHODS.has(method);
    const response = await fetch(getSlackMethodUrl(this.config, method), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': formEncoded
          ? 'application/x-www-form-urlencoded; charset=utf-8'
          : 'application/json; charset=utf-8',
      },
      body: formEncoded ? formEncodeSlackBody(body) : JSON.stringify(body),
      signal,
    });

    const text = await response.text();
    const payload = parseSlackPayload(method, response.status, text);
    const slackError = getPayloadError(payload);

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new SlackApiError(
        method,
        retryAfter
          ? `Slack API ${method} was rate limited; retry after ${retryAfter} seconds.`
          : `Slack API ${method} was rate limited.`,
        {slackError, status: response.status},
      );
    }

    if (!response.ok) {
      throw new SlackApiError(
        method,
        `Slack API ${method} failed with HTTP ${response.status}${
          slackError ? `: ${slackError}` : ''
        }.`,
        {slackError, status: response.status},
      );
    }

    const envelope = payload as SlackApiEnvelope;
    if (envelope.ok === false) {
      throw new SlackApiError(
        method,
        `Slack API ${method} failed: ${envelope.error ?? 'unknown_error'}.`,
        {slackError: envelope.error},
      );
    }

    return envelope as T;
  }
}

export function isLikelyConversationId(value: string): boolean {
  return /^[CGD][A-Z0-9]{8,}$/i.test(value.trim());
}

export function normalizeConversationName(value: string): string {
  return value.trim().replace(/^#/, '').trim().toLowerCase();
}

function pageLimit(remaining: number): number {
  return Math.max(1, Math.min(200, remaining));
}

export const DEFAULT_SAFE_SLACK_TEXT_LIMIT = 3500;

export type SlackLongTextMode = 'reject' | 'split';
export type SlackMessageFormatMode = 'compact' | 'verbatim' | 'blocks';

export interface SlackTextAnalysis {
  characterCount: number;
  lineCount: number;
  codeFenceCount: number;
  codeFencesBalanced: boolean;
  exceedsLimit: boolean;
  limit: number;
  longestCodeBlockCharacters: number;
}

export interface PrepareSlackMessageTextOptions {
  longTextMode?: SlackLongTextMode;
  maxChars?: number;
}

export interface PreparedSlackMessageText {
  analysis: SlackTextAnalysis;
  chunks: string[];
  warnings: string[];
}

export interface SlackMessageReference {
  channel: string;
  messageTs: string;
  threadTs?: string;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function codeFenceLanguage(line: string): string | undefined {
  const match = line.trimEnd().match(/^\s*```([^\s`]*)?.*$/);
  if (!match) return undefined;
  return match[1] ?? '';
}

export function analyzeSlackText(
  text: string,
  limit = DEFAULT_SAFE_SLACK_TEXT_LIMIT,
): SlackTextAnalysis {
  const lines = text.split('\n');
  let inCodeFence = false;
  let currentCodeBlockCharacters = 0;
  let longestCodeBlockCharacters = 0;
  let codeFenceCount = 0;

  for (const line of lines) {
    const fenceLanguage = codeFenceLanguage(line);
    if (fenceLanguage !== undefined) {
      codeFenceCount += 1;
      if (inCodeFence) {
        longestCodeBlockCharacters = Math.max(
          longestCodeBlockCharacters,
          currentCodeBlockCharacters,
        );
        currentCodeBlockCharacters = 0;
      }
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) currentCodeBlockCharacters += line.length + 1;
  }

  if (inCodeFence) {
    longestCodeBlockCharacters = Math.max(
      longestCodeBlockCharacters,
      currentCodeBlockCharacters,
    );
  }

  return {
    characterCount: text.length,
    codeFenceCount,
    codeFencesBalanced: codeFenceCount % 2 === 0,
    exceedsLimit: text.length > limit,
    limit,
    lineCount: countLines(text),
    longestCodeBlockCharacters,
  };
}

function splitLinesPreservingNewlines(text: string): string[] {
  const matches = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  return matches.filter(
    (line, index) => !(line === '' && index === matches.length - 1),
  );
}

function closeFenceSuffix(text: string): string {
  return `${text.endsWith('\n') ? '' : '\n'}\`\`\``;
}

function splitLongLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];

  const segments: string[] = [];
  const hasTrailingNewline = line.endsWith('\n');
  const body = hasTrailingNewline ? line.slice(0, -1) : line;
  const segmentSize = Math.max(1, maxChars - 1);

  for (let index = 0; index < body.length; index += segmentSize) {
    const suffix =
      index + segmentSize < body.length || hasTrailingNewline ? '\n' : '';
    segments.push(`${body.slice(index, index + segmentSize)}${suffix}`);
  }

  return segments;
}

export function splitSlackText(
  text: string,
  maxChars = DEFAULT_SAFE_SLACK_TEXT_LIMIT,
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let current = '';
  let openFenceLanguage: string | undefined;

  const flush = () => {
    if (!current) return;
    let chunk = current;
    if (openFenceLanguage !== undefined) chunk += closeFenceSuffix(chunk);
    chunks.push(chunk);
    current =
      openFenceLanguage !== undefined ? `\`\`\`${openFenceLanguage}\n` : '';
  };

  for (const originalLine of splitLinesPreservingNewlines(text)) {
    const lineSegments = splitLongLine(originalLine, maxChars);

    for (const line of lineSegments) {
      const closeCost = openFenceLanguage === undefined ? 0 : 4;
      if (current && current.length + line.length + closeCost > maxChars) {
        flush();
      }

      current += line;

      const fenceLanguage = codeFenceLanguage(line);
      if (fenceLanguage === undefined) continue;
      openFenceLanguage =
        openFenceLanguage === undefined ? fenceLanguage : undefined;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function withPartLabels(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;
  return chunks.map(
    (chunk, index) => `Part ${index + 1}/${chunks.length}\n\n${chunk}`,
  );
}

export function prepareSlackMessageText(
  text: string,
  options: PrepareSlackMessageTextOptions = {},
): PreparedSlackMessageText {
  const maxChars = options.maxChars ?? DEFAULT_SAFE_SLACK_TEXT_LIMIT;
  const longTextMode = options.longTextMode ?? 'reject';
  const analysis = analyzeSlackText(text, maxChars);
  const warnings: string[] = [];

  if (!analysis.codeFencesBalanced) {
    warnings.push('Slack mrkdwn code fences appear unbalanced.');
  }

  if (!analysis.exceedsLimit) return {analysis, chunks: [text], warnings};

  if (longTextMode === 'reject') {
    throw new Error(
      `Slack message is ${analysis.characterCount} characters, above the safe ${maxChars}-character limit. ` +
        'Shorten the message or pass longTextMode="split" to split it safely.',
    );
  }

  if (analysis.longestCodeBlockCharacters > maxChars) {
    warnings.push(
      'A code block is longer than the safe chunk limit; split output will close and reopen code fences across parts.',
    );
  }

  const prefixReserve = 32;
  const chunks = withPartLabels(
    splitSlackText(text, Math.max(1, maxChars - prefixReserve)),
  );
  return {analysis, chunks, warnings};
}

export function collectSlackWarnings(response: SlackApiEnvelope): string[] {
  const warnings = [
    response.warning,
    ...(response.response_metadata?.warnings ?? []),
  ].filter((warning): warning is string => Boolean(warning));
  return [...new Set(warnings)];
}

export function timestampFromSlackPermalinkId(value: string): string {
  const digits = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(digits)) {
    throw new Error(`Invalid Slack permalink timestamp "${value}".`);
  }

  if (digits.includes('.')) return digits;
  if (digits.length <= 6) {
    throw new Error(`Invalid Slack permalink timestamp "${value}".`);
  }
  const seconds = digits.slice(0, -6);
  const micros = digits.slice(-6);
  return `${seconds}.${micros}`;
}

export function parseSlackPermalink(url: string): SlackMessageReference {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Slack permalink URL "${url}".`);
  }

  const match = parsed.pathname.match(/\/archives\/([^/]+)\/p(\d+)/);
  if (!match) {
    throw new Error(
      `Slack permalink must contain /archives/<channel>/p<timestamp>: ${url}`,
    );
  }

  const threadTs = parsed.searchParams.get('thread_ts') ?? undefined;
  return {
    channel: match[1],
    messageTs: timestampFromSlackPermalinkId(match[2]),
    threadTs,
  };
}

export async function authTest(
  client: SlackApiCaller,
  signal?: AbortSignal,
): Promise<SlackAuthTestResponse> {
  return client.call<SlackAuthTestResponse>('auth.test', {}, signal);
}

function filterConversationByName(
  conversation: SlackConversation,
  nameFilter?: string,
): boolean {
  return (
    !nameFilter ||
    Boolean(conversation.name?.toLowerCase().includes(nameFilter))
  );
}

export class ChannelPaginationError extends Error {
  readonly reason: 'page_budget' | 'repeated_cursor' | 'repeated_page';
  constructor(reason: 'page_budget' | 'repeated_cursor' | 'repeated_page') {
    super(
      `Channel search incomplete: ${reason}. Stopped instead of restarting or claiming no match.`,
    );
    this.reason = reason;
  }
}

export async function* conversationPages(
  client: SlackApiCaller,
  method: 'conversations.list' | 'users.conversations',
  options: UserConversationListOptions = {},
  signal?: AbortSignal,
): AsyncGenerator<SlackConversation[]> {
  const maxPages = options.maxPages ?? 20;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 50)
    throw new Error('maxPages must be 1–50.');
  const cursors = new Set<string>();
  const pages = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted();
    const response = await client.call<ConversationsListResponse>(
      method,
      {
        cursor,
        exclude_archived: !options.includeArchived,
        limit: 200,
        types: options.types ?? 'public_channel',
        ...(method === 'users.conversations' && options.user
          ? {user: options.user}
          : {}),
      },
      signal,
    );
    const channels = response.channels ?? [];
    const signature = JSON.stringify(
      channels.map(channel => channel.id).sort(),
    );
    const next = response.response_metadata?.next_cursor?.trim();
    if (channels.length && pages.has(signature))
      throw new ChannelPaginationError('repeated_page');
    if (next && cursors.has(next))
      throw new ChannelPaginationError('repeated_cursor');
    if (channels.length) pages.add(signature);
    if (next) cursors.add(next);
    yield channels;
    if (!next) return;
    cursor = next;
  }
  throw new ChannelPaginationError('page_budget');
}

async function collectConversations(
  client: SlackApiCaller,
  method: 'conversations.list' | 'users.conversations',
  options: UserConversationListOptions,
  signal?: AbortSignal,
): Promise<SlackConversation[]> {
  const maxResults = options.limit ?? 100;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1)
    throw new Error('limit must be a positive integer.');
  const channels: SlackConversation[] = [];
  const ids = new Set<string>();
  const nameFilter = options.nameContains
    ? normalizeConversationName(options.nameContains)
    : undefined;
  for await (const page of conversationPages(client, method, options, signal)) {
    for (const channel of page) {
      if (
        ids.has(channel.id) ||
        (!options.includeArchived && channel.is_archived) ||
        !filterConversationByName(channel, nameFilter)
      )
        continue;
      ids.add(channel.id);
      channels.push(channel);
      if (channels.length >= maxResults) return channels;
    }
  }
  return channels;
}

export async function listConversations(
  client: SlackApiCaller,
  options: ConversationListOptions = {},
  signal?: AbortSignal,
): Promise<SlackConversation[]> {
  return collectConversations(client, 'conversations.list', options, signal);
}

export async function listUserConversations(
  client: SlackApiCaller,
  options: UserConversationListOptions = {},
  signal?: AbortSignal,
): Promise<SlackConversation[]> {
  return collectConversations(client, 'users.conversations', options, signal);
}

export async function resolveConversation(
  client: SlackApiCaller,
  channel: string,
  signal?: AbortSignal,
): Promise<SlackConversation> {
  const trimmed = channel.trim();
  if (!trimmed) throw new Error('Slack channel is required.');

  if (isLikelyConversationId(trimmed)) return {id: trimmed.toUpperCase()};

  const {resolveChannel} = await import('./channel-resolution.ts');
  const result = await resolveChannel(client, trimmed, {}, signal);
  if (result.status !== 'found' || !result.channel)
    throw new Error(
      `Slack channel lookup ${result.status}: ${result.reason ?? 'No exact match in active public channels visible to this token.'} Use slack_resolve_channel for scoped lookup details; do not assume the channel does not exist.`,
    );
  return result.channel;
}

export async function readConversationHistory(
  client: SlackApiCaller,
  channel: string,
  options: HistoryOptions = {},
  signal?: AbortSignal,
): Promise<SlackMessage[]> {
  const maxResults = options.limit ?? 25;
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.call<ConversationsHistoryResponse>(
      'conversations.history',
      {
        channel,
        cursor,
        inclusive: options.inclusive,
        latest: options.latest,
        limit: pageLimit(maxResults - messages.length),
        oldest: options.oldest,
      },
      signal,
    );

    for (const message of response.messages ?? []) {
      messages.push(message);
      if (messages.length >= maxResults) break;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor && messages.length < maxResults);

  return messages;
}

export async function readThreadReplies(
  client: SlackApiCaller,
  channel: string,
  threadTs: string,
  options: HistoryOptions = {},
  signal?: AbortSignal,
): Promise<SlackMessage[]> {
  const maxResults = options.limit ?? 50;
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.call<ConversationsHistoryResponse>(
      'conversations.replies',
      {
        channel,
        cursor,
        inclusive: options.inclusive,
        latest: options.latest,
        limit: pageLimit(maxResults - messages.length),
        oldest: options.oldest,
        ts: threadTs,
      },
      signal,
    );

    for (const message of response.messages ?? []) {
      messages.push(message);
      if (messages.length >= maxResults) break;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor && messages.length < maxResults);

  return messages;
}

export async function postMessage(
  client: SlackApiCaller,
  options: PostMessageOptions,
  signal?: AbortSignal,
): Promise<ChatPostMessageResponse> {
  return client.call<ChatPostMessageResponse>(
    'chat.postMessage',
    {
      channel: options.channel,
      blocks: options.blocks,
      mrkdwn: options.mrkdwn ?? true,
      reply_broadcast: options.replyBroadcast,
      text: options.text,
      thread_ts: options.threadTs,
    },
    signal,
  );
}

export async function updateMessage(
  client: SlackApiCaller,
  options: UpdateMessageOptions,
  signal?: AbortSignal,
): Promise<ChatUpdateMessageResponse> {
  return client.call<ChatUpdateMessageResponse>(
    'chat.update',
    {
      channel: options.channel,
      blocks: options.blocks,
      mrkdwn: options.mrkdwn ?? true,
      text: options.text,
      ts: options.ts,
    },
    signal,
  );
}

export async function deleteMessage(
  client: SlackApiCaller,
  options: DeleteMessageOptions,
  signal?: AbortSignal,
): Promise<ChatDeleteMessageResponse> {
  return client.call<ChatDeleteMessageResponse>(
    'chat.delete',
    {
      channel: options.channel,
      ts: options.ts,
    },
    signal,
  );
}

export async function getPermalink(
  client: SlackApiCaller,
  channel: string,
  messageTs: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await client.call<ChatGetPermalinkResponse>(
    'chat.getPermalink',
    {
      channel,
      message_ts: messageTs,
    },
    signal,
  );
  return response.permalink;
}

export function conversationDisplayName(
  conversation: SlackConversation,
): string {
  if (conversation.name) return `#${conversation.name}`;
  return conversation.id;
}

export function messageAuthor(message: SlackMessage): string {
  return (
    message.username ??
    message.user ??
    message.bot_id ??
    message.app_id ??
    'unknown'
  );
}

export function formatSlackTimestamp(ts: string): string {
  const seconds = Number(ts.split('.')[0]);
  if (!Number.isFinite(seconds)) return ts;
  return new Date(seconds * 1000).toISOString();
}

export interface FormatMessageLineOptions {
  formatMode?: SlackMessageFormatMode;
}

function formatMessageHeader(message: SlackMessage): string {
  const subtype = message.subtype ? ` ${message.subtype}` : '';
  const thread =
    message.reply_count && message.reply_count > 0
      ? ` · replies:${message.reply_count}`
      : '';
  return `[${formatSlackTimestamp(message.ts)} · ${message.ts}${thread}] ${messageAuthor(
    message,
  )}${subtype}:`;
}

export function formatMessageLine(
  message: SlackMessage,
  options: FormatMessageLineOptions = {},
): string {
  const header = formatMessageHeader(message);
  if (options.formatMode === 'blocks') {
    return `${header}\n${messageContentSource(message)}`;
  }
  const rawText = messageContentText(message);

  if (options.formatMode === 'verbatim') {
    const text = rawText.trimEnd();
    return text ? `${header}\n${text}` : header;
  }

  const text = rawText.replace(/\s+/g, ' ').trim();
  return `${header} ${text}`;
}

export function formatConversationLine(
  conversation: SlackConversation,
): string {
  const flags = [
    conversation.is_private ? 'private' : 'public',
    conversation.is_archived ? 'archived' : undefined,
    conversation.is_member === false ? 'not-member' : undefined,
    typeof conversation.num_members === 'number'
      ? `${conversation.num_members} members`
      : undefined,
  ].filter((value): value is string => Boolean(value));

  return `${conversationDisplayName(conversation)} (${conversation.id})${
    flags.length ? ` · ${flags.join(', ')}` : ''
  }`;
}
