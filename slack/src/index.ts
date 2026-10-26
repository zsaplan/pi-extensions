import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {fileURLToPath} from 'node:url';
import {Type, type Static} from 'typebox';
import {registerPublishingTools} from './publishing-tools.ts';
import {SLACK_MESSAGE_WRITING_GUIDELINES} from './writing-guidelines.ts';
import {
  prepareMessageLayout,
  RICH_MESSAGE_PROPERTIES,
} from './message-layout.ts';
import {messageHasBlocks} from './message-content.ts';
import {createSlackApprovalGate} from './approvals.ts';
import {
  getSlackConfigStatusMessage,
  getSlackWriteConfigStatusMessage,
  readSlackConfig,
  readSlackWriteConfig,
  type SlackConfig,
} from './config.ts';
import {formatResearchResult, researchSlackMessages} from './research.ts';
import {
  DEFAULT_SAFE_SLACK_TEXT_LIMIT,
  SlackApiError,
  SlackClient,
  authTest,
  collectSlackWarnings,
  conversationDisplayName,
  deleteMessage,
  formatConversationLine,
  formatMessageLine,
  listConversations,
  listUserConversations,
  parseSlackPermalink,
  postMessage,
  prepareSlackMessageText,
  readConversationHistory,
  readThreadReplies,
  resolveConversation,
  updateMessage,
  type SlackApiCaller,
  type SlackAuthTestResponse,
  type SlackConversation,
  type SlackLongTextMode,
  type SlackMessage,
  type SlackMessageFormatMode,
} from './slack.ts';

const TOKEN_KIND_SCHEMA = Type.Optional(
  Type.String({
    description: 'Slack token to use: user or bot. Default: user.',
  }),
);
const FORMAT_MODE_SCHEMA = Type.Optional(
  Type.String({
    description:
      'compact: readable text including blocks, collapsed whitespace (default). verbatim: readable projection with line breaks, not lossless source. blocks: original text/blocks/attachments JSON, subject to output limits.',
  }),
);
const LONG_TEXT_MODE_SCHEMA = Type.Optional(
  Type.String({
    description:
      'How to handle messages over the safe Slack length limit: reject or split. Default: reject.',
  }),
);
const MAX_CHARS_SCHEMA = Type.Optional(
  Type.Integer({
    minimum: 500,
    maximum: 40000,
    description: `Safe per-message character limit before rejecting or splitting. Default: ${DEFAULT_SAFE_SLACK_TEXT_LIMIT}.`,
  }),
);

