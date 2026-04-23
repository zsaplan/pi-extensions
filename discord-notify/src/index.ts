import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from '@mariozechner/pi-coding-agent';
import {PRIMARY_WEBHOOK_ENV_VAR, readConfig} from './config.ts';
import {postToDiscord} from './discord.ts';
import {buildTestMessage, getStatusMessage} from './messages.ts';
import {
  handleSendError,
  notifyUser,
  sendAutomaticNotification,
} from './notify.ts';

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
