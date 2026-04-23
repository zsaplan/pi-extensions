import assert from 'node:assert/strict';
import test from 'node:test';
import type {MessageContext} from '../src/messages.ts';
import {
  buildReadyMessage,
  buildTestMessage,
  formatDuration,
  getStatusMessage,
} from '../src/messages.ts';

function makeContext(
  options: {
    cwd?: string;
    sessionName?: string | null;
    sessionFile?: string | null;
  } = {},
): MessageContext {
  return {
    cwd: options.cwd ?? '/tmp/example-project',
    sessionManager: {
      getSessionName: () => options.sessionName ?? null,
      getSessionFile: () => options.sessionFile ?? null,
    },
  } as MessageContext;
}

test('formatDuration returns compact human-readable elapsed time', () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(Number.NaN), null);
  assert.equal(formatDuration(-1), null);
  assert.equal(formatDuration(1), '1s');
  assert.equal(formatDuration(1_499), '1s');
  assert.equal(formatDuration(61_000), '1m 1s');
  assert.equal(formatDuration(3_661_000), '1h 1m 1s');
});

test('buildReadyMessage includes event, project, session, and duration', () => {
  const message = buildReadyMessage(
    makeContext({sessionName: 'session-a'}),
    'turn_end',
    61_000,
  );

  assert.equal(
    message,
    [
      '🔔 pi finished a turn',
      'Project: example-project',
      'Session: session-a',
      'Elapsed: 1m 1s',
    ].join('\n'),
  );
});

test('buildReadyMessage falls back to session filename and omits duration', () => {
  const message = buildReadyMessage(
    makeContext({sessionFile: '/tmp/sessions/example.jsonl'}),
    'agent_end',
    null,
  );

  assert.equal(
    message,
    [
      '🔔 pi is ready for input',
      'Project: example-project',
      'Session: example.jsonl',
    ].join('\n'),
  );
});

test('buildTestMessage is compact and context-specific', () => {
  assert.equal(
    buildTestMessage(makeContext({sessionName: 'manual-check'})),
    [
      '🧪 pi Discord notifications are configured.',
      'Project: example-project',
      'Session: manual-check',
    ].join('\n'),
  );
});

test('getStatusMessage distinguishes ready, disabled, and missing config', () => {
  const ctx = makeContext({sessionName: 'status-session'});

  assert.equal(
    getStatusMessage(
      {
        enabled: true,
        settings: {
          webhookUrl: 'https://discord.com/api/webhooks/abc',
          username: 'pi',
          event: 'agent_end',
        },
      },
      ctx,
    ),
    'Discord notifications are enabled (agent_end) for example-project / status-session.',
  );

  assert.equal(
    getStatusMessage(
      {
        enabled: false,
        settings: {
          webhookUrl: 'https://discord.com/api/webhooks/abc',
          username: 'pi',
          event: 'turn_end',
        },
      },
      ctx,
    ),
    'Discord notifications are configured but disabled (turn_end) for example-project / status-session.',
  );

  assert.equal(
    getStatusMessage({enabled: false, settings: null}, ctx),
    'Discord notifications are disabled via PI_DISCORD_NOTIFY_ENABLED.',
  );

  assert.equal(
    getStatusMessage({enabled: true, settings: null, problem: 'Missing.'}, ctx),
    'Missing.',
  );
});
