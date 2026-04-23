import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENABLED_ENV_VAR,
  EVENT_ENV_VAR,
  FALLBACK_WEBHOOK_ENV_VAR,
  PRIMARY_WEBHOOK_ENV_VAR,
  USERNAME_ENV_VAR,
  parseBooleanValue,
  parseNotifyEvent,
  readConfig,
} from '../src/config.ts';

test('parseBooleanValue accepts common true and false spellings', () => {
  for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
    assert.equal(parseBooleanValue(value, false), true, value);
  }

  for (const value of ['0', 'false', 'FALSE', ' no ', 'off']) {
    assert.equal(parseBooleanValue(value, true), false, value);
  }
});

test('parseBooleanValue preserves defaults for missing or unknown values', () => {
  assert.equal(parseBooleanValue(undefined, true), true);
  assert.equal(parseBooleanValue('', false), false);
  assert.equal(parseBooleanValue('maybe', true), true);
  assert.equal(parseBooleanValue('maybe', false), false);
});

test('parseNotifyEvent defaults to agent_end unless turn_end is explicit', () => {
  assert.equal(parseNotifyEvent(undefined), 'agent_end');
  assert.equal(parseNotifyEvent('agent_end'), 'agent_end');
  assert.equal(parseNotifyEvent('turn_end'), 'turn_end');
  assert.equal(parseNotifyEvent('TURN_END'), 'agent_end');
  assert.equal(parseNotifyEvent(' other '), 'agent_end');
});

test('readConfig parses a configured primary webhook', () => {
  const config = readConfig({
    [PRIMARY_WEBHOOK_ENV_VAR]: ' https://discord.com/api/webhooks/abc ',
    [EVENT_ENV_VAR]: 'turn_end',
    [USERNAME_ENV_VAR]: ' helper ',
  });

  assert.deepEqual(config, {
    enabled: true,
    settings: {
      webhookUrl: 'https://discord.com/api/webhooks/abc',
      username: 'helper',
      event: 'turn_end',
    },
  });
});

test('readConfig accepts the legacy fallback webhook env var', () => {
  const config = readConfig({
    [FALLBACK_WEBHOOK_ENV_VAR]: 'https://discord.com/api/webhooks/fallback',
  });

  assert.equal(
    config.settings?.webhookUrl,
    'https://discord.com/api/webhooks/fallback',
  );
});

test('readConfig reports missing, invalid, and insecure webhook config', () => {
  assert.match(
    readConfig({}).problem ?? '',
    /Set PI_DISCORD_NOTIFY_WEBHOOK_URL/,
  );
  assert.match(
    readConfig({[PRIMARY_WEBHOOK_ENV_VAR]: 'not a url'}).problem ?? '',
    /not a valid URL/,
  );
  assert.match(
    readConfig({[PRIMARY_WEBHOOK_ENV_VAR]: 'http://example.com'}).problem ?? '',
    /must use https/,
  );
});

test('readConfig preserves disabled status even when config is missing', () => {
  const config = readConfig({[ENABLED_ENV_VAR]: 'false'});

  assert.equal(config.enabled, false);
  assert.equal(config.settings, null);
});
