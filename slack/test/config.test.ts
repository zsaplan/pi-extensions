import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOW_NONINTERACTIVE_WRITES_ENV_VAR,
  API_BASE_URL_ENV_VAR,
  PRIMARY_TOKEN_ENV_VAR,
  SKIP_SEND_CONFIRM_ENV_VAR,
  WRITE_TOKEN_ENV_VAR,
  getSlackConfigStatusMessage,
  getSlackWriteConfigStatusMessage,
  readSlackConfig,
  readSlackWriteConfig,
} from '../src/config.ts';

test('readSlackConfig reports missing token', () => {
  const status = readSlackConfig({});

  assert.equal(status.settings, undefined);
  assert.match(status.problem ?? '', /SLACK_USER_TOKEN/);
});

test('readSlackConfig reads SLACK_USER_TOKEN and parses safety flags', () => {
  const status = readSlackConfig({
    [PRIMARY_TOKEN_ENV_VAR]: ' xoxp-user ',
    [API_BASE_URL_ENV_VAR]: 'https://example.test/api/',
    [SKIP_SEND_CONFIRM_ENV_VAR]: 'true',
    [ALLOW_NONINTERACTIVE_WRITES_ENV_VAR]: '1',
  });

  assert.equal(status.settings?.token, 'xoxp-user');
  assert.equal(status.settings?.tokenSource, PRIMARY_TOKEN_ENV_VAR);
  assert.equal(status.settings?.apiBaseUrl, 'https://example.test/api');
  assert.equal(status.settings?.skipSendConfirm, true);
  assert.equal(status.settings?.allowNonInteractiveWrites, true);
  assert.match(getSlackConfigStatusMessage(status), /Slack user token loaded/);
});

test('readSlackWriteConfig reads SLACK_BOT_TOKEN for writes', () => {
  const status = readSlackWriteConfig({
    [PRIMARY_TOKEN_ENV_VAR]: 'xoxp-user',
    [WRITE_TOKEN_ENV_VAR]: ' xoxb-bot ',
  });

  assert.equal(status.settings?.token, 'xoxb-bot');
  assert.equal(status.settings?.tokenSource, WRITE_TOKEN_ENV_VAR);
  assert.match(
    getSlackWriteConfigStatusMessage(status),
    /Slack bot token loaded/,
  );
});
