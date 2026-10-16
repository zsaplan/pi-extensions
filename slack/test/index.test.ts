import assert from 'node:assert/strict';
import test from 'node:test';
import slackExtension from '../src/index.ts';

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface ToolTextResult {
  content: Array<{type: string; text: string}>;
  details?: Record<string, unknown>;
}

interface SlackFetchCall {
  authorization: string | undefined;
  body: Record<string, unknown>;
  contentType: string | undefined;
  method: string;
}

function restoreEnv(originals: Map<string, string | undefined>): void {
  for (const [name, value] of originals) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function registerSlackTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  slackExtension({
    on() {},
    registerCommand() {},
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);
  return tools;
}

function setupSlackEnv(
  t: {after: (callback: () => void) => void},
  responseForCall: (
    call: SlackFetchCall,
    index: number,
  ) => Record<string, unknown>,
): {calls: SlackFetchCall[]; tools: Map<string, RegisteredTool>} {
  const envVars = [
    'SLACK_USER_TOKEN',
    'SLACK_BOT_TOKEN',
    'PI_SLACK_API_BASE_URL',
    'PI_SLACK_ALLOW_NONINTERACTIVE_WRITES',
    'PI_SLACK_SKIP_SEND_CONFIRM',
  ];
  const originalEnv = new Map(
    envVars.map(name => [name, process.env[name]] as const),
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(originalEnv);
    globalThis.fetch = originalFetch;
  });

  process.env.SLACK_USER_TOKEN = 'xoxp-user';
  process.env.SLACK_BOT_TOKEN = 'xoxb-bot';
  process.env.PI_SLACK_API_BASE_URL = 'https://slack.test/api';
  process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES = '1';
  delete process.env.PI_SLACK_SKIP_SEND_CONFIRM;

  const calls: SlackFetchCall[] = [];
  globalThis.fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const contentType = headers?.['Content-Type'] ?? headers?.['content-type'];
    const rawBody = String(init?.body ?? '');
    const body = contentType?.startsWith('application/x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(rawBody))
      : (JSON.parse(rawBody || '{}') as Record<string, unknown>);
    const call = {
      authorization: headers?.Authorization ?? headers?.authorization,
      body,
      contentType,
      method: String(input).split('/').pop() ?? '',
    };
    calls.push(call);

    return new Response(JSON.stringify(responseForCall(call, calls.length)), {
      status: 200,
    });
  };

  return {calls, tools: registerSlackTools()};
}

function textFromResult(result: unknown): string {
  return ((result as ToolTextResult).content[0]?.text ?? '').toString();
}

test('channel resolver encodes both listings as forms, preserves cursors, and validates cached IDs', async t => {
  const channel = {
    id: 'C12345678',
    name: 'mcp-testing',
    is_private: false,
    is_archived: false,
  };
  const {tools, calls} = setupSlackEnv(t, call => {
    assert.match(call.contentType!, /^application\/x-www-form-urlencoded/);
    if (call.method === 'conversations.info') return {ok: true, channel};
    assert.equal(call.body.exclude_archived, 'true');
    assert.equal(call.body.limit, '200');
    assert.equal(call.body.types, 'public_channel');
    if (call.method === 'users.conversations') return {ok: true, channels: []};
    assert.equal(call.method, 'conversations.list');
    return call.body.cursor === 'next-page'
      ? {ok: true, channels: [channel]}
      : {
          ok: true,
          channels: [{id: 'Cother', name: 'other'}],
          response_metadata: {next_cursor: 'next-page'},
        };
  });
  const run = (tokenKind = 'user') =>
    tools
      .get('slack_resolve_channel')!
      .execute(
        'test',
        {name: '#mcp-testing', tokenKind},
        undefined,
        undefined,
        {hasUI: false},
      );
  const first = (await run()) as ToolTextResult;
  assert.equal(first.details?.status, 'found');
  assert.equal(first.details?.source, 'visible');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.cursor, 'next-page');
  assert.ok(calls.every(call => call.authorization === 'Bearer xoxp-user'));
  const cached = (await run()) as ToolTextResult;
  assert.equal(cached.details?.source, 'cache');
  assert.equal(calls.length, 4);
  assert.equal(calls[3].method, 'conversations.info');
  const bot = (await run('bot')) as ToolTextResult;
  assert.equal(bot.details?.source, 'visible');
  assert.ok(
    calls.slice(4).every(call => call.authorization === 'Bearer xoxb-bot'),
  );
});

test('slack_post_message uses SLACK_BOT_TOKEN for chat writes', async t => {
  const envVars = [
    'SLACK_USER_TOKEN',
    'SLACK_BOT_TOKEN',
    'PI_SLACK_API_BASE_URL',
    'PI_SLACK_ALLOW_NONINTERACTIVE_WRITES',
    'PI_SLACK_SKIP_SEND_CONFIRM',
  ];
  const originalEnv = new Map(
    envVars.map(name => [name, process.env[name]] as const),
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    restoreEnv(originalEnv);
    globalThis.fetch = originalFetch;
  });

  process.env.SLACK_USER_TOKEN = 'xoxp-user';
  process.env.SLACK_BOT_TOKEN = 'xoxb-bot';
  process.env.PI_SLACK_API_BASE_URL = 'https://slack.test/api';
  process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES = '1';
  delete process.env.PI_SLACK_SKIP_SEND_CONFIRM;

  const calls: Array<{
    authorization: string | undefined;
    body: Record<string, unknown>;
    method: string;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      authorization: headers?.Authorization ?? headers?.authorization,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      method: String(input).split('/').pop() ?? '',
    });

    return new Response(
      JSON.stringify({ok: true, channel: 'C12345678', ts: '1.0'}),
      {status: 200},
    );
  };

  const tools = new Map<string, RegisteredTool>();
  slackExtension({
    on() {},
    registerCommand() {},
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);

  const postMessage = tools.get('slack_post_message');
  assert.ok(postMessage);

  await postMessage.execute(
    'tool-call-id',
    {channel: 'C12345678', confirm: true, text: 'hello'},
    undefined,
    undefined,
    {hasUI: false},
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'chat.postMessage');
  assert.equal(calls[0].authorization, 'Bearer xoxb-bot');
  assert.equal(calls[0].body.text, 'hello');
});

