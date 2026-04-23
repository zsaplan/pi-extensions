import {basename} from 'node:path';
import type {ExtensionContext} from '@mariozechner/pi-coding-agent';
import type {DiscordConfig, NotifyEventName} from './config.ts';
import {ENABLED_ENV_VAR} from './config.ts';

export type MessageContext = Pick<ExtensionContext, 'cwd' | 'sessionManager'>;

export function getSessionLabel(ctx: MessageContext): string | null {
  const sessionName = ctx.sessionManager.getSessionName()?.trim();
  if (sessionName) return sessionName;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return null;

  return basename(sessionFile);
}

export function formatDuration(durationMs: number | null): string | null {
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

export function buildReadyMessage(
  ctx: MessageContext,
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

export function buildTestMessage(ctx: MessageContext): string {
  const lines = [
    '🧪 pi Discord notifications are configured.',
    `Project: ${basename(ctx.cwd)}`,
  ];
  const sessionLabel = getSessionLabel(ctx);
  if (sessionLabel) lines.push(`Session: ${sessionLabel}`);
  return lines.join('\n');
}

export function getStatusMessage(
  config: DiscordConfig,
  ctx: MessageContext,
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
