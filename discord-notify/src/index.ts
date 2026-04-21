import {basename} from 'node:path';
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from '@mariozechner/pi-coding-agent';

const PRIMARY_WEBHOOK_ENV_VAR = 'PI_DISCORD_NOTIFY_WEBHOOK_URL';
const FALLBACK_WEBHOOK_ENV_VAR = 'PI_DISCORD_WEBHOOK_URL';
const ENABLED_ENV_VAR = 'PI_DISCORD_NOTIFY_ENABLED';
const EVENT_ENV_VAR = 'PI_DISCORD_NOTIFY_EVENT';
const USERNAME_ENV_VAR = 'PI_DISCORD_NOTIFY_USERNAME';
const AVATAR_URL_ENV_VAR = 'PI_DISCORD_NOTIFY_AVATAR_URL';
const DEFAULT_USERNAME = 'pi';
const REQUEST_TIMEOUT_MS = 5_000;

type NotifyEventName = 'agent_end' | 'turn_end';

type DiscordSettings = {
  webhookUrl: string;
  username: string;
  avatarUrl?: string;
  event: NotifyEventName;
};

type DiscordConfig = {
  enabled: boolean;
  settings: DiscordSettings | null;
  problem?: string;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = readEnv(name);
  if (!value) return defaultValue;

  switch (value.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return defaultValue;
  }
}

function parseNotifyEvent(value: string | undefined): NotifyEventName {
  return value === 'turn_end' ? 'turn_end' : 'agent_end';
}

function getWebhookUrl(): string | undefined {
  return readEnv(PRIMARY_WEBHOOK_ENV_VAR) ?? readEnv(FALLBACK_WEBHOOK_ENV_VAR);
}

function readConfig(): DiscordConfig {
  const enabled = parseBooleanEnv(ENABLED_ENV_VAR, true);
  const webhookUrl = getWebhookUrl();

  if (!webhookUrl) {
    return {
      enabled,
      settings: null,
      problem: `Set ${PRIMARY_WEBHOOK_ENV_VAR} to enable Discord notifications.`,
    };
  }

  try {
    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== 'https:') {
      return {
        enabled,
        settings: null,
        problem: `${PRIMARY_WEBHOOK_ENV_VAR} must use https.`,
      };
    }

    return {
      enabled,
      settings: {
        webhookUrl: parsed.toString(),
        username: readEnv(USERNAME_ENV_VAR) ?? DEFAULT_USERNAME,
        avatarUrl: readEnv(AVATAR_URL_ENV_VAR),
        event: parseNotifyEvent(readEnv(EVENT_ENV_VAR)),
      },
    };
  } catch {
    return {
      enabled,
      settings: null,
      problem: `${PRIMARY_WEBHOOK_ENV_VAR} is not a valid URL.`,
    };
  }
}

