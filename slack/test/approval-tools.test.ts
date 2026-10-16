import assert from 'node:assert/strict';
import test from 'node:test';
import slackExtension from '../src/index.ts';

interface Tool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

test('thread post approval covers uploads/replies but excludes broadcasts, message edits/deletes and Canvas writes', async t => {
  const envNames = [
    'SLACK_BOT_TOKEN',
    'PI_SLACK_SKIP_SEND_CONFIRM',
    'PI_SLACK_API_BASE_URL',
    'PI_SLACK_ALLOW_NONINTERACTIVE_WRITES',
  ];
  const originalEnv = envNames.map(name => [name, process.env[name]] as const);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.SLACK_BOT_TOKEN = 'test-bot';
  process.env.PI_SLACK_API_BASE_URL = 'https://slack.test/api';
  delete process.env.PI_SLACK_SKIP_SEND_CONFIRM;
  delete process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES;
  let authCalls = 0;
  let selects = 0;
  let confirms = 0;
  const calls: {method: string; body: Record<string, unknown>}[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/files-pri/'))
      return new Response(
        '<div class="quip-canvas-content"><p id="temp:C:one">Current finding</p></div>',
        {headers: {'content-type': 'text/html'}},
      );
    if (String(url).startsWith('https://files.slack.com/'))
      return new Response('OK');
    const method = String(url).split('/').pop()!;
    const form = new Headers(init?.headers)
      .get('content-type')
      ?.startsWith('application/x-www-form-urlencoded');
    const body = form
      ? Object.fromEntries(new URLSearchParams(String(init?.body)))
      : JSON.parse(String(init?.body));
    calls.push({method, body});
    if (method === 'auth.test') {
      authCalls++;
      return Response.json({
        ok: true,
        team_id: 'T123',
        user_id: 'UBOT',
        bot_id: 'BBOT',
      });
    }
    if (method === 'files.info')
      return Response.json({
        ok: true,
        file: {
          id: 'F123',
          title: 'Test',
          mimetype: 'application/vnd.slack-docs',
          url_private: 'https://files.slack.com/files-pri/T123-F123/canvas',
        },
      });
    if (method === 'files.getUploadURLExternal')
      return Response.json({
        ok: true,
        file_id: 'F123',
        upload_url: 'https://files.slack.com/upload/test',
      });
    if (method === 'files.completeUploadExternal')
      return Response.json({ok: true, files: [{id: 'F123'}]});
    return Response.json({
      ok: true,
      channel: 'C12345678',
      ts: '2.000001',
      canvas_id: 'F123',
    });
  };
  const entries: unknown[] = [];
  const tools = new Map<string, Tool>();
  const pi = {
    registerCommand() {},
    on() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({type: 'custom', customType, data});
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
  };
  slackExtension(pi as never);
  const ctx = {
    hasUI: true,
    cwd: '/',
    sessionManager: {
      getSessionId: () => 'session-a',
      getEntries: () => entries,
    },
    ui: {
      notify() {},
      select: async (_title: string, choices: string[]) => {
        selects++;
        return choices.includes('Approve Canvas content for this session')
          ? 'Approve Canvas content for this session'
          : 'Approve thread for this session';
      },
      confirm: async () => {
        confirms++;
        return true;
      },
    },
  };
  const execute = (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute('test', params, undefined, undefined, ctx);
  const thread = {channel: 'C12345678', threadTs: '1.000001'};
  await execute('slack_post_message', {...thread, text: 'First reply'});
  await execute('slack_post_message', {...thread, text: 'Second reply'});
  await execute('slack_upload_file', {
    ...thread,
    content: 'Evidence',
    filename: 'test.txt',
  });
  assert.equal(selects, 1);
  assert.equal(confirms, 0);
  assert.equal(authCalls, 1);
  assert.equal(entries.length, 1);
  assert.equal(
    calls.find(call => call.method === 'files.completeUploadExternal')!.body
      .thread_ts,
    '1.000001',
  );
  await execute('slack_post_message', {
    ...thread,
    text: 'Broadcast',
    replyBroadcast: true,
  });
  await execute('slack_post_message', {
    channel: thread.channel,
    text: 'Top-level',
  });
  await execute('slack_update_message', {
    ...thread,
    ts: '2.000001',
    text: 'Edit',
    clearBlocks: true,
  });
  await execute('slack_delete_message', {...thread, ts: '2.000001'});
  await execute('slack_create_canvas', {title: 'Canvas', markdown: 'text'});
  await execute('slack_upload_file', {
    content: 'Private file',
    filename: 'private.txt',
  });
  assert.equal(confirms, 6);
  assert.equal(selects, 1);
  // Simulate extension reload using the same actual session entries.
  slackExtension(pi as never);
  await execute('slack_post_message', {...thread, text: 'After reload'});
  assert.equal(selects, 1);
  assert.equal(confirms, 6);
  await execute('slack_edit_canvas', {
    canvasId: 'F123',
    operation: 'append',
    markdown: 'New finding',
  });
  await execute('slack_edit_canvas', {
    canvasId: 'F123',
    operation: 'rename',
    title: 'Revised report',
  });
  assert.equal(selects, 2);
  assert.equal(confirms, 6);
  const editCount = calls.filter(
    call => call.method === 'canvases.edit',
  ).length;
  await assert.rejects(
    execute('slack_edit_canvas_section', {
      canvasId: 'F123',
      sectionId: 'temp:C:one',
      operation: 'replace',
      markdown: 'Newer finding',
      expectedRevision: '0'.repeat(64),
      changeSummary: 'New evidence',
    }),
    /changed since/,
  );
  assert.equal(
    calls.filter(call => call.method === 'canvases.edit').length,
    editCount,
  );
  assert.equal(selects, 2);
  await execute('slack_set_canvas_access', {
    canvasId: 'F123',
    userIds: ['U123'],
    accessLevel: 'read',
  });
  await execute('slack_edit_canvas', {
    canvasId: 'F123',
    operation: 'replace',
    markdown: 'Replacement',
  });
  assert.equal(confirms, 8);
  const snapshot = (await execute('slack_read_canvas', {canvasId: 'F123'})) as {
    details: {revision: string};
  };
  const deletion = {
    canvasId: 'F123',
    sectionId: 'temp:C:one',
    expectedRevision: snapshot.details.revision,
    changeSummary: 'Remove obsolete finding',
  };
  await execute('slack_delete_canvas_section', deletion);
  assert.equal(confirms, 9); // Existing Canvas grant does not cover deletion.
  assert.equal(selects, 2);
  const beforeDenied = calls.filter(
    call => call.method === 'canvases.edit',
  ).length;
  ctx.ui.confirm = async () => false;
  await assert.rejects(
    execute('slack_delete_canvas_section', deletion),
    /cancelled/,
  );
  await assert.rejects(
    tools
      .get('slack_delete_canvas_section')!
      .execute('test', {...deletion, confirm: true}, undefined, undefined, {
        ...ctx,
        hasUI: false,
      }),
    /blocked in non-interactive/,
  );
  assert.equal(
    calls.filter(call => call.method === 'canvases.edit').length,
    beforeDenied,
  );
});
