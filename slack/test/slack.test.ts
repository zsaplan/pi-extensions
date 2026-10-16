import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectSlackWarnings,
  deleteMessage,
  formatConversationLine,
  formatMessageLine,
  parseSlackPermalink,
  prepareSlackMessageText,
  listConversations,
  listUserConversations,
  readConversationHistory,
  resolveConversation,
  updateMessage,
  type SlackApiCaller,
} from '../src/slack.ts';

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

test('listConversations paginates and filters by name', async () => {
  const client = new FakeSlackClient([
    {
      ok: true,
      channels: [
        {id: 'C1', name: 'general'},
        {id: 'C2', name: 'platform-alerts'},
      ],
      response_metadata: {next_cursor: 'next'},
    },
    {
      ok: true,
      channels: [{id: 'C3', name: 'platform-team'}],
      response_metadata: {},
    },
  ]);

  const channels = await listConversations(client, {
    limit: 2,
    nameContains: 'platform',
  });

  assert.deepEqual(
    channels.map(channel => channel.id),
    ['C2', 'C3'],
  );
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].body.cursor, 'next');
});

test('listUserConversations paginates through member conversations', async () => {
  const client = new FakeSlackClient([
    {
      ok: true,
      channels: [{id: 'C1', name: 'general'}],
      response_metadata: {next_cursor: 'next'},
    },
    {
      ok: true,
      channels: [{id: 'C2', name: 'ops'}],
      response_metadata: {},
    },
  ]);

  const channels = await listUserConversations(client, {
    limit: 2,
    user: 'U1',
  });

  assert.deepEqual(
    channels.map(channel => channel.id),
    ['C1', 'C2'],
  );
  assert.equal(client.calls[0].method, 'users.conversations');
  assert.equal(client.calls[0].body.user, 'U1');
  assert.equal(client.calls[1].body.cursor, 'next');
});

test('resolveConversation returns IDs directly and resolves names from list', async () => {
  const direct = await resolveConversation(
    new FakeSlackClient([]),
    'C12345678',
  );
  assert.deepEqual(direct, {id: 'C12345678'});

  const client = new FakeSlackClient([
    {
      ok: true,
      channels: [{id: 'C2', name: 'engineering'}],
      response_metadata: {},
    },
  ]);
  const resolved = await resolveConversation(client, '#engineering');

  assert.equal(resolved.id, 'C2');
  assert.equal(client.calls[0].method, 'users.conversations');
});

test('filtered listing uses full pages and normalizes a leading hash', async () => {
  const client = new FakeSlackClient([
    {ok: true, channels: [{id: 'C1', name: 'mcp-testing'}]},
  ]);
  const result = await listConversations(client, {
    nameContains: '#MCP-testing',
    limit: 1,
  });
  assert.equal(result[0].id, 'C1');
  assert.equal(client.calls[0].body.limit, 200);
  assert.equal(client.calls[0].body.exclude_archived, true);
});

test('listing rejects repeated pages, repeated cursors, and exhausted budgets', async () => {
  const page = {
    ok: true,
    channels: [{id: 'C1', name: 'other'}],
    response_metadata: {next_cursor: 'a'},
  };
  await assert.rejects(
    listConversations(
      new FakeSlackClient([
        page,
        {...page, response_metadata: {next_cursor: 'b'}},
      ]),
      {nameContains: 'missing'},
    ),
    /repeated_page/,
  );
  await assert.rejects(
    listUserConversations(
      new FakeSlackClient([
        page,
        {ok: true, channels: [], response_metadata: {next_cursor: 'a'}},
      ]),
      {nameContains: 'missing'},
    ),
    /repeated_cursor/,
  );
  await assert.rejects(
    listConversations(new FakeSlackClient([page]), {
      nameContains: 'missing',
      maxPages: 1,
    }),
    /page_budget/,
  );
});

test('readConversationHistory paginates up to the requested limit', async () => {
  const client = new FakeSlackClient([
    {
      ok: true,
      messages: [{ts: '2.0', text: 'newer'}],
      response_metadata: {next_cursor: 'next'},
    },
    {
      ok: true,
      messages: [{ts: '1.0', text: 'older'}],
      response_metadata: {},
    },
  ]);

  const messages = await readConversationHistory(client, 'C1', {limit: 2});

  assert.deepEqual(
    messages.map(message => message.text),
    ['newer', 'older'],
  );
  assert.equal(client.calls[1].body.cursor, 'next');
});

test('format helpers produce concise Slack labels and optional verbatim text', () => {
  assert.equal(
    formatConversationLine({
      id: 'C1',
      name: 'general',
      is_private: false,
      num_members: 3,
    }),
    '#general (C1) · public, 3 members',
  );
  assert.match(
    formatMessageLine({ts: '1700000000.000100', user: 'U1', text: 'hello'}),
    /U1: hello/,
  );
  assert.match(
    formatMessageLine(
      {ts: '1700000000.000100', user: 'U1', text: '```sql\nselect 1;\n```'},
      {formatMode: 'verbatim'},
    ),
    /U1:\n```sql\nselect 1;\n```/,
  );
});

test('parseSlackPermalink extracts channel, message ts, and thread ts', () => {
  assert.deepEqual(
    parseSlackPermalink(
      'https://britecore.slack.com/archives/C0AC144E88H/p1783443582237699?thread_ts=1783434670.186409&cid=C0AC144E88H',
    ),
    {
      channel: 'C0AC144E88H',
      messageTs: '1783443582.237699',
      threadTs: '1783434670.186409',
    },
  );
});

test('prepareSlackMessageText rejects long text by default', () => {
  assert.throws(
    () => prepareSlackMessageText('x'.repeat(600), {maxChars: 500}),
    /longTextMode="split"/,
  );
});

test('prepareSlackMessageText splits long code blocks with balanced fences', () => {
  const text = `intro\n\`\`\`sql\n${'select 1;\n'.repeat(80)}\`\`\`\noutro`;
  const prepared = prepareSlackMessageText(text, {
    longTextMode: 'split',
    maxChars: 500,
  });

  assert.ok(prepared.chunks.length > 1);
  for (const chunk of prepared.chunks) {
    assert.ok(chunk.length <= 500);
    const fenceCount = (chunk.match(/```/g) ?? []).length;
    assert.equal(fenceCount % 2, 0, chunk);
  }
});

test('updateMessage and deleteMessage call Slack chat methods', async () => {
  const client = new FakeSlackClient([
    {ok: true, channel: 'C1', ts: '1.0'},
    {ok: true, channel: 'C1', ts: '1.0'},
  ]);

  await updateMessage(client, {
    channel: 'C1',
    text: 'updated',
    ts: '1.0',
  });
  await deleteMessage(client, {channel: 'C1', ts: '1.0'});

  assert.equal(client.calls[0].method, 'chat.update');
  assert.equal(client.calls[0].body.text, 'updated');
  assert.equal(client.calls[1].method, 'chat.delete');
});

test('collectSlackWarnings includes top-level and response metadata warnings', () => {
  assert.deepEqual(
    collectSlackWarnings({
      ok: true,
      warning: 'top_warning',
      response_metadata: {warnings: ['metadata_warning', 'top_warning']},
    }),
    ['top_warning', 'metadata_warning'],
  );
});