function getSessionLabel(ctx: ExtensionContext): string | null {
  const sessionName = ctx.sessionManager.getSessionName()?.trim();
  if (sessionName) return sessionName;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return null;

  return basename(sessionFile);
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

function buildReadyMessage(
  ctx: ExtensionContext,
  eventName: NotifyEventName,
  durationMs: number | null,
): string {
  const firstLine =
    eventName === 'turn_end'
      ? '🔔 pi finished a turn'
      : '🔔 pi is ready for input';
  const lines = [firstLine, `Project: ${basename(ctx.cwd)}`];
  const sessionLabel = getSessionLabel(ctx);
  const duration = formatDuration(durationMs);

  if (sessionLabel) lines.push(`Session: ${sessionLabel}`);
  if (duration) lines.push(`Elapsed: ${duration}`);

  return lines.join('\n');
}

function buildTestMessage(ctx: ExtensionContext): string {
  const lines = [
    '🧪 pi Discord notifications are configured.',
    `Project: ${basename(ctx.cwd)}`,
  ];
  const sessionLabel = getSessionLabel(ctx);
  if (sessionLabel) lines.push(`Session: ${sessionLabel}`);
  return lines.join('\n');
}

async function postToDiscord(
  settings: DiscordSettings,
  content: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(settings.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content,
        username: settings.username,
        avatar_url: settings.avatarUrl,
        allowed_mentions: {parse: []},
      }),
      signal: controller.signal,
    });

    if (response.ok) return;

    const responseText = (await response.text()).trim();
    const suffix =
      responseText.length > 0 ? `: ${responseText.slice(0, 200)}` : '';
    throw new Error(
      `Discord webhook returned ${response.status} ${response.statusText}${suffix}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function getStatusMessage(
  config: DiscordConfig,
  ctx: ExtensionContext,
): string {
  if (!config.settings) {
    if (!config.enabled) {
      return `Discord notifications are disabled via ${ENABLED_ENV_VAR}.`;
    }
    return config.problem ?? 'Discord notifications are not configured.';
  }

  const state = config.enabled ? 'enabled' : 'configured but disabled';
  const sessionLabel = getSessionLabel(ctx);
  const location = sessionLabel
    ? `${basename(ctx.cwd)} / ${sessionLabel}`
    : basename(ctx.cwd);

  return `Discord notifications are ${state} (${config.settings.event}) for ${location}.`;
}

function notifyUser(
  ctx: ExtensionContext,
  message: string,
  level: 'info' | 'warning' | 'error',
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }

  const prefix = `[discord-notify] ${message}`;
  if (level === 'info') {
    console.log(prefix);
  } else {
    console.warn(prefix);
  }
}

function handleSendError(error: unknown, ctx: ExtensionContext): void {
  const message = error instanceof Error ? error.message : String(error);
  notifyUser(ctx, `Discord notify failed: ${message}`, 'warning');
}

async function sendAutomaticNotification(
  ctx: ExtensionContext,
  eventName: NotifyEventName,
  durationMs: number | null,
): Promise<void> {
  const config = readConfig();
  if (
    !config.enabled ||
    !config.settings ||
    config.settings.event !== eventName
  ) {
    return;
  }

  try {
    await postToDiscord(
      config.settings,
      buildReadyMessage(ctx, eventName, durationMs),
    );
  } catch (error) {
    handleSendError(error, ctx);
  }
}

export default function (pi: ExtensionAPI) {
  const agentStartedAtBySession = new Map<string, number>();
  const turnStartedAtBySession = new Map<string, number>();

  pi.on('agent_start', (_event, ctx) => {
    agentStartedAtBySession.set(ctx.sessionManager.getSessionId(), Date.now());
  });

  pi.on('turn_start', (_event, ctx) => {
    turnStartedAtBySession.set(ctx.sessionManager.getSessionId(), Date.now());
  });

  pi.on('turn_end', (_event: TurnEndEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const startedAt = turnStartedAtBySession.get(sessionId);
    const durationMs = startedAt === undefined ? null : Date.now() - startedAt;
    turnStartedAtBySession.delete(sessionId);
    void sendAutomaticNotification(ctx, 'turn_end', durationMs);
  });

  pi.on('agent_end', (_event: AgentEndEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const startedAt = agentStartedAtBySession.get(sessionId);
    const durationMs = startedAt === undefined ? null : Date.now() - startedAt;
    agentStartedAtBySession.delete(sessionId);
    void sendAutomaticNotification(ctx, 'agent_end', durationMs);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    agentStartedAtBySession.delete(sessionId);
    turnStartedAtBySession.delete(sessionId);
  });

  pi.registerCommand('discord-notify', {
    description: 'Show Discord notification status or send a test webhook',
    handler: async (args, ctx) => {
      const action = (args ?? '').trim().toLowerCase();
      const config = readConfig();

      if (!action) {
        notifyUser(
          ctx,
          getStatusMessage(config, ctx),
          config.settings ? 'info' : 'warning',
        );
        return;
      }

      if (action !== 'test') {
        notifyUser(ctx, 'Usage: /discord-notify [test]', 'warning');
        return;
      }

      if (!config.settings) {
        notifyUser(
          ctx,
          config.problem ??
            `Set ${PRIMARY_WEBHOOK_ENV_VAR} to enable Discord notifications.`,
          'warning',
        );
        return;
      }

      try {
        await postToDiscord(config.settings, buildTestMessage(ctx));
        notifyUser(ctx, 'Sent Discord test notification.', 'info');
      } catch (error) {
        handleSendError(error, ctx);
      }
    },
  });
}
