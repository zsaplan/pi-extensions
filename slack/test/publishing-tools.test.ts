import assert from 'node:assert/strict';
import test from 'node:test';
import slackExtension from '../src/index.ts';

interface Tool {
  name: string;
  execute: (
    ...args: unknown[]
  ) => Promise<{content: {text: string}[]; details: Record<string, unknown>}>;
}
function setup(t: {after: (fn: () => void) => void}) {
  const names = [
    'SLACK_BOT_TOKEN',
    'SLACK_USER_TOKEN',
    'PI_SLACK_ALLOW_NONINTERACTIVE_WRITES',
    'PI_SLACK_SKIP_SEND_CONFIRM',
    'PI_SLACK_API_BASE_URL',
  ];
  const original = names.map(name => [name, process.env[name]] as const);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_USER_TOKEN = 'xoxp-test';
  process.env.PI_SLACK_API_BASE_URL = 'https://slack.test/api';
  delete process.env.PI_SLACK_SKIP_SEND_CONFIRM;
  delete process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES;
  const calls: {method: string; body: Record<string, unknown>}[] = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop()!;
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer xoxb-test',
    );
    const form = new Headers(init?.headers)
      .get('Content-Type')
      ?.startsWith('application/x-www-form-urlencoded');
    const body = form
      ? Object.fromEntries(new URLSearchParams(String(init?.body)))
      : JSON.parse(String(init?.body));
    calls.push({method, body});
    if (method === 'files.info') assert.equal(form, true);
    const response =
      method === 'conversations.info'
        ? {ok: true, channel: {id: 'C123', is_im: false, is_mpim: false}}
        : method === 'files.info'
          ? {
              ok: true,
              file: {
                id: 'F123',
                title: 'Test',
                permalink: 'https://slack.com/file',
                url_private: 'secret',
              },
            }
          : {ok: true, canvas_id: 'F123'};
    return new Response(JSON.stringify(response));
  };
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, () => unknown>();
  slackExtension({
    registerCommand() {},
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    on(name: string, callback: () => unknown) {
      hooks.set(name, callback);
    },
  } as never);
  return {tools, calls, hooks};
}

const cases = [
  ['slack_create_canvas', {title: 'Test', markdown: '# Test'}],
  [
    'slack_edit_canvas',
    {canvasId: 'F123', operation: 'replace', markdown: '# Updated'},
  ],
  [
    'slack_set_canvas_access',
    {canvasId: 'F123', accessLevel: 'read', userIds: ['U123']},
  ],
  ['slack_upload_file', {filename: 'test.txt', content: 'hello'}],
  [
    'slack_edit_canvas_section',
    {
      canvasId: 'F123',
      sectionId: 'temp:C:abc123',
      operation: 'replace',
      markdown: 'New finding',
      expectedRevision: 'a'.repeat(64),
      changeSummary: 'New evidence',
    },
  ],
] as const;

for (const [name, params] of cases) {
  test(`${name}: denied confirmation and non-interactive default prevent mutations`, async t => {
    const {tools, calls} = setup(t);
    const tool = tools.get(name)!;
    let prompted = false;
    await assert.rejects(
      tool.execute('test', params, undefined, undefined, {
        cwd: '/',
        hasUI: true,
        ui: {
          notify() {},
          confirm: async () => {
            prompted = true;
            return false;
          },
        },
      }),
      /cancelled by user/,
    );
    assert.equal(prompted, true);
    assert.equal(calls.filter(call => call.method !== 'auth.test').length, 0);
    await assert.rejects(
      tool.execute('test', {...params, confirm: true}, undefined, undefined, {
        cwd: '/',
        hasUI: false,
      }),
      /blocked in non-interactive mode/,
    );
    assert.equal(calls.filter(call => call.method !== 'auth.test').length, 0);
    process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES = '1';
    await assert.rejects(
      tool.execute('test', params, undefined, undefined, {
        cwd: '/',
        hasUI: false,
      }),
      /blocked in non-interactive mode/,
    );
    assert.equal(calls.filter(call => call.method !== 'auth.test').length, 0);
  });
}

