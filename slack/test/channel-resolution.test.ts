import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveChannel} from '../src/channel-resolution.ts';
import {
  SlackApiError,
  type SlackApiCaller,
  type SlackApiEnvelope,
} from '../src/slack.ts';

class Client implements SlackApiCaller {
  calls: {method: string; body?: Record<string, unknown>}[] = [];
  responses: (Record<string, unknown> | Error)[];
  resolutionCacheKey?: string;
  constructor(responses: (Record<string, unknown> | Error)[], key?: string) {
    this.responses = responses;
    this.resolutionCacheKey = key;
  }
  async call<T extends SlackApiEnvelope>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({method, body});
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, `Unexpected call ${method}`);
    return response as T;
  }
}
const target = {
  id: 'C12345678',
  name: 'mcp-testing',
  is_private: false,
  is_archived: false,
};
const page = (channels: Record<string, unknown>[] = [], cursor?: string) => ({
  ok: true,
  channels,
  response_metadata: {next_cursor: cursor},
});

test('resolves normalized exact names membership-first with allowlisted metadata', async () => {
  const client = new Client([page([{...target, secret: 'not returned'}])]);
  const result = await resolveChannel(client, ' #MCP-testing ');
  assert.equal(result.status, 'found');
  assert.equal(result.source, 'member');
  assert.equal(result.channel?.id, target.id);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'users.conversations');
  assert.equal(client.calls[0].body?.types, 'public_channel');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('falls back to visible channels, matches exactly, and skips archived channels', async () => {
  const client = new Client([
    page([{...target, id: 'Cprefix', name: 'mcp-testing-other'}]),
    page([{...target, id: 'Carchived', is_archived: true}], 'next'),
    page([target]),
  ]);
  const result = await resolveChannel(client, '#mcp-testing');
  assert.equal(result.source, 'visible');
  assert.equal(result.pagesScanned, 3);
  assert.equal(result.uniqueChannelsScanned, 3);
  assert.equal(client.calls[1].method, 'conversations.list');
  assert.equal(client.calls[2].body?.cursor, 'next');
});

test('private and archived channels require explicit options', async () => {
  const channel = {...target, is_private: true, is_archived: true};
  assert.equal(
    (
      await resolveChannel(
        new Client([page([channel]), page([channel])]),
        target.name,
      )
    ).status,
    'not_found',
  );
  const client = new Client([page([channel])]);
  assert.equal(
    (
      await resolveChannel(client, target.name, {
        includePrivate: true,
        includeArchived: true,
      })
    ).status,
    'found',
  );
  assert.equal(client.calls[0].body?.exclude_archived, false);
  assert.equal(client.calls[0].body?.types, 'public_channel,private_channel');
});

test('ID lookup validates metadata without enumerating channels', async () => {
  const client = new Client([{ok: true, channel: target}]);
  assert.equal((await resolveChannel(client, target.id)).source, 'id');
  assert.equal(client.calls[0].method, 'conversations.info');
});

test('budget exhaustion is incomplete, not a nonexistent channel', async () => {
  const client = new Client([
    page([], 'm1'),
    page([], 'm2'),
    page([], 'm3'),
    page([], 'v1'),
    page([], 'v2'),
    page([], 'v3'),
  ]);
  const result = await resolveChannel(client, target.name);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.pagesScanned, 6);
  assert.equal(client.calls.length, 6);
  assert.match(result.reason!, /page_budget/);
});

test('repeated pages stop lookup instead of starting a broader scan', async () => {
  const client = new Client([
    page([{id: 'Cother'}], 'm1'),
    page([{id: 'Cother'}], 'm2'),
  ]);
  const result = await resolveChannel(client, target.name);
  assert.equal(result.status, 'incomplete');
  assert.match(result.reason!, /repeated_page/);
  assert.equal(result.uniqueChannelsScanned, 1);
  assert.equal(client.calls.length, 2);
});

test('rate limit and missing scopes have explicit outcomes and no retries', async () => {
  const client = new Client([
    new SlackApiError('users.conversations', 'retry after 30 seconds', {
      status: 429,
    }),
  ]);
  const rate = await resolveChannel(client, target.name);
  assert.equal(rate.status, 'rate_limited');
  assert.equal(rate.retryAfterSeconds, 30);
  assert.equal(client.calls.length, 1);
  const scope = new Client([
    new SlackApiError('users.conversations', 'missing_scope', {
      slackError: 'missing_scope',
    }),
  ]);
  assert.equal(
    (await resolveChannel(scope, target.name)).status,
    'missing_scope',
  );
  assert.equal(scope.calls.length, 1);
});

test('cache is revalidated, detects renames, expires, and stays token/API-isolated', async t => {
  const first = new Client([page([target])], 'cache-test-identity');
  await resolveChannel(first, target.name);
  const cached = new Client(
    [{ok: true, channel: target}],
    'cache-test-identity',
  );
  assert.equal((await resolveChannel(cached, target.name)).source, 'cache');
  assert.equal(cached.calls[0].method, 'conversations.info');
  const isolated = new Client([page([target])], 'different-identity');
  assert.equal((await resolveChannel(isolated, target.name)).source, 'member');
  const renamed = new Client(
    [
      {ok: true, channel: {...target, name: 'renamed'}},
      page([{...target, id: 'C87654321'}]),
    ],
    'cache-test-identity',
  );
  assert.equal(
    (await resolveChannel(renamed, target.name)).channel?.id,
    'C87654321',
  );
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 6 * 60 * 1000);
  const expired = new Client([page([target])], 'cache-test-identity');
  assert.equal((await resolveChannel(expired, target.name)).source, 'member');
});

test('explicit page budget can find matches beyond the old 1000-conversation cap', async () => {
  const responses = [page()];
  for (let i = 0; i < 5; i++)
    responses.push(
      page(
        Array.from({length: 200}, (_, j) => ({
          id: `C${i}-${j}`,
          name: `other-${i}-${j}`,
        })),
        `v${i}`,
      ),
    );
  responses.push(page([target]));
  const result = await resolveChannel(new Client(responses), target.name, {
    maxPages: 8,
  });
  assert.equal(result.status, 'found');
  assert.equal(result.uniqueChannelsScanned, 1001);
});

test('cancellation and invalid budgets cause no API calls', async () => {
  const client = new Client([]);
  await assert.rejects(
    resolveChannel(client, target.name, {}, AbortSignal.abort()),
  );
  await assert.rejects(resolveChannel(client, target.name, {maxPages: 100}));
  assert.equal(client.calls.length, 0);
});
