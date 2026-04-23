import type {ExtensionContext} from '@mariozechner/pi-coding-agent';
import type {DiscordSettings, NotifyEventName} from './config.ts';
import {readConfig} from './config.ts';
import {postToDiscord} from './discord.ts';
import {buildReadyMessage} from './messages.ts';

export type NotifyContext = Pick<
  ExtensionContext,
  'cwd' | 'hasUI' | 'sessionManager' | 'ui'
>;

export type NotifyLevel = 'info' | 'warning' | 'error';

export type SendDiscordWebhook = (
  settings: DiscordSettings,
  content: string,
) => Promise<void>;

export type SendAutomaticNotificationOptions = {
  env?: NodeJS.ProcessEnv;
  sendWebhook?: SendDiscordWebhook;
};

export function notifyUser(
  ctx: NotifyContext,
  message: string,
  level: NotifyLevel,
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

export function handleSendError(error: unknown, ctx: NotifyContext): void {
  const message = error instanceof Error ? error.message : String(error);
  notifyUser(ctx, `Discord notify failed: ${message}`, 'warning');
}

export async function sendAutomaticNotification(
  ctx: NotifyContext,
  eventName: NotifyEventName,
  durationMs: number | null,
  options: SendAutomaticNotificationOptions = {},
): Promise<void> {
  const config = readConfig(options.env);
  if (
    !config.enabled ||
    !config.settings ||
    config.settings.event !== eventName
  ) {
    return;
  }

  try {
    await (options.sendWebhook ?? postToDiscord)(
      config.settings,
      buildReadyMessage(ctx, eventName, durationMs),
    );
  } catch (error) {
    handleSendError(error, ctx);
  }
}
