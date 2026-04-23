import assert from 'node:assert/strict';
import test from 'node:test';
import type {DiscordSettings} from '../src/config.ts';
import {EVENT_ENV_VAR, PRIMARY_WEBHOOK_ENV_VAR} from '../src/config.ts';
import type {NotifyContext} from '../src/notify.ts';
import {sendAutomaticNotification} from '../src/notify.ts';

function makeContext(notifications: string[] = []): NotifyContext {
  return {
    cwd: '/tmp/example-project',
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push(`${level}: ${message}`);
      },
    },
    sessionManager: {
      getSessionId: () => 'session-id',
      getSessionName: () => 'session-name',
      getSessionFile: () => null,
    },
  } as unknown as NotifyContext;
}

test('sendAutomaticNotification sends only for enabled matching events', async () => {
  const sent: Array<{settings: DiscordSettings; content: string}> = [];
  const sendWebhook = async (
    settings: DiscordSettings,
    content: string,
  ): Promise<void> => {
    sent.push({settings, content});
  };

  await sendAutomaticNotification(makeContext(), 'agent_end', 1_000, {
    env: {
      [PRIMARY_WEBHOOK_ENV_VAR]: 'https://discord.com/api/webhooks/abc',
      [EVENT_ENV_VAR]: 'turn_end',
    },
    sendWebhook,
  });
  await sendAutomaticNotification(makeContext(), 'turn_end', 1_000, {
    env: {
      [PRIMARY_WEBHOOK_ENV_VAR]: 'https://discord.com/api/webhooks/abc',
      [EVENT_ENV_VAR]: 'turn_end',
    },
    sendWebhook,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.settings.event, 'turn_end');
  assert.match(sent[0]?.content ?? '', /pi finished a turn/);
});

test('sendAutomaticNotification swallows webhook failures and warns', async () => {
  const notifications: string[] = [];

  await assert.doesNotReject(
    sendAutomaticNotification(makeContext(notifications), 'agent_end', null, {
      env: {
        [PRIMARY_WEBHOOK_ENV_VAR]: 'https://discord.com/api/webhooks/abc',
      },
      sendWebhook: async () => {
        throw new Error('network down');
      },
    }),
  );

  assert.deepEqual(notifications, [
    'warning: Discord notify failed: network down',
  ]);
});