test('Canvas create, edit, and access use bot token and preserve Markdown', async t => {
  const {tools, calls} = setup(t);
  process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES = '1';
  const ctx = {cwd: '/', hasUI: false};
  await tools
    .get('slack_create_canvas')!
    .execute(
      'test',
      {title: 'Test', markdown: '# Test\n\n| A | B |', confirm: true},
      undefined,
      undefined,
      ctx,
    );
  assert.deepEqual(calls[0].body.document_content, {
    type: 'markdown',
    markdown: '# Test\n\n| A | B |',
  });
  await tools
    .get('slack_edit_canvas')!
    .execute(
      'test',
      {canvasId: 'F123', operation: 'append', markdown: 'More', confirm: true},
      undefined,
      undefined,
      ctx,
    );
  assert.deepEqual(calls[1].body.changes, [
    {
      operation: 'insert_at_end',
      document_content: {type: 'markdown', markdown: 'More'},
    },
  ]);
  await tools.get('slack_set_canvas_access')!.execute(
    'test',
    {
      canvasId: 'F123',
      channelIds: ['C123'],
      accessLevel: 'read',
      confirm: true,
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(calls[2].method, 'conversations.info');
  assert.deepEqual(calls[3].body, {
    canvas_id: 'F123',
    channel_ids: ['C123'],
    access_level: 'read',
  });
});

test('channel-tab confirmation explicitly describes write access', async t => {
  const {tools, calls} = setup(t);
  let prompt = '';
  await tools
    .get('slack_create_canvas')!
    .execute(
      'test',
      {title: 'Test', markdown: '# Test', channel: 'C12345678'},
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          confirm: async (_title: string, body: string) => {
            prompt = body;
            return true;
          },
        },
      },
    );
  assert.match(prompt, /WRITE access/);
  assert.equal(calls[1].body.channel_id, 'C12345678');
});

test('cancellation after confirmation prevents Canvas mutation', async t => {
  const {tools, calls} = setup(t);
  const controller = new AbortController();
  await assert.rejects(
    tools
      .get('slack_create_canvas')!
      .execute(
        'test',
        {title: 'Test', markdown: 'text'},
        controller.signal,
        undefined,
        {
          hasUI: true,
          ui: {
            confirm: async () => {
              controller.abort();
              return true;
            },
          },
        },
      ),
  );
  assert.equal(calls.length, 0);
});

test('metadata uses bot token, filters secrets, and discovers the publishing skill', async t => {
  const {tools, hooks} = setup(t);
  const result = await tools
    .get('slack_get_file_info')!
    .execute('test', {fileId: 'F123'}, undefined);
  assert.equal(result.details.permalink, 'https://slack.com/file');
  assert.ok(!result.content[0].text.includes('secret'));
  assert.match(
    JSON.stringify(hooks.get('resources_discover')!()),
    /slack\/skills/,
  );
});

test('invalid upload inputs and access levels fail before network calls', async t => {
  const {tools, calls} = setup(t);
  await assert.rejects(
    tools
      .get('slack_upload_file')!
      .execute(
        'test',
        {filename: 'a', content: 'x', path: 'a'},
        undefined,
        undefined,
        {cwd: '/'},
      ),
    /exactly one/,
  );
  await assert.rejects(
    tools
      .get('slack_set_canvas_access')!
      .execute(
        'test',
        {canvasId: 'F123', userIds: ['U123'], accessLevel: 'owner'},
        undefined,
        undefined,
        {},
      ),
    /ownership/,
  );
  assert.equal(calls.length, 0);
});

test('upload tool completes all stages using form allocation, unauthenticated bytes, and JSON completion', async t => {
  const {tools} = setup(t);
  process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES = '1';
  const stages: string[] = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop()!;
    stages.push(method);
    const headers = new Headers(init?.headers);
    if (method === 'signed-upload') {
      assert.equal(headers.has('authorization'), false);
      assert.equal(Buffer.from(init?.body as Uint8Array).toString(), '🌍');
      return new Response('OK');
    }
    assert.equal(headers.get('authorization'), 'Bearer xoxb-test');
    if (method === 'files.getUploadURLExternal') {
      assert.match(
        headers.get('content-type')!,
        /application\/x-www-form-urlencoded/,
      );
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('length'), '4');
      assert.equal(body.get('snippet_type'), 'text');
      return Response.json({
        ok: true,
        file_id: 'F123',
        upload_url: 'https://files.slack.com/signed-upload',
      });
    }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.channel_id, 'C12345678');
    assert.equal(body.thread_ts, '1.0');
    return Response.json({
      ok: true,
      files: [{id: 'F123'}],
      warning: 'processing_pending',
    });
  };
  const result = await tools.get('slack_upload_file')!.execute(
    'test',
    {
      content: '🌍',
      filename: 'test.txt',
      snippetType: 'text',
      channel: 'C12345678',
      threadTs: '1.0',
      confirm: true,
    },
    undefined,
    undefined,
    {hasUI: false, cwd: '/'},
  );
  assert.equal(result.details.fileId, 'F123');
  assert.equal(result.details.visibility, 'channel_share_requested');
  assert.deepEqual(result.details.warnings, ['processing_pending']);
  assert.deepEqual(stages, [
    'files.getUploadURLExternal',
    'signed-upload',
    'files.completeUploadExternal',
  ]);
});

