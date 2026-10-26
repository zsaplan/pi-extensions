import {createHash} from 'node:crypto';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {readSlackWriteConfig, type SlackConfig} from './config.ts';
import {authTest, parseSlackPermalink, SlackClient} from './slack.ts';

const ENTRY_TYPE = 'slack-approval-v2';
const LEGACY_ENTRY_TYPE = 'slack-thread-approval-v1';
const ONCE = 'Approve once';
const THREAD = 'Approve thread for this session';
const CANVAS = 'Approve Canvas content for this session';
const CANCEL = 'Cancel';

export interface ThreadScope {
  channelId: string;
  parentThreadTs: string;
}
export interface CanvasScope {
  canvasId: string;
}
export interface SlackWriteConfirmationOptions {
  title: string;
  target: string;
  preview?: string;
  confirm?: boolean;
  threadScope?: ThreadScope;
  canvasScope?: CanvasScope;
  signal?: AbortSignal;
}
interface Identity {
  workspaceId: string;
  botUserId: string;
  botId: string;
  apiBaseUrl: string;
}
type Scope =
  | ({kind: 'thread'} & ThreadScope)
  | ({kind: 'canvas'} & CanvasScope);
type Grant = Identity & Scope & {sessionId: string};
interface ApprovalEvent {
  sessionId: string;
  action: 'grant' | 'revoke' | 'clear';
  grant?: Grant;
}

function key(grant: Grant): string {
  return JSON.stringify([
    grant.sessionId,
    grant.apiBaseUrl,
    grant.workspaceId,
    grant.botUserId,
    grant.botId,
    grant.kind,
    ...(grant.kind === 'thread'
      ? [grant.channelId, grant.parentThreadTs]
      : [grant.canvasId]),
  ]);
}
function validScope(scope: Scope): boolean {
  return scope.kind === 'thread'
    ? /^[CGD][A-Z0-9]{8,}$/.test(scope.channelId) &&
        /^\d+\.\d+$/.test(scope.parentThreadTs)
    : scope.kind === 'canvas' && /^F[A-Z0-9]+$/.test(scope.canvasId);
}
function currentGrants(ctx: ExtensionContext): Map<string, Grant> {
  const result = new Map<string, Grant>();
  const sessionId = ctx.sessionManager.getSessionId();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== 'custom' ||
      ![ENTRY_TYPE, LEGACY_ENTRY_TYPE].includes(entry.customType) ||
      !entry.data ||
      typeof entry.data !== 'object'
    )
      continue;
    const event = entry.data as ApprovalEvent;
    const legacy = entry.customType === LEGACY_ENTRY_TYPE;
    // Fork/clone inherit custom entries but must not inherit consent.
    if (event.sessionId !== sessionId) continue;
    if (event.action === 'clear') {
      for (const [id, grant] of result)
        if (!legacy || grant.kind === 'thread') result.delete(id);
      continue;
    }
    const grant = event.grant
      ? ({
          ...event.grant,
          ...(legacy ? {kind: 'thread' as const} : {}),
        } as Grant)
      : undefined;
    if (
      !grant ||
      grant.sessionId !== sessionId ||
      !validScope(grant) ||
      ![
        grant.workspaceId,
        grant.botId,
        grant.botUserId,
        grant.apiBaseUrl,
      ].every(value => typeof value === 'string' && value.length > 0)
    )
      continue;
    if (event.action === 'grant') result.set(key(grant), grant);
    if (event.action === 'revoke') result.delete(key(grant));
  }
  return result;
}
function describe(grant: Grant): string {
  return `${grant.workspaceId} / ${grant.botUserId} / ${grant.kind === 'thread' ? `${grant.channelId} thread ${grant.parentThreadTs}` : `${grant.canvasId} Canvas content`}`;
}
function explanation(kind: Scope['kind']): string {
  return kind === 'thread'
    ? 'Allows replies, file uploads, and edits to verified messages in this exact thread, including its root. Excludes broadcasts, message deletes, and all Canvas operations. Layout safeguards still apply.'
    : 'Allows targeted section edits/revision notes, append/prepend, and rename of this exact Canvas. Revision checks still apply to targeted edits. Excludes whole-document replacement, sharing/access changes, creation, and deletion.';
}
function parseCanvasReference(value: string): string {
  if (/^F[A-Z0-9]+$/.test(value)) return value;
  const url = new URL(value);
  const match = /^\/docs\/T[A-Z0-9]+\/(F[A-Z0-9]+)\/?$/.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.slack.com') ||
    !match
  )
    throw new Error('Use a Canvas ID or its Slack /docs/T.../F... permalink.');
  return match[1];
}
async function resolveIdentity(
  config: SlackConfig,
  signal?: AbortSignal,
): Promise<Identity> {
  const timeout = AbortSignal.timeout(15000);
  const response = await authTest(
    new SlackClient(config),
    signal ? AbortSignal.any([signal, timeout]) : timeout,
  );
  if (!response.team_id || !response.user_id || !response.bot_id)
    throw new Error(
      'A verified Slack workspace and bot identity are required for scoped approval.',
    );
  return {
    workspaceId: response.team_id,
    botUserId: response.user_id,
    botId: response.bot_id,
    apiBaseUrl: config.apiBaseUrl,
  };
}

