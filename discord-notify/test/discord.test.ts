import assert from 'node:assert/strict';
import test from 'node:test';
import type {DiscordSettings} from '../src/config.ts';
import {
  DISCORD_CONTENT_LIMIT,
  postToDiscord,
  truncateDiscordContent,
} from '../src/discord.ts';

const settings: DiscordSettings = {
  webhookUrl: 'https://discord.com/api/webhooks/abc',
  username: 'pi',
  avatarUrl: 'https://example.com/pi.png',
  event: 'agent_end',
};

test('truncateDiscordContent keeps webhook content within Discord limits', () => {
  assert.equal(truncateDiscordContent('short'), 'short');

  const truncated = truncateDiscordContent(
    'x'.repeat(DISCORD_CONTENT_LIMIT + 10),
  );
  assert.equal(truncated.length, DISCORD_CONTENT_LIMIT);
  assert.match(truncated, /…$/);
});

test('postToDiscord sends a safe webhook payload', async () => {
  let requestUrl: Parameters<typeof fetch>[0] | undefined;
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return new Response('ok', {status: 200});
  };

  await postToDiscord(settings, 'hello <@123>', {fetchImpl});

  assert.equal(requestUrl, settings.webhookUrl);
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(requestInit?.headers, {'content-type': 'application/json'});
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    content: 'hello <@123>',
    username: 'pi',
    avatar_url: 'https://example.com/pi.png',
    allowed_mentions: {parse: []},
  });
});

test('postToDiscord throws a bounded error for non-2xx responses', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('x'.repeat(250), {
      status: 500,
      statusText: 'Server Error',
    });

  await assert.rejects(
    postToDiscord(settings, 'hello', {fetchImpl}),
    /Discord webhook returned 500 Server Error: x{200}$/,
  );
});

test('postToDiscord aborts requests after the configured timeout', async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);

    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };

  await assert.rejects(
    postToDiscord(settings, 'hello', {fetchImpl, timeoutMs: 1}),
    /aborted/,
  );
});