test('section tool re-reads after confirmation and rejects an intervening human edit', async t => {
  const {tools} = setup(t);
  let html =
    '<div class="quip-canvas-content"><p id="temp:C:abc123">Original</p></div>';
  let writes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/files-pri/')) {
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer xoxb-test',
      );
      return new Response(html, {headers: {'content-type': 'text/html'}});
    }
    if (String(url).endsWith('auth.test'))
      return Response.json({ok: false, error: 'missing_scope'});
    if (String(url).endsWith('files.info'))
      return Response.json({
        ok: true,
        file: {
          id: 'F123',
          mimetype: 'application/vnd.slack-docs',
          url_private: 'https://files.slack.com/files-pri/T123-F123/canvas',
        },
      });
    writes++;
    return Response.json({ok: true});
  };
  const read = await tools
    .get('slack_read_canvas')!
    .execute('test', {canvasId: 'F123'}, undefined);
  assert.match(read.content[0].text, /Original/);
  assert.ok(!read.content[0].text.includes('/files-pri/'));
  assert.ok(!('html' in read.details));
  await assert.rejects(
    tools.get('slack_edit_canvas_section')!.execute(
      'test',
      {
        canvasId: 'F123',
        sectionId: 'temp:C:abc123',
        operation: 'replace',
        markdown: 'New finding',
        expectedRevision: read.details.revision,
        changeSummary: 'New evidence',
      },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          notify() {},
          confirm: async () => {
            html = html.replace('Original', 'Human contribution');
            return true;
          },
        },
      },
    ),
    /changed since/,
  );
  assert.equal(writes, 0);
});

test('rate limiting is surfaced without retrying a Canvas write', async t => {
  const {tools} = setup(t);
  process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES = '1';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ok: false, error: 'ratelimited'}), {
      status: 429,
      headers: {'retry-after': '10'},
    });
  };
  await assert.rejects(
    tools
      .get('slack_create_canvas')!
      .execute(
        'test',
        {title: 'Test', markdown: 'text', confirm: true},
        undefined,
        undefined,
        {hasUI: false},
      ),
    /retry after 10 seconds/,
  );
  assert.equal(calls, 1);
});

test('Canvas read modes and lookup previews retain full-document revision protection', async t => {
  const {tools} = setup(t);
  let html =
    '<div class="quip-canvas-content"><h2 id="temp:C:h">Findings</h2><p id="temp:C:one">Cost rose</p><p id="temp:C:two">Cost rose again</p></div>';
  let lookupCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith('files.info'))
      return Response.json({
        ok: true,
        file: {
          id: 'F123',
          title: 'Report',
          mimetype: 'application/vnd.slack-docs',
          url_private: 'https://files.slack.com/files-pri/T123-F123/canvas',
        },
      });
    if (String(url).includes('files-pri'))
      return new Response(html, {headers: {'content-type': 'text/html'}});
    assert.ok(String(url).endsWith('canvases.sections.lookup'));
    lookupCalls++;
    return Response.json({
      ok: true,
      sections: [{id: 'temp:C:one'}, {id: 'temp:C:two'}],
    });
  };
  const run = (name: string, params: Record<string, unknown>) =>
    tools
      .get(name)!
      .execute('test', {canvasId: 'F123', ...params}, undefined, undefined, {
        hasUI: false,
      });
  const first = await run('slack_read_canvas', {blockLimit: 1});
  assert.equal(first.details.format, 'blocks');
  assert.equal(first.details.hasMore, true);
  const revision = first.details.revision;
  const last = await run('slack_read_canvas', {
    blockOffset: first.details.nextBlockOffset,
    expectedRevision: revision,
  });
  assert.equal(last.details.hasMore, false);
  assert.equal(last.details.isPartial, true);
  const legacy = await run('slack_read_canvas', {
    offset: 0,
    limit: 12000,
    expectedRevision: revision,
  });
  assert.equal(legacy.details.format, 'html');
  assert.ok(legacy.content[0].text.includes('<h2 id="temp:C:h">'));
  const section = await run('slack_read_canvas', {
    format: 'html',
    sectionId: 'temp:C:one',
    expectedRevision: revision,
  });
  assert.equal(section.details.revision, revision);
  assert.equal(section.details.hasMore, false);
  assert.equal(section.details.isPartial, true);
  assert.ok(
    section.content[0].text.includes('<p id="temp:C:one">Cost rose</p>'),
  );
  assert.ok(!section.content[0].text.includes('Cost rose again'));
  const matches = await run('slack_find_canvas_sections', {
    containsText: 'Cost',
    limit: 1,
    expectedRevision: revision,
  });
  assert.equal(matches.details.revision, revision);
  assert.equal(matches.details.totalMatches, 2);
  assert.equal(matches.details.returnedMatches, 1);
  assert.equal(matches.details.truncated, true);
  assert.ok(matches.content[0].text.includes('Findings'));
  assert.ok(matches.content[0].text.includes('Cost rose'));
  await assert.rejects(
    run('slack_read_canvas', {format: 'blocks', offset: 1}),
    /HTML mode/,
  );
  html = html.replace('Cost rose', 'Human update');
  await assert.rejects(
    run('slack_read_canvas', {blockOffset: 1, expectedRevision: revision}),
    /changed since/,
  );
  await assert.rejects(
    run('slack_find_canvas_sections', {
      containsText: 'Cost',
      expectedRevision: revision,
    }),
    /changed since/,
  );
  assert.equal(lookupCalls, 1);
});