const AUTH_TEST_SCHEMA = Type.Object({
  tokenKind: TOKEN_KIND_SCHEMA,
});
const LIST_CONVERSATIONS_SCHEMA = Type.Object({
  tokenKind: TOKEN_KIND_SCHEMA,
  membership: Type.Optional(
    Type.String({
      description:
        'Conversation source: visible uses conversations.list; member uses users.conversations for conversations the token identity belongs to. Default: visible.',
    }),
  ),
  userId: Type.Optional(
    Type.String({
      description:
        'Optional Slack user ID for membership=member; defaults to the token identity.',
    }),
  ),
  types: Type.Optional(
    Type.String({
      description:
        'Comma-separated Slack conversation types. Default: public_channel.',
    }),
  ),
  includeArchived: Type.Optional(
    Type.Boolean({
      description: 'Include archived conversations. Default: false.',
    }),
  ),
  nameContains: Type.Optional(
    Type.String({
      description: 'Optional case-insensitive channel-name filter.',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      description: 'Maximum conversations to return. Default: 50.',
    }),
  ),
});
const READ_MESSAGES_SCHEMA = Type.Object({
  tokenKind: TOKEN_KIND_SCHEMA,
  channel: Type.String({description: 'Slack channel ID or #channel-name.'}),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: 'Maximum top-level messages to read. Default: 25.',
    }),
  ),
  oldest: Type.Optional(
    Type.String({
      description: 'Optional oldest Slack timestamp or Unix seconds.',
    }),
  ),
  latest: Type.Optional(
    Type.String({
      description: 'Optional latest Slack timestamp or Unix seconds.',
    }),
  ),
  includeThreadReplies: Type.Optional(
    Type.Boolean({
      description: 'Fetch a small reply sample for messages with threads.',
    }),
  ),
  formatMode: FORMAT_MODE_SCHEMA,
  threadReplyLimit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 25,
      description:
        'Maximum replies per thread when includeThreadReplies is true. Default: 10.',
    }),
  ),
});
const READ_THREAD_SCHEMA = Type.Object({
  tokenKind: TOKEN_KIND_SCHEMA,
  channel: Type.String({description: 'Slack channel ID or #channel-name.'}),
  threadTs: Type.String({
    description: 'Slack thread timestamp, e.g. 1712345678.000100.',
  }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: 'Maximum thread messages to return. Default: 50.',
    }),
  ),
  formatMode: FORMAT_MODE_SCHEMA,
});
const READ_PERMALINK_SCHEMA = Type.Object({
  tokenKind: TOKEN_KIND_SCHEMA,
  url: Type.String({description: 'Slack message permalink URL.'}),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: 'Maximum thread or nearby messages to return. Default: 50.',
    }),
  ),
  surroundingSeconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 3600,
      description:
        'Fallback time window around the permalink timestamp in seconds. Default: 10.',
    }),
  ),
  formatMode: FORMAT_MODE_SCHEMA,
});
const POST_MESSAGE_SCHEMA = Type.Object({
  channel: Type.String({description: 'Slack channel ID or #channel-name.'}),
  text: Type.String({
    description:
      'Message text, or accessible fallback containing all essential information when markdown/blocks is supplied.',
  }),
  ...RICH_MESSAGE_PROPERTIES,
  threadTs: Type.Optional(
    Type.String({description: 'Optional thread timestamp for replies.'}),
  ),
  mrkdwn: Type.Optional(
    Type.Boolean({description: 'Enable Slack mrkdwn parsing. Default: true.'}),
  ),
  replyBroadcast: Type.Optional(
    Type.Boolean({description: 'Broadcast a thread reply to the channel.'}),
  ),
  longTextMode: LONG_TEXT_MODE_SCHEMA,
  maxChars: MAX_CHARS_SCHEMA,
  confirm: Type.Optional(
    Type.Boolean({
      description:
        'Required only for non-interactive writes when PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1.',
    }),
  ),
});
const UPDATE_MESSAGE_SCHEMA = Type.Object({
  channel: Type.Optional(
    Type.String({description: 'Slack channel ID or #channel-name.'}),
  ),
  url: Type.Optional(
    Type.String({description: 'Slack message permalink URL.'}),
  ),
  ts: Type.Optional(
    Type.String({description: 'Slack message timestamp to update.'}),
  ),
  threadTs: Type.Optional(
    Type.String({
      description:
        'Parent thread hint for locating a reply and routing split continuations. Verified against Slack before reusing thread approval; the actual parent is discovered when possible.',
    }),
  ),
  text: Type.String({
    description:
      'Replacement message text, or accessible fallback containing all essential information when markdown/blocks is supplied.',
  }),
  ...RICH_MESSAGE_PROPERTIES,
  clearBlocks: Type.Optional(
    Type.Boolean({
      description:
        'Explicitly replace a rich layout with text and remove top-level blocks. Legacy attachments are retained. Cannot combine with markdown/blocks. Otherwise text-only updates check the current message with SLACK_USER_TOKEN and refuse to flatten blocks.',
    }),
  ),
  mrkdwn: Type.Optional(
    Type.Boolean({description: 'Enable Slack mrkdwn parsing. Default: true.'}),
  ),
  longTextMode: LONG_TEXT_MODE_SCHEMA,
  maxChars: MAX_CHARS_SCHEMA,
  confirm: Type.Optional(
    Type.Boolean({
      description:
        'Required only for non-interactive writes when PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1.',
    }),
  ),
});
const DELETE_MESSAGE_SCHEMA = Type.Object({
  channel: Type.Optional(
    Type.String({description: 'Slack channel ID or #channel-name.'}),
  ),
  url: Type.Optional(
    Type.String({description: 'Slack message permalink URL.'}),
  ),
  ts: Type.Optional(
    Type.String({description: 'Slack message timestamp to delete.'}),
  ),
  timestamps: Type.Optional(
    Type.Array(
      Type.String({description: 'Slack message timestamp to delete.'}),
      {
        maxItems: 20,
        description: 'Optional additional Slack message timestamps to delete.',
      },
    ),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description:
        'Required only for non-interactive writes when PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1.',
    }),
  ),
});
const RESEARCH_MESSAGES_SCHEMA = Type.Object({
  tokenKind: TOKEN_KIND_SCHEMA,
  query: Type.String({
    description: 'Research query to search for in Slack message text.',
  }),
  channels: Type.Optional(
    Type.Array(
      Type.String({description: 'Slack channel ID or #channel-name.'}),
      {
        maxItems: 100,
        description:
          'Optional channels to scan. Defaults to member public channels for the selected token.',
      },
    ),
  ),
  channelSource: Type.Optional(
    Type.String({
      description:
        'Conversation source when channels is omitted: member uses users.conversations; visible uses conversations.list. Default: member.',
    }),
  ),
  channelTypes: Type.Optional(
    Type.String({
      description:
        'Comma-separated Slack conversation types when channels is omitted. Default: public_channel.',
    }),
  ),
  userId: Type.Optional(
    Type.String({
      description:
        'Optional Slack user ID for channelSource=member; defaults to the selected token identity.',
    }),
  ),
  oldest: Type.Optional(
    Type.String({
      description:
        'Optional oldest bound as Unix seconds, Slack timestamp, or ISO date/time. Overrides lookbackDays.',
    }),
  ),
  latest: Type.Optional(
    Type.String({
      description:
        'Optional latest bound as Unix seconds, Slack timestamp, or ISO date/time.',
    }),
  ),
  lookbackDays: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 365,
      description:
        'How many recent days to scan when oldest is omitted. Default: 30.',
    }),
  ),
  maxChannels: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      description:
        'Maximum channels to scan when channels is omitted. Default: 100.',
    }),
  ),
  maxMessagesPerChannel: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description: 'Maximum messages to scan per channel. Default: 200.',
    }),
  ),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: 'Maximum matching messages to return. Default: 20.',
    }),
  ),
  includeThreadReplies: Type.Optional(
    Type.Boolean({
      description: 'Also scan replies for top-level messages with threads.',
    }),
  ),
  threadReplyLimit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description:
        'Maximum replies to scan per thread when includeThreadReplies is true. Default: 50.',
    }),
  ),
  includePermalinks: Type.Optional(
    Type.Boolean({
      description: 'Fetch Slack permalinks for returned hits.',
    }),
  ),
  includeArchived: Type.Optional(
    Type.Boolean({
      description:
        'Include archived conversations when auto-selecting channels.',
    }),
  ),
});

type ListConversationsParams = Static<typeof LIST_CONVERSATIONS_SCHEMA>;
type ReadMessagesParams = Static<typeof READ_MESSAGES_SCHEMA>;
type ReadThreadParams = Static<typeof READ_THREAD_SCHEMA>;
type ReadPermalinkParams = Static<typeof READ_PERMALINK_SCHEMA>;
type PostMessageParams = Static<typeof POST_MESSAGE_SCHEMA>;
type UpdateMessageParams = Static<typeof UPDATE_MESSAGE_SCHEMA>;
type DeleteMessageParams = Static<typeof DELETE_MESSAGE_SCHEMA>;
type ResearchMessagesParams = Static<typeof RESEARCH_MESSAGES_SCHEMA>;