test('slack_post_message rejects long text before sending by default', async t => {
  const {calls, tools} = setupSlackEnv(t, () => ({
    ok: true,
    channel: 'C12345678',
    ts: '1.0',
  }));
  const postMessage = tools.get('slack_post_message');
  assert.ok(postMessage);

  await assert.rejects(
    () =>
      postMessage.execute(
        'tool-call-id',
        {
          channel: 'C12345678',
          confirm: true,
          maxChars: 500,
          text: 'x'.repeat(600),
        },
        undefined,
        undefined,
        {hasUI: false},
      ),
    /longTextMode="split"/,
  );
  assert.equal(calls.length, 0);
});

test('slack_post_message splits long text and returns all part timestamps', async t => {
  const {calls, tools} = setupSlackEnv(t, (_call, index) => ({
    ok: true,
    channel: 'C12345678',
    ts: `${index}.0`,
  }));
  const postMessage = tools.get('slack_post_message');
  assert.ok(postMessage);

  const result = await postMessage.execute(
    'tool-call-id',
    {
      channel: 'C12345678',
      confirm: true,
      longTextMode: 'split',
      maxChars: 500,
      text: 'line\n'.repeat(180),
    },
    undefined,
    undefined,
    {hasUI: false},
  );

  assert.ok(calls.length > 1);
  assert.ok(calls.every(call => call.method === 'chat.postMessage'));
  assert.ok(calls.every(call => String(call.body.text).length <= 500));
  assert.match(textFromResult(result), /part 1\//);
  assert.match(
    textFromResult(result),
    new RegExp(`part ${calls.length}/${calls.length}`),
  );
});

test('slack_update_message can split updates into continuation replies', async t => {
  const {calls, tools} = setupSlackEnv(t, (call, index) => ({
    ok: true,
    channel: call.body.channel,
    ts: call.method === 'chat.update' ? call.body.ts : `${index}.0`,
  }));
  const updateMessage = tools.get('slack_update_message');
  assert.ok(updateMessage);

  await updateMessage.execute(
    'tool-call-id',
    {
      confirm: true,
      longTextMode: 'split',
      maxChars: 500,
      text: 'updated\n'.repeat(180),
      clearBlocks: true,
      url: 'https://britecore.slack.com/archives/C12345678/p1700000000000100?thread_ts=1699999999.000100',
    },
    undefined,
    undefined,
    {hasUI: false},
  );

  assert.equal(calls[0].method, 'chat.update');
  assert.equal(calls[0].body.ts, '1700000000.000100');
  assert.ok(calls.slice(1).every(call => call.method === 'chat.postMessage'));
  assert.ok(
    calls.slice(1).every(call => call.body.thread_ts === '1699999999.000100'),
  );
});

test('slack_delete_message parses URL and deletes multiple timestamps', async t => {
  const {calls, tools} = setupSlackEnv(t, call => ({
    ok: true,
    channel: call.body.channel,
    ts: call.body.ts,
  }));
  const deleteMessage = tools.get('slack_delete_message');
  assert.ok(deleteMessage);

  await deleteMessage.execute(
    'tool-call-id',
    {
      confirm: true,
      timestamps: ['1700000001.000200'],
      url: 'https://britecore.slack.com/archives/C12345678/p1700000000000100',
    },
    undefined,
    undefined,
    {hasUI: false},
  );

  assert.deepEqual(
    calls.map(call => call.method),
    ['chat.delete', 'chat.delete'],
  );
  assert.deepEqual(
    calls.map(call => call.body.ts),
    ['1700000000.000100', '1700000001.000200'],
  );
});

test('slack_read_permalink falls back to nearby history on invalid thread arguments', async t => {
  const {calls, tools} = setupSlackEnv(t, call => {
    if (call.method === 'conversations.replies') {
      return {ok: false, error: 'invalid_arguments'};
    }
    return {
      ok: true,
      messages: [{ts: '1700000000.000100', user: 'U1', text: 'nearby message'}],
    };
  });
  const readPermalink = tools.get('slack_read_permalink');
  assert.ok(readPermalink);

  const result = await readPermalink.execute(
    'tool-call-id',
    {
      url: 'https://britecore.slack.com/archives/C12345678/p1700000000000100',
    },
    undefined,
  );

  assert.deepEqual(
    calls.map(call => call.method),
    ['conversations.replies', 'conversations.history'],
  );
  assert.match(
    calls[0].contentType ?? '',
    /^application\/x-www-form-urlencoded/,
  );
  assert.equal(calls[0].body.channel, 'C12345678');
  assert.equal(calls[0].body.ts, '1700000000.000100');
  assert.match(textFromResult(result), /nearby message/);
  assert.match(
    textFromResult(result),
    /Fallback: conversations\.replies failed/,
  );
});