export function createSlackApprovalGate(
  pi: ExtensionAPI,
  identityLookup = resolveIdentity,
) {
  // Never persist tokens/fingerprints. Cache identity only within this runtime.
  const identities = new Map<string, Identity>();
  let tail = Promise.resolve();
  async function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => {
      release = resolve;
    });
    try {
      await previous;
      return await operation();
    } finally {
      release();
    }
  }
  async function identity(
    config: SlackConfig,
    signal?: AbortSignal,
  ): Promise<Identity> {
    const cacheKey = `${config.apiBaseUrl}:${createHash('sha256').update(config.token).digest('hex')}`;
    const cached = identities.get(cacheKey);
    if (cached) return cached;
    const value = await identityLookup(config, signal);
    identities.set(cacheKey, value);
    return value;
  }
  function save(
    ctx: ExtensionContext,
    action: ApprovalEvent['action'],
    grant?: Grant,
  ): void {
    pi.appendEntry(ENTRY_TYPE, {
      sessionId: ctx.sessionManager.getSessionId(),
      action,
      ...(grant ? {grant} : {}),
    });
  }
  async function choose(
    config: SlackConfig,
    ctx: ExtensionContext,
    options: SlackWriteConfirmationOptions,
  ): Promise<void> {
    options.signal?.throwIfAborted();
    if (options.threadScope && options.canvasScope)
      throw new Error(
        'A write cannot request both thread and Canvas approval scopes.',
      );
    const scope: Scope | undefined = options.threadScope
      ? {kind: 'thread', ...options.threadScope}
      : options.canvasScope
        ? {kind: 'canvas', ...options.canvasScope}
        : undefined;
    const body = [`Target: ${options.target}`, options.preview]
      .filter(Boolean)
      .join('\n\n');
    let grant: Grant | undefined;
    if (scope && validScope(scope)) {
      try {
        grant = {
          ...(await identity(config, options.signal)),
          ...scope,
          sessionId: ctx.sessionManager.getSessionId(),
        };
      } catch {
        options.signal?.throwIfAborted();
        ctx.ui.notify(
          'Could not verify Slack identity; scoped approval unavailable. This write still requires approval.',
          'warning',
        );
      }
    }
    if (grant && currentGrants(ctx).has(key(grant))) return;
    if (!grant) {
      if (
        !(await ctx.ui.confirm(options.title, body, {signal: options.signal}))
      )
        throw new Error('Slack write cancelled by user.');
      return;
    }
    const scopeChoice = grant.kind === 'thread' ? THREAD : CANVAS;
    const choice = await ctx.ui.select(
      `${options.title}\n\n${body}\n\nSession grant: ${describe(grant)}\n${explanation(grant.kind)}`,
      [ONCE, scopeChoice, CANCEL],
      {signal: options.signal},
    );
    options.signal?.throwIfAborted();
    if (choice === ONCE) return;
    if (choice !== scopeChoice)
      throw new Error('Slack write cancelled by user.');
    save(ctx, 'grant', grant);
    ctx.ui.notify(
      `Approved for this session: ${describe(grant)}. Revoke with /slack-approvals.`,
      'info',
    );
  }

  // Request-local context stays fresh after grants/revocations, including tool
  // continuations. Never persist this snapshot or turn it into an outbound post.
  pi.on('context', async (event, ctx) => {
    let threads: Grant[] = [];
    const grants = [...currentGrants(ctx).values()].filter(
      grant => grant.kind === 'thread',
    );
    const config = readSlackWriteConfig().settings;
    if (ctx.hasUI && config && grants.length) {
      try {
        const verified = await identity(config, ctx.signal);
        threads = grants.filter(
          grant => key(grant) === key({...grant, ...verified}),
        );
      } catch {
        // Missing identity evidence must not advertise a proactive destination.
      }
    }
    return {
      messages: [
        ...event.messages,
        {
          role: 'custom' as const,
          customType: 'slack-approved-threads',
          display: false,
          timestamp: Date.now(),
          content: [
            'Current Slack proactive-update destinations (extension-verified session thread grants):',
            ...(threads.length
              ? threads.map(grant => describe(grant))
              : ['None.']),
          ].join('\n'),
        },
      ],
    };
  });

  pi.registerCommand('slack-approvals', {
    description:
      'Inspect/revoke session Slack grants; allow <thread-link> or allow-canvas <ID/link> explicitly pre-approves one scope.',
    async handler(args, ctx) {
      if (!ctx.hasUI)
        throw new Error(
          'Slack approval management requires an interactive UI.',
        );
      await serialized(async () => {
        const [action, reference, ...extra] = args.trim().split(/\s+/);
        if (action === 'allow' || action === 'allow-canvas') {
          if (!reference || extra.length)
            throw new Error(
              `Usage: /slack-approvals ${action} <${action === 'allow' ? 'parent-thread-permalink' : 'Canvas-ID-or-permalink'}>`,
            );
          let scope: Scope;
          if (action === 'allow') {
            const parsed = parseSlackPermalink(reference);
            scope = {
              kind: 'thread',
              channelId: parsed.channel,
              parentThreadTs: parsed.threadTs ?? parsed.messageTs,
            };
          } else
            scope = {kind: 'canvas', canvasId: parseCanvasReference(reference)};
          if (!validScope(scope)) throw new Error('Invalid approval scope.');
          const config = readSlackWriteConfig().settings;
          if (!config) throw new Error('SLACK_BOT_TOKEN is required.');
          const grant: Grant = {
            ...(await identity(config)),
            ...scope,
            sessionId: ctx.sessionManager.getSessionId(),
          };
          if (currentGrants(ctx).has(key(grant))) {
            ctx.ui.notify(
              'This scope is already approved for this session.',
              'info',
            );
            return;
          }
          if (
            await ctx.ui.confirm(
              'Approve this Slack scope for this session?',
              `${describe(grant)}\n${explanation(grant.kind)}`,
            )
          ) {
            save(ctx, 'grant', grant);
            ctx.ui.notify(
              'Scope approved for this session. No Slack content was changed.',
              'info',
            );
          }
          return;
        }
        if ((action && action !== 'clear') || reference || extra.length)
          throw new Error(
            'Usage: /slack-approvals [clear | allow <thread-link> | allow-canvas <ID/link>]',
          );
        const grants = [...currentGrants(ctx).values()];
        if (!grants.length) {
          ctx.ui.notify('No Slack approvals in this session.', 'info');
          return;
        }
        if (action === 'clear') {
          if (
            await ctx.ui.confirm(
              'Revoke all Slack session approvals?',
              `${grants.length} grant(s) in this session.`,
            )
          ) {
            save(ctx, 'clear');
            ctx.ui.notify('All session Slack approvals revoked.', 'info');
          }
          return;
        }
        const labels = grants.map(
          (grant, index) => `${index + 1}. ${describe(grant)}`,
        );
        const selected = await ctx.ui.select(
          'Session Slack approvals — select one to revoke',
          [...labels, 'Cancel'],
        );
        const index = labels.indexOf(selected ?? '');
        if (
          index >= 0 &&
          (await ctx.ui.confirm('Revoke approval?', labels[index]))
        ) {
          save(ctx, 'revoke', grants[index]);
          ctx.ui.notify('Approval revoked.', 'info');
        }
      });
    },
  });
  return async function confirmSlackWrite(
    config: SlackConfig,
    ctx: ExtensionContext,
    options: SlackWriteConfirmationOptions,
  ): Promise<void> {
    options.signal?.throwIfAborted();
    if (config.skipSendConfirm) return;
    if (!ctx.hasUI) {
      // Saved interactive consent never authorizes unattended execution.
      if (!config.allowNonInteractiveWrites || options.confirm !== true)
        throw new Error(
          'Slack write blocked in non-interactive mode. Set PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1 and pass confirm=true to send.',
        );
      return;
    }
    await serialized(() => choose(config, ctx, options));
  };
}