interface ToolTextDetails {
  truncation?: {
    truncated: boolean;
    outputLines: number;
    totalLines: number;
    outputBytes: number;
    totalBytes: number;
  };
  [key: string]: unknown;
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

function textToolResult(text: string, details: ToolTextDetails = {}) {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const resultDetails = {...details};
  let resultText = truncation.content;

  if (truncation.truncated) {
    resultDetails.truncation = {
      truncated: true,
      outputLines: truncation.outputLines,
      totalLines: truncation.totalLines,
      outputBytes: truncation.outputBytes,
      totalBytes: truncation.totalBytes,
    };
    resultText += `\n\n[Slack output truncated: showing ${
      truncation.outputLines
    } of ${truncation.totalLines} lines (${formatSize(
      truncation.outputBytes,
    )} of ${formatSize(
      truncation.totalBytes,
    )}). Rerun with narrower Slack limits if more context is needed.]`;
  }

  return {
    content: [{type: 'text' as const, text: resultText}],
    details: resultDetails,
  };
}

type SlackTokenKind = 'user' | 'bot';
type ConversationMembership = 'visible' | 'member';

function normalizeTokenKind(value: string | undefined): SlackTokenKind {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'user') return 'user';
  if (normalized === 'bot') return 'bot';
  throw new Error('Slack tokenKind must be "user" or "bot".');
}

function normalizeMembership(
  value: string | undefined,
): ConversationMembership {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'visible') return 'visible';
  if (normalized === 'member') return 'member';
  throw new Error('Slack membership must be "visible" or "member".');
}

function normalizeFormatMode(
  value: string | undefined,
): SlackMessageFormatMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'compact') return 'compact';
  if (normalized === 'verbatim' || normalized === 'blocks') return normalized;
  throw new Error(
    'Slack formatMode must be "compact", "verbatim", or "blocks".',
  );
}

function normalizeLongTextMode(value: string | undefined): SlackLongTextMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'reject') return 'reject';
  if (normalized === 'split') return 'split';
  throw new Error('Slack longTextMode must be "reject" or "split".');
}

function getSlackStatusForTokenKind(tokenKind: SlackTokenKind) {
  return tokenKind === 'bot' ? readSlackWriteConfig() : readSlackConfig();
}

function requireSlackClientForTokenKind(tokenKind: SlackTokenKind): {
  client: SlackApiCaller;
  config: SlackConfig;
} {
  const status = getSlackStatusForTokenKind(tokenKind);
  if (!status.settings) {
    throw new Error(
      status.problem ?? `Slack ${tokenKind} token is not configured.`,
    );
  }

  return {client: new SlackClient(status.settings), config: status.settings};
}

function requireSlackWriteClient(): {
  client: SlackApiCaller;
  config: SlackConfig;
} {
  return requireSlackClientForTokenKind('bot');
}

function formatAuthResponse(response: SlackAuthTestResponse): string {
  return [
    'Slack auth OK.',
    response.team ? `Team: ${response.team}` : undefined,
    response.team_id ? `Team ID: ${response.team_id}` : undefined,
    response.url ? `URL: ${response.url}` : undefined,
    response.user ? `User: ${response.user}` : undefined,
    response.user_id ? `User ID: ${response.user_id}` : undefined,
    response.bot_id ? `Bot ID: ${response.bot_id}` : undefined,
    response.enterprise_id
      ? `Enterprise ID: ${response.enterprise_id}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function slackTsSortValue(message: SlackMessage): number {
  const value = Number(message.ts);
  return Number.isFinite(value) ? value : 0;
}

function chronologicalMessages(messages: SlackMessage[]): SlackMessage[] {
  return [...messages].sort((left, right) => {
    const leftValue = slackTsSortValue(left);
    const rightValue = slackTsSortValue(right);
    if (leftValue !== rightValue) return leftValue - rightValue;
    return left.ts.localeCompare(right.ts);
  });
}

function indentMultiline(text: string, prefix: string): string {
  return text
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');
}

function formatMessages(
  messages: SlackMessage[],
  formatMode: SlackMessageFormatMode = 'compact',
): string {
  if (messages.length === 0) return 'No Slack messages found.';
  return chronologicalMessages(messages)
    .map(message => formatMessageLine(message, {formatMode}))
    .join('\n');
}

async function formatMessagesWithThreads(
  client: SlackApiCaller,
  channelId: string,
  messages: SlackMessage[],
  replyLimit: number,
  formatMode: SlackMessageFormatMode,
  signal?: AbortSignal,
): Promise<string> {
  if (messages.length === 0) return 'No Slack messages found.';

  const lines: string[] = [];
  for (const message of chronologicalMessages(messages)) {
    lines.push(formatMessageLine(message, {formatMode}));
    if (!message.reply_count || message.reply_count <= 0) continue;

    const replies = await readThreadReplies(
      client,
      channelId,
      message.thread_ts ?? message.ts,
      {limit: replyLimit},
      signal,
    );
    for (const reply of chronologicalMessages(replies)) {
      if (reply.ts === message.ts) continue;
      lines.push(
        indentMultiline(formatMessageLine(reply, {formatMode}), '  ↳ '),
      );
    }
  }

  return lines.join('\n');
}

function previewText(text: string, limit = 700): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

function slackWarningsSuffix(warnings: string[]): string {
  if (!warnings.length) return '';
  return `\nWarnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

async function formatHelpfulSlackApiError(
  error: SlackApiError,
  client: SlackApiCaller,
): Promise<string> {
  if (error.slackError === 'not_in_channel') {
    let identity = 'The configured Slack bot';
    try {
      const response = await authTest(client);
      identity = response.user
        ? `${response.user}${response.user_id ? ` (${response.user_id})` : ''}`
        : identity;
    } catch {
      // Best-effort enrichment only; keep the original Slack failure useful.
    }

    return [
      error.message,
      '',
      `${identity} is not in the target conversation. Add/invite the app to the channel, then retry.`,
      'In Slack, use the channel Integrations/Add apps UI or run /invite @<bot-name> if allowed.',
    ].join('\n');
  }

  if (error.slackError === 'msg_too_long') {
    return [
      error.message,
      '',
      'The Slack API rejected the message as too long. Shorten it or retry with longTextMode="split".',
    ].join('\n');
  }

  return error.message;
}

async function runSlackWrite<T>(
  client: SlackApiCaller,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SlackApiError) {
      throw new Error(await formatHelpfulSlackApiError(error, client));
    }
    throw error;
  }
}

