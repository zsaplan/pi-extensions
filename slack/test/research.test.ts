import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSnippet,
  extractQueryTerms,
  formatResearchResult,
  parseSlackTimeBound,
  researchSlackMessages,
  scoreSlackText,
} from '../src/research.ts';
import type {SlackApiCaller} from '../src/slack.ts';

class FakeSlackClient implements SlackApiCaller {
  readonly calls: Array<{method: string; body: Record<string, unknown>}> = [];
  private readonly responses: Record<string, unknown>[];

  constructor(responses: Record<string, unknown>[]) {
    this.responses = responses;
  }

  async call<T>(
    method: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({method, body});
    const response = this.responses.shift();
    if (!response) throw new Error(`No fake response for ${method}`);
    return response as T;
  }
}

test('extractQueryTerms keeps quoted phrases and useful words', () => {
  assert.deepEqual(extractQueryTerms('"month end" celery failures'), [
    'month end',
    'celery',
    'failures',
  ]);
});

test('scoreSlackText ranks exact query and term matches', () => {
  const terms = extractQueryTerms('policy migration');
  const score = scoreSlackText(
    'The policy migration migration blocker is fixed.',
    'policy migration',
    terms,
  );

  assert.ok(score.score > 10);
  assert.deepEqual(score.matchedTerms, ['policy', 'migration']);
});

test('buildSnippet centers snippets around the first match', () => {
  const snippet = buildSnippet(`${'before '.repeat(80)}needle after`, [
    'needle',
  ]);

  assert.match(snippet, /needle/);
  assert.match(snippet, /^…/);
});

test('parseSlackTimeBound accepts numeric and ISO bounds', () => {
  assert.equal(parseSlackTimeBound('1700000000.000100'), '1700000000.000100');
  assert.match(parseSlackTimeBound('2026-06-02T00:00:00Z') ?? '', /^\d+$/);
});

test('researchSlackMessages scans selected channels and sorts hits by score', async () => {
  const client = new FakeSlackClient([
    {
      ok: true,
      channels: [{id: 'C1', name: 'general'}],
      response_metadata: {},
    },
    {
      ok: true,
      messages: [
        {ts: '2.0', user: 'U2', text: 'migration'},
        {ts: '1.0', user: 'U1', text: 'policy migration migration'},
      ],
      response_metadata: {},
    },
  ]);

  const result = await researchSlackMessages(client, {
    query: 'policy migration',
    channels: ['#general'],
    maxResults: 2,
  });

  assert.equal(result.searchedMessages, 2);
  assert.deepEqual(
    result.hits.map(hit => hit.message.ts),
    ['1.0', '2.0'],
  );
  assert.match(formatResearchResult(result), /#general/);
  assert.equal(client.calls[0].method, 'users.conversations');
  assert.equal(client.calls[1].method, 'conversations.history');
});

test('researchSlackMessages can scan member channels, thread replies, and permalinks', async () => {
  const client = new FakeSlackClient([
    {
      ok: true,
      channels: [{id: 'C1', name: 'general'}],
      response_metadata: {},
    },
    {
      ok: true,
      messages: [{ts: '1.0', user: 'U1', text: 'parent', reply_count: 1}],
      response_metadata: {},
    },
    {
      ok: true,
      messages: [
        {ts: '1.0', user: 'U1', text: 'parent', reply_count: 1},
        {ts: '2.0', user: 'U2', text: 'needle in reply'},
      ],
      response_metadata: {},
    },
    {
      ok: true,
      permalink: 'https://example.test/archives/C1/p2',
    },
  ]);

  const result = await researchSlackMessages(client, {
    channelSource: 'member',
    includePermalinks: true,
    includeThreadReplies: true,
    oldest: '2026-06-02T00:00:00Z',
    query: 'needle',
  });

  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].isThreadReply, true);
  assert.equal(result.hits[0].threadTs, '1.0');
  assert.equal(result.hits[0].permalink, 'https://example.test/archives/C1/p2');
  assert.equal(result.searchedMessages, 2);
  assert.equal(client.calls[0].method, 'users.conversations');
  assert.equal(client.calls[1].method, 'conversations.history');
  assert.equal(client.calls[2].method, 'conversations.replies');
  assert.equal(client.calls[3].method, 'chat.getPermalink');
});