interface SlackMessageReferenceParams {
  channel?: string;
  url?: string;
  ts?: string;
  threadTs?: string;
}

async function resolveMessageReference(
  client: SlackApiCaller,
  params: SlackMessageReferenceParams,
  signal?: AbortSignal,
): Promise<{
  conversation: SlackConversation;
  ts: string;
  threadTs?: string;
}> {
  const permalink = params.url ? parseSlackPermalink(params.url) : undefined;
  const channel = params.channel ?? permalink?.channel;
  const ts = params.ts ?? permalink?.messageTs;

  if (!channel) {
    throw new Error('Slack channel is required unless url is provided.');
  }
  if (!ts) throw new Error('Slack message timestamp is required.');

  const conversation = await resolveConversation(client, channel, signal);
  return {
    conversation,
    threadTs: params.threadTs ?? permalink?.threadTs,
    ts,
  };
}

async function readMessageForUpdate(
  channel: string,
  ts: string,
  threadTs: string | undefined,
  signal?: AbortSignal,
): Promise<SlackMessage | undefined> {
  const {client} = requireSlackClientForTokenKind('user');
  let messages: SlackMessage[] = [];
  const options = {oldest: ts, latest: ts, inclusive: true, limit: 2};
  try {
    messages = await readThreadReplies(
      client,
      channel,
      threadTs ?? ts,
      options,
      signal,
    );
  } catch (error) {
    if (
      !(error instanceof SlackApiError) ||
      !['invalid_arguments', 'thread_not_found'].includes(
        error.slackError ?? '',
      )
    )
      throw error;
  }
  let current = messages.find(message => message.ts === ts);
  if (!current) {
    messages = await readConversationHistory(client, channel, options, signal);
    current = messages.find(message => message.ts === ts);
  }
  return current;
}

function guardTextOnlyUpdate(current: SlackMessage | undefined): void {
  if (!current) {
    throw new Error(
      'Cannot inspect the exact Slack message. Read it first (supply threadTs for a reply), then provide a complete markdown/blocks replacement or clearBlocks=true only if removing its layout is intended.',
    );
  }
  if (messageHasBlocks(current)) {
    throw new Error(
      'This message contains blocks. Read it first and supply a complete markdown/blocks replacement. Use clearBlocks=true only to explicitly replace its top-level layout with text; legacy attachments are retained.',
    );
  }
}

function continuationThreadTs(
  paramsThreadTs: string | undefined,
  messageTs: string,
): string {
  return paramsThreadTs ?? messageTs;
}

async function handleSlackCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const action = args.trim().toLowerCase();
  const status = readSlackConfig();
  const writeStatus = readSlackWriteConfig();

  if (!action) {
    if (ctx.hasUI) {
      const message = [
        getSlackConfigStatusMessage(status),
        getSlackWriteConfigStatusMessage(writeStatus),
      ].join('\n');
      ctx.ui.notify(
        message,
        status.settings && writeStatus.settings ? 'info' : 'warning',
      );
    }
    return;
  }

  if (action !== 'test') {
    if (ctx.hasUI) ctx.ui.notify('Usage: /slack-bot [test]', 'warning');
    return;
  }

  if (!status.settings) {
    if (ctx.hasUI) {
      ctx.ui.notify(getSlackConfigStatusMessage(status), 'warning');
    }
    return;
  }

  const response = await authTest(new SlackClient(status.settings));
  if (ctx.hasUI) ctx.ui.notify(formatAuthResponse(response), 'info');
}

export default function slackExtension(pi: ExtensionAPI) {
  const confirmSlackWrite = createSlackApprovalGate(pi);
  registerPublishingTools(pi, {
    client: requireSlackWriteClient,
    confirm: confirmSlackWrite,
    result: textToolResult,
  });
  pi.on('resources_discover', () => ({
    skillPaths: [fileURLToPath(new URL('../skills', import.meta.url))],
  }));
  pi.registerCommand('slack-bot', {
    description:
      'Show Slack user/bot token configuration status or run auth.test for the user token.',
    handler: async (args, ctx) => {
      await handleSlackCommand(args, ctx);
    },
  });

  pi.registerTool({
    name: 'slack_auth_test',
    label: 'Slack Auth Test',
    description:
      'Validate SLACK_USER_TOKEN or SLACK_BOT_TOKEN using auth.test and show sanitized workspace identity.',
    promptSnippet:
      'Validate a configured Slack user or bot token with Slack auth.test.',
    promptGuidelines: [
      'Use slack_auth_test when Slack tools fail due to authorization, when the user asks which Slack identity is configured, or before mention searches that need the selected token user ID.',
      'Use slack_auth_test with tokenKind=bot to identify ZachBot or another configured Slack bot token.',
    ],
    parameters: AUTH_TEST_SCHEMA,
    async execute(
      _toolCallId,
      params: Static<typeof AUTH_TEST_SCHEMA>,
      signal,
    ) {
      const tokenKind = normalizeTokenKind(params.tokenKind);
      const {client} = requireSlackClientForTokenKind(tokenKind);
      const response = await authTest(client, signal);
      return textToolResult(formatAuthResponse(response), {
        botId: response.bot_id,
        team: response.team,
        teamId: response.team_id,
        tokenKind,
        userId: response.user_id,
      });
    },
  });

  pi.registerTool({
    name: 'slack_resolve_channel',
    label: 'Slack Resolve Channel',
    description:
      'Resolve #name or a channel ID with the selected token. Active public channels by default; membership-first, bounded visible fallback, and validated short-lived cache. Returns explicit found/not_found/incomplete/rate_limited/missing_scope/unavailable status. No writes or automatic retries.',
    promptSnippet:
      'Resolve a human-readable Slack channel name before asking the user for an ID.',
    promptGuidelines: [
      'Use slack_resolve_channel when given a channel name; do not ask the user for an ID before trying lookup. Strip no context manually: #name and whitespace are normalized.',
      'Use includePrivate=true when looking for a private channel; includeArchived only when requested. The selected token must have appropriate read scopes and visibility. Never silently switch tokens or infer bot posting permission from user-token lookup.',
      'Rate limits, incomplete scans, and missing scopes are not evidence that a channel does not exist. Respect retryAfterSeconds; do not repeatedly restart scans or automatically raise maxPages. Explain the actual blocker instead of asking reflexively for an ID.',
    ],
    parameters: Type.Object({
      name: Type.String({
        minLength: 1,
        maxLength: 100,
        description: 'Human-readable channel name, #name, or channel ID.',
      }),
      tokenKind: Type.Optional(Type.String({enum: ['user', 'bot']})),
      includePrivate: Type.Optional(Type.Boolean()),
      includeArchived: Type.Optional(Type.Boolean()),
      maxPages: Type.Optional(
        Type.Integer({
          minimum: 2,
          maximum: 20,
          description:
            'Total listing-page budget; default 6. Do not raise automatically.',
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const tokenKind = normalizeTokenKind(params.tokenKind);
      const {client} = requireSlackClientForTokenKind(tokenKind);
      const {resolveChannel} = await import('./channel-resolution.ts');
      const resolution = await resolveChannel(
        client,
        params.name,
        params,
        signal,
      );
      const details = {...resolution, tokenKind};
      return textToolResult(JSON.stringify(details, null, 2), details);
    },
  });
  pi.registerTool({
    name: 'slack_list_conversations',
    label: 'Slack List Conversations',
    description:
      'List Slack conversations visible to the selected user or bot token. Output is capped and then truncated to pi standard limits.',
    promptSnippet:
      'List Slack conversations visible to SLACK_USER_TOKEN or SLACK_BOT_TOKEN.',
    promptGuidelines: [
      'Prefer slack_resolve_channel for an exact channel-name lookup. Use slack_list_conversations to browse/filter channels, not as an unbounded name search.',
      'Use slack_list_conversations with membership=member when you need conversations the selected Slack token identity belongs to; use membership=visible for ordinary conversations.list lookup.',
    ],
    parameters: LIST_CONVERSATIONS_SCHEMA,
    async execute(_toolCallId, params: ListConversationsParams, signal) {
      const tokenKind = normalizeTokenKind(params.tokenKind);
      const membership = normalizeMembership(params.membership);
      const {client} = requireSlackClientForTokenKind(tokenKind);
      const limit = boundedInteger(params.limit, 50, 1, 200);
      const listOptions = {
        includeArchived: params.includeArchived,
        limit,
        nameContains: params.nameContains,
        types: params.types,
      };
      const conversations =
        membership === 'member'
          ? await listUserConversations(
              client,
              {...listOptions, user: params.userId},
              signal,
            )
          : await listConversations(client, listOptions, signal);
      const text = conversations.length
        ? conversations.map(formatConversationLine).join('\n')
        : 'No Slack conversations found.';
      return textToolResult(text, {
        count: conversations.length,
        limit,
        membership,
        tokenKind,
      });
    },
  });

  pi.registerTool({
    name: 'slack_read_messages',
    label: 'Slack Read Messages',
    description:
      'Read recent Slack channel messages by channel ID or #name. Output is capped and then truncated to pi standard limits.',
    promptSnippet:
      'Read recent Slack channel messages using SLACK_USER_TOKEN or SLACK_BOT_TOKEN.',
    promptGuidelines: [
      'Use slack_read_messages when the user asks what happened recently in a specific Slack channel.',
      'Use slack_read_messages tokenKind=bot only when the bot token has read scopes for the target conversation; otherwise use the default user token for reads.',
    ],
    parameters: READ_MESSAGES_SCHEMA,
    async execute(_toolCallId, params: ReadMessagesParams, signal) {
      const tokenKind = normalizeTokenKind(params.tokenKind);
      const formatMode = normalizeFormatMode(params.formatMode);
      const {client} = requireSlackClientForTokenKind(tokenKind);
      const conversation = await resolveConversation(
        client,
        params.channel,
        signal,
      );
      const limit = boundedInteger(params.limit, 25, 1, 100);
      const messages = await readConversationHistory(
        client,
        conversation.id,
        {
          latest: params.latest,
          limit,
          oldest: params.oldest,
        },
        signal,
      );
      const text = params.includeThreadReplies
        ? await formatMessagesWithThreads(
            client,
            conversation.id,
            messages,
            boundedInteger(params.threadReplyLimit, 10, 1, 25),
            formatMode,
            signal,
          )
        : formatMessages(messages, formatMode);
      return textToolResult(text, {
        channel: conversation.id,
        channelName: conversation.name,
        count: messages.length,
        formatMode,
        tokenKind,
      });
    },
  });

  pi.registerTool({
    name: 'slack_read_thread',
    label: 'Slack Read Thread',
    description:
      'Read replies in a Slack thread by channel ID/#name and thread timestamp. Output is capped and then truncated to pi standard limits.',
    promptSnippet:
      'Read Slack thread replies using SLACK_USER_TOKEN or SLACK_BOT_TOKEN.',
    promptGuidelines: [
      'Use slack_read_thread when slack_read_messages or slack_research_messages shows a relevant thread timestamp or reply count.',
    ],
    parameters: READ_THREAD_SCHEMA,
    async execute(_toolCallId, params: ReadThreadParams, signal) {
      const tokenKind = normalizeTokenKind(params.tokenKind);
      const formatMode = normalizeFormatMode(params.formatMode);
      const {client} = requireSlackClientForTokenKind(tokenKind);
      const conversation = await resolveConversation(
        client,
        params.channel,
        signal,
      );
      const limit = boundedInteger(params.limit, 50, 1, 100);
      const messages = await readThreadReplies(
        client,
        conversation.id,
        params.threadTs,
        {limit},
        signal,
      );
      return textToolResult(formatMessages(messages, formatMode), {
        channel: conversation.id,
        channelName: conversation.name,
        count: messages.length,
        formatMode,
        threadTs: params.threadTs,
        tokenKind,
      });
    },
  });

  pi.registerTool({
    name: 'slack_read_permalink',
    label: 'Slack Read Permalink',
    description:
      'Read a Slack message permalink by parsing the channel/timestamp and falling back to nearby history when thread reads are invalid.',
    promptSnippet:
      'Read Slack message or thread context directly from a Slack permalink URL.',
    promptGuidelines: [
      'Use slack_read_permalink when the user gives a Slack archives URL instead of manually parsing channel and timestamp.',
      'The tool tries conversations.replies first and falls back to nearby conversations.history for permalinks Slack will not treat as a thread.',
      'Use formatMode=verbatim for readable structured content; use formatMode=blocks for original message block JSON. Read projections are not lossless replacement payloads, and API reads do not verify visual rendering.',
    ],
    parameters: READ_PERMALINK_SCHEMA,
    async execute(_toolCallId, params: ReadPermalinkParams, signal) {
      const tokenKind = normalizeTokenKind(params.tokenKind);
      const formatMode = normalizeFormatMode(params.formatMode);
      const {client} = requireSlackClientForTokenKind(tokenKind);
      const reference = parseSlackPermalink(params.url);
      const conversation = await resolveConversation(
        client,
        reference.channel,
        signal,
      );
      const limit = boundedInteger(params.limit, 50, 1, 100);
      let mode = 'thread';
      let messages: SlackMessage[] = [];
      let fallbackReason: string | undefined;

      try {
        messages = await readThreadReplies(
          client,
          conversation.id,
          reference.threadTs ?? reference.messageTs,
          {limit},
          signal,
        );
      } catch (error) {
        if (
          !(error instanceof SlackApiError) ||
          error.slackError !== 'invalid_arguments'
        ) {
          throw error;
        }
        fallbackReason = error.slackError;
      }

      if (fallbackReason || messages.length === 0) {
        mode = 'nearby-history';
        const surroundingSeconds = boundedInteger(
          params.surroundingSeconds,
          10,
          1,
          3600,
        );
        const center = Number(reference.messageTs);
        if (!Number.isFinite(center)) {
          throw new Error(
            `Invalid Slack timestamp in permalink: ${reference.messageTs}`,
          );
        }
        messages = await readConversationHistory(
          client,
          conversation.id,
          {
            inclusive: true,
            latest: String(center + surroundingSeconds),
            limit,
            oldest: String(center - surroundingSeconds),
          },
          signal,
        );
      }

      const fallbackText = fallbackReason
        ? `\nFallback: conversations.replies failed with ${fallbackReason}; showing nearby history.`
        : '';
      return textToolResult(
        `${formatMessages(messages, formatMode)}${fallbackText}`,
        {
          channel: conversation.id,
          channelName: conversation.name,
          count: messages.length,
          formatMode,
          messageTs: reference.messageTs,
          mode,
          threadTs: reference.threadTs,
          tokenKind,
        },
      );
    },
  });

  pi.registerTool({
    name: 'slack_post_message',
    label: 'Slack Post Message',
    description:
      'Post a Slack message using SLACK_BOT_TOKEN. Interactive writes require approval unless the exact thread has a session grant or PI_SLACK_SKIP_SEND_CONFIRM=1 is set. Thread grants never cover broadcasts.',
    promptSnippet:
      'Post a Slack message or thread reply using SLACK_BOT_TOKEN.',
    promptGuidelines: [
      ...SLACK_MESSAGE_WRITING_GUIDELINES,
      'Use slack_post_message when the user asks to send or reply, or for a relevant substantive update to a thread listed in the current extension-verified proactive-update destinations. Respect draft-only requests and explicit user limits. A session grant permits concise proactive replies, not unrelated posts or other unsolicited mutations.',
      'For ongoing investigations, announce substantive new evidence, changed conclusions, meaningful investigation blockers, material uncertainty, or final outcomes—not document editing, formatting, routine verification, or internal tool limitations. Keep routine operational status in the Pi session unless explicitly requested in Slack. Editorial-only changes need no announcement.',
      'slack_post_message sends chat.postMessage with SLACK_BOT_TOKEN, not SLACK_USER_TOKEN.',
      'slack_post_message requires interactive approval unless its exact thread has a session grant or PI_SLACK_SKIP_SEND_CONFIRM=1 is set. Choose Approve thread for this session to allow future replies/uploads there; conversational pre-approval alone does not create an extension grant.',
      'Use markdown for narrative reports or static blocks for metric dashboards, with an essential-content text fallback. Rich messages cannot be split. Ordinary long text is rejected by default; use longTextMode=split only when multi-part posting is acceptable.',
    ],
    parameters: POST_MESSAGE_SCHEMA,
    async execute(
      _toolCallId,
      params: PostMessageParams,
      signal,
      _onUpdate,
      ctx,
    ) {
      const layout = prepareMessageLayout(params);
      const {client, config} = requireSlackWriteClient();
      const conversation = await resolveConversation(
        client,
        params.channel,
        signal,
      );
      const prepared = prepareSlackMessageText(params.text, {
        longTextMode: normalizeLongTextMode(params.longTextMode),
        maxChars: params.maxChars,
      });
      const target = params.threadTs
        ? `${conversationDisplayName(conversation)} thread ${params.threadTs}`
        : conversationDisplayName(conversation);
      await confirmSlackWrite(config, ctx, {
        confirm: params.confirm,
        preview:
          layout?.preview ??
          `Parts: ${prepared.chunks.length}\n\n${previewText(params.text)}`,
        threadScope:
          params.threadTs && !params.replyBroadcast
            ? {channelId: conversation.id, parentThreadTs: params.threadTs}
            : undefined,
        signal,
        target,
        title: 'Send Slack message?',
      });

      const postedParts = [];
      const warnings = [...prepared.warnings];
      for (const [index, chunk] of prepared.chunks.entries()) {
        const response = await runSlackWrite(client, () =>
          postMessage(
            client,
            {
              channel: conversation.id,
              blocks: layout?.blocks,
              mrkdwn: params.mrkdwn,
              replyBroadcast: index === 0 ? params.replyBroadcast : undefined,
              text: chunk,
              threadTs: params.threadTs,
            },
            signal,
          ),
        );
        warnings.push(...collectSlackWarnings(response));
        postedParts.push({
          index: index + 1,
          ts: response.ts,
        });
      }

      const partLines = postedParts
        .map(part => `- part ${part.index}/${postedParts.length}: ${part.ts}`)
        .join('\n');
      return textToolResult(
        `Posted ${postedParts.length} Slack message part(s) to ${conversationDisplayName(
          conversation,
        )}.\n${partLines}${slackWarningsSuffix(uniqueStrings(warnings))}`,
        {
          analysis: prepared.analysis,
          channel: conversation.id,
          channelName: conversation.name,
          format: layout?.format ?? 'text',
          parts: postedParts,
          threadTs: params.threadTs,
          warnings: uniqueStrings(warnings),
        },
      );
    },
  });

  pi.registerTool({
    name: 'slack_update_message',
    label: 'Slack Update Message',
    description:
      'Update a Slack message using SLACK_BOT_TOKEN. Verified edits in an approved thread (including its root) reuse session approval; broadcasts do not. Uses SLACK_USER_TOKEN to inspect the target. Rich-layout safeguards remain; only ordinary text can split.',
    promptSnippet:
      'Update a Slack message or thread reply using SLACK_BOT_TOKEN.',
    promptGuidelines: [
      ...SLACK_MESSAGE_WRITING_GUIDELINES,
      'Use slack_update_message instead of hand-written Slack Web API calls when the user asks to edit a message.',
      'Pass url when the user gives a Slack permalink; otherwise pass channel and ts.',
      'Read the current message before editing. Supply a complete markdown/blocks replacement for rich content. clearBlocks=true explicitly replaces the top-level layout with text; legacy attachments remain. Do not use it merely to bypass a failed read. Rich updates never split. For ordinary text use longTextMode=split only when continuation replies are authorized.',
      'Existing thread approval covers edits only after Slack confirms the exact message and its real parent. Include threadTs when needed to locate a reply; it is a hint, not permission. Unverifiable membership or broadcast replies require separate approval. Continuations use the verified parent when available.',
    ],
    parameters: UPDATE_MESSAGE_SCHEMA,
    async execute(
      _toolCallId,
      params: UpdateMessageParams,
      signal,
      _onUpdate,
      ctx,
    ) {
      const layout = prepareMessageLayout(params);
      const {client, config} = requireSlackWriteClient();
      const reference = await resolveMessageReference(client, params, signal);
      const prepared = prepareSlackMessageText(params.text, {
        longTextMode: normalizeLongTextMode(params.longTextMode),
        maxChars: params.maxChars,
      });
      const needsLayoutGuard = !layout && !params.clearBlocks;
      let current: SlackMessage | undefined;
      let inspectionWarning: string | undefined;
      if (needsLayoutGuard || (ctx.hasUI && !config.skipSendConfirm)) {
        try {
          current = await readMessageForUpdate(
            reference.conversation.id,
            reference.ts,
            reference.threadTs,
            signal,
          );
        } catch (error) {
          signal?.throwIfAborted();
          if (needsLayoutGuard) throw error;
        }
        if (!current)
          inspectionWarning =
            'Thread membership could not be verified; separate approval is required.';
      }
      if (needsLayoutGuard) guardTextOnlyUpdate(current);
      const verifiedParent = current
        ? (current.thread_ts ?? current.ts)
        : undefined;
      if (
        verifiedParent &&
        reference.threadTs &&
        reference.threadTs !== verifiedParent
      ) {
        throw new Error(
          'Supplied threadTs does not match the message’s actual Slack thread. No edit was made.',
        );
      }
      const threadScope =
        verifiedParent &&
        current &&
        !['thread_broadcast', 'reply_broadcast'].includes(current.subtype ?? '')
          ? {
              channelId: reference.conversation.id,
              parentThreadTs: verifiedParent,
            }
          : undefined;
      const threadTs = continuationThreadTs(
        verifiedParent ?? reference.threadTs,
        reference.ts,
      );
      await confirmSlackWrite(config, ctx, {
        confirm: params.confirm,
        preview: [
          inspectionWarning,
          prepared.chunks.length > 1
            ? `Continuations: ${reference.conversation.id} thread ${threadTs}`
            : undefined,
          layout?.preview ??
            `${params.clearBlocks ? 'REMOVE top-level blocks; legacy attachments retained.\n' : ''}Parts: ${prepared.chunks.length}\n\n${previewText(params.text)}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        threadScope,
        signal,
        target: `${conversationDisplayName(reference.conversation)} message ${reference.ts}`,
        title: 'Update Slack message?',
      });

      const warnings = uniqueStrings([...prepared.warnings, inspectionWarning]);
      const updated = await runSlackWrite(client, () =>
        updateMessage(
          client,
          {
            channel: reference.conversation.id,
            blocks: layout?.blocks ?? (params.clearBlocks ? [] : undefined),
            mrkdwn: params.mrkdwn,
            text: prepared.chunks[0],
            ts: reference.ts,
          },
          signal,
        ),
      );
      warnings.push(...collectSlackWarnings(updated));

      const parts = [{kind: 'updated', ts: updated.ts ?? reference.ts}];
      for (const [index, chunk] of prepared.chunks.slice(1).entries()) {
        const response = await runSlackWrite(client, () =>
          postMessage(
            client,
            {
              channel: reference.conversation.id,
              mrkdwn: params.mrkdwn,
              text: chunk,
              threadTs,
            },
            signal,
          ),
        );
        warnings.push(...collectSlackWarnings(response));
        parts.push({
          kind: `continuation-${index + 1}`,
          ts: response.ts ?? '(unknown timestamp)',
        });
      }

      const partLines = parts
        .map(part => `- ${part.kind}: ${part.ts ?? '(unknown timestamp)'}`)
        .join('\n');
      return textToolResult(
        `Updated Slack message in ${conversationDisplayName(
          reference.conversation,
        )}.\n${partLines}${slackWarningsSuffix(uniqueStrings(warnings))}`,
        {
          analysis: prepared.analysis,
          channel: reference.conversation.id,
          channelName: reference.conversation.name,
          format: layout?.format ?? 'text',
          clearedBlocks: params.clearBlocks === true,
          parts,
          threadTs,
          ts: reference.ts,
          warnings: uniqueStrings(warnings),
        },
      );
    },
  });

  pi.registerTool({
    name: 'slack_delete_message',
    label: 'Slack Delete Message',
    description:
      'Delete one or more Slack messages using SLACK_BOT_TOKEN. Interactive sessions require confirmation unless PI_SLACK_SKIP_SEND_CONFIRM=1 is set.',
    promptSnippet: 'Delete Slack messages using SLACK_BOT_TOKEN.',
    promptGuidelines: [
      'Use slack_delete_message instead of hand-written Slack Web API calls when the user asks to delete a Slack message.',
      'Pass url when the user gives a Slack permalink; otherwise pass channel and ts/timestamps.',
      'Only delete messages when the user explicitly asks.',
    ],
    parameters: DELETE_MESSAGE_SCHEMA,
    async execute(
      _toolCallId,
      params: DeleteMessageParams,
      signal,
      _onUpdate,
      ctx,
    ) {
      const {client, config} = requireSlackWriteClient();
      const permalink = params.url
        ? parseSlackPermalink(params.url)
        : undefined;
      const channel = params.channel ?? permalink?.channel;
      if (!channel) {
        throw new Error('Slack channel is required unless url is provided.');
      }
      const timestamps = uniqueStrings([
        params.ts ?? permalink?.messageTs,
        ...(params.timestamps ?? []),
      ]);
      if (!timestamps.length) {
        throw new Error('At least one Slack message timestamp is required.');
      }
      const conversation = await resolveConversation(client, channel, signal);
      await confirmSlackWrite(config, ctx, {
        confirm: params.confirm,
        preview: timestamps.map(ts => `- ${ts}`).join('\n'),
        target: conversationDisplayName(conversation),
        title: 'Delete Slack message(s)?',
      });

      const deleted = [];
      const warnings: string[] = [];
      for (const ts of timestamps) {
        const response = await runSlackWrite(client, () =>
          deleteMessage(client, {channel: conversation.id, ts}, signal),
        );
        warnings.push(...collectSlackWarnings(response));
        deleted.push({ts: response.ts ?? ts});
      }

      return textToolResult(
        `Deleted ${deleted.length} Slack message(s) from ${conversationDisplayName(
          conversation,
        )}.\n${deleted.map(item => `- ${item.ts}`).join('\n')}${slackWarningsSuffix(
          uniqueStrings(warnings),
        )}`,
        {
          channel: conversation.id,
          channelName: conversation.name,
          deleted,
          warnings: uniqueStrings(warnings),
        },
      );
    },
  });

  pi.registerTool({
    name: 'slack_research_messages',
    label: 'Slack Research Messages',
    description:
      'Research a topic by scanning bounded recent Slack history with the selected user or bot token. Supports explicit time bounds, member/visible channel discovery, thread replies, and permalinks.',
    promptSnippet:
      'Research a topic across recent Slack messages using SLACK_USER_TOKEN or SLACK_BOT_TOKEN.',
    promptGuidelines: [
      'Use slack_research_messages when the user asks to research what teammates discussed in Slack, find Slack context for a topic, or check recent mentions.',
      'For mention checks, use slack_auth_test with tokenKind=user and/or tokenKind=bot to get IDs, then query Slack mention syntax such as <@USER_ID> plus any text aliases.',
      'Prefer slack_research_messages with channelSource=member and channelTypes=public_channel for broad scans of channels the selected token belongs to; add includeThreadReplies=true when replies matter.',
      'Use oldest/latest ISO date-time bounds for calendar-day requests such as “today”; otherwise use lookbackDays for recent-window searches.',
      'Prefer passing specific channels to slack_research_messages when the likely Slack channels are known; broad research scans are capped.',
    ],
    parameters: RESEARCH_MESSAGES_SCHEMA,
    async execute(_toolCallId, params: ResearchMessagesParams, signal) {
      const tokenKind = normalizeTokenKind(params.tokenKind);
      const {client} = requireSlackClientForTokenKind(tokenKind);
      const result = await researchSlackMessages(
        client,
        {
          channelSource:
            params.channelSource === 'visible' ? 'visible' : 'member',
          channelTypes: params.channelTypes,
          channels: params.channels,
          includeArchived: params.includeArchived,
          includePermalinks: params.includePermalinks,
          includeThreadReplies: params.includeThreadReplies,
          latest: params.latest,
          lookbackDays: params.lookbackDays,
          maxChannels: params.maxChannels,
          maxMessagesPerChannel: params.maxMessagesPerChannel,
          maxResults: params.maxResults,
          oldest: params.oldest,
          query: params.query,
          threadReplyLimit: params.threadReplyLimit,
          user: params.userId,
        },
        signal,
      );
      return textToolResult(formatResearchResult(result), {
        channelSource: result.channelSource,
        channelTypes: result.channelTypes,
        hitCount: result.hits.length,
        oldest: result.oldest,
        query: result.query,
        searchedChannels: result.searchedChannels.map(channel => channel.id),
        searchedMessages: result.searchedMessages,
        tokenKind,
      });
    },
  });
}
