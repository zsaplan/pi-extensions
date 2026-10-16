import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readSlackUploadLimit} from '../src/config.ts';
import {
  canvasAccess,
  canvasChange,
  createCanvas,
  fileMetadata,
  prepareUpload,
  publishingWrite,
  requireRegularChannel,
  uploadFile,
  validateUpload,
} from '../src/publishing.ts';
import {
  SlackApiError,
  type SlackApiCaller,
  type SlackApiEnvelope,
} from '../src/slack.ts';

function caller(
  respond: (method: string, body: Record<string, unknown>) => unknown,
): SlackApiCaller {
  return {
    async call<T extends SlackApiEnvelope>(
      method: string,
      body: Record<string, unknown> = {},
    ): Promise<T> {
      return respond(method, body) as T;
    },
  };
}

test('Canvas preserves native Markdown and maps one edit at a time', async () => {
  const markdown =
    '# Report\n\n| Area | Cost |\n|---|---|\n| Test | $5 |\n\n> Caveat\n';
  const calls: Record<string, unknown>[] = [];
  const client = caller((_method, body) => {
    calls.push(body);
    return {ok: true, canvas_id: 'F123'};
  });
  const result = await createCanvas(client, 'Report', markdown);
  assert.equal(result.canvasId, 'F123');
  assert.deepEqual(calls[0], {
    title: 'Report',
    document_content: {type: 'markdown', markdown},
  });
  for (const [operation, mapped] of [
    ['append', 'insert_at_end'],
    ['prepend', 'insert_at_start'],
    ['replace', 'replace'],
  ]) {
    assert.deepEqual(canvasChange(operation, markdown), {
      operation: mapped,
      document_content: {type: 'markdown', markdown},
    });
  }
  assert.deepEqual(canvasChange('rename', undefined, 'New title'), {
    operation: 'rename',
    title_content: {type: 'markdown', markdown: 'New title'},
  });
});

test('Canvas rejects invalid editing and access contracts', () => {
  for (const args of [
    ['rename', '# hello', 'title'],
    ['append', undefined, 'title'],
    ['delete', 'text', undefined],
    ['replace', ' ', undefined],
  ] as const) {
    assert.throws(() => canvasChange(args[0], args[1], args[2]));
  }
  assert.throws(() => canvasAccess('F123', 'owner', undefined, ['U123']));
  assert.throws(() => canvasAccess('F123', 'read', ['C123'], ['U123']));
  assert.throws(() => canvasAccess('F123', 'read', []));
  assert.throws(() => canvasAccess('F123', 'read', ['D123']));
  assert.throws(() => canvasAccess('F123', 'read', undefined));
  assert.deepEqual(canvasAccess('F123', 'read', ['C123']), {
    canvas_id: 'F123',
    access_level: 'read',
    channel_ids: ['C123'],
  });
});

test('Canvas rejects MPDM placement/access even with a G-prefixed ID', async () => {
  await assert.rejects(
    requireRegularChannel(
      caller(() => ({ok: true, channel: {is_mpim: true}})),
      'G123',
    ),
    /regular channel/,
  );
});

test('Canvas failure reports uncertain creation without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    createCanvas(
      caller(() => {
        calls++;
        throw new Error('network');
      }),
      'Test',
      'body',
    ),
    /outcome may be uncertain/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    publishingWrite(async () => {
      throw new SlackApiError('canvases.edit', 'missing_scope');
    }, 'F123 edit'),
    /F123 edit: missing_scope/,
  );
});

test('file metadata excludes private download URLs and content', () => {
  const metadata = fileMetadata({
    id: 'F123',
    title: 'Report',
    permalink: 'https://slack.com/file',
    url_private: 'secret',
    content: 'secret',
  } as never);
  assert.equal(metadata.permalink, 'https://slack.com/file');
  assert.ok(!('url_private' in metadata));
  assert.ok(!('content' in metadata));
  const manyChannels = fileMetadata({
    id: 'F123',
    channels: Array.from({length: 80}, (_, i) => `C${i}`),
  });
  assert.equal(manyChannels.channels?.length, 50);
  assert.equal(manyChannels.sharingTruncated, true);
});

test('upload limit is bounded and configurable', () => {
  assert.equal(readSlackUploadLimit({}), 20 * 1024 * 1024);
  assert.equal(readSlackUploadLimit({PI_SLACK_MAX_UPLOAD_BYTES: '1000'}), 1000);
  for (const raw of ['0', '-1', '1.5', 'NaN', '', '104857601'])
    assert.throws(() => readSlackUploadLimit({PI_SLACK_MAX_UPLOAD_BYTES: raw}));
});

test('upload validates sources, destinations, filenames and UTF-8 byte size', async () => {
  for (const input of [
    {},
    {path: 'a', content: 'b'},
    {content: 'hello'},
    {content: 'hello', filename: 'a', threadTs: '1.0'},
    {content: 'hello', filename: 'a', initialComment: 'hi'},
  ]) {
    assert.throws(() => validateUpload(input));
  }
  const prepared = await prepareUpload(
    {content: '🌍', filename: 'hello.txt'},
    '/',
    4,
  );
  assert.equal(prepared.bytes.length, 4);
  await assert.rejects(
    prepareUpload({content: '🌍', filename: 'hello.txt'}, '/', 3),
    /exceeds/,
  );
  for (const filename of ['../test', 'a\\b', 'a\u0000b'])
    await assert.rejects(
      prepareUpload({content: 'x', filename}, '/', 10),
      /filename/,
    );
  await assert.rejects(
    prepareUpload({content: '', filename: 'empty'}, '/', 10),
    /1–10 bytes/,
  );
});

test('local binary upload is a bounded snapshot and rejects non-files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'slack-publishing-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'evidence.bin');
  const bytes = Buffer.from([0, 255, 1, 254]);
  await writeFile(path, bytes);
  const prepared = await prepareUpload({path: '@evidence.bin'}, dir, 4);
  await writeFile(path, 'changed');
  assert.deepEqual(prepared.bytes, bytes);
  assert.equal(prepared.filename, 'evidence.bin');
  await assert.rejects(prepareUpload({path}, dir, 4), /exceeds/);
  await assert.rejects(prepareUpload({path: dir}, dir, 10), /regular file/);
});

test('upload sends unauthenticated bytes then finalizes with channel/thread and snippet type', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const stages: string[] = [];
  const input = {
    content: 'select 1; -- 🌍',
    filename: 'test.sql',
    snippetType: 'sql',
    channel: 'C123',
    threadTs: '1.0',
    initialComment: 'test',
  };
  const prepared = await prepareUpload(input, '/', 1000);
  const client = caller((method, body) => {
    stages.push(method);
    if (method === 'files.getUploadURLExternal') {
      assert.equal(body.length, prepared.bytes.length);
      assert.equal(body.snippet_type, 'sql');
      return {
        ok: true,
        file_id: 'F123',
        upload_url: 'https://files.slack.com/upload/secret',
      };
    }
    assert.equal(body.channel_id, 'C123');
    assert.equal(body.thread_ts, '1.0');
    assert.deepEqual(body.files, [{id: 'F123', title: 'test.sql'}]);
    return {
      ok: true,
      files: [{id: 'F123', permalink: 'https://slack.com/file'}],
    };
  });
  globalThis.fetch = async (_url, init) => {
    stages.push('bytes');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(Buffer.from(init?.body as Uint8Array), prepared.bytes);
    return new Response('OK', {status: 200});
  };
  const result = await uploadFile(client, input, prepared);
  assert.equal(result.visibility, 'channel_share_requested');
  assert.deepEqual(stages, [
    'files.getUploadURLExternal',
    'bytes',
    'files.completeUploadExternal',
  ]);
});

test('private upload omits destination and reports private visibility', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response('OK');
  const result = await uploadFile(
    caller((method, body) => {
      if (method === 'files.getUploadURLExternal')
        return {
          ok: true,
          file_id: 'F123',
          upload_url: 'https://files.slack.com/upload/secret',
        };
      assert.equal(body.channel_id, undefined);
      return {ok: true, files: [{id: 'F123'}]};
    }),
    {},
    {bytes: Buffer.from('a'), filename: 'a', source: 'inline'},
  );
  assert.equal(result.visibility, 'private');
});

for (const failure of ['url', 'bytes', 'complete']) {
  test(`upload ${failure} failure preserves stage/ID, redacts signed URL and never retries`, async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    let fetches = 0;
    const methods: string[] = [];
    globalThis.fetch = async () => {
      fetches++;
      if (failure === 'bytes')
        throw new Error('https://files.slack.com/upload/secret');
      return new Response('OK');
    };
    const client = caller(method => {
      methods.push(method);
      if (method === 'files.getUploadURLExternal')
        return {
          ok: true,
          file_id: 'F123',
          upload_url:
            failure === 'url'
              ? 'https://evil.test/secret'
              : 'https://files.slack.com/upload/secret',
        };
      throw new Error('network error');
    });
    await assert.rejects(
      uploadFile(
        client,
        {},
        {bytes: Buffer.from('x'), filename: 'x', source: 'inline'},
      ),
      (error: Error) => {
        assert.match(error.message, /fileId=F123/);
        assert.ok(!error.message.includes('secret'));
        if (failure === 'complete')
          assert.match(error.message, /Completion outcome may be uncertain/);
        return true;
      },
    );
    assert.equal(fetches, failure === 'url' ? 0 : 1);
    assert.equal(methods.length, failure === 'complete' ? 2 : 1);
  });
}

test('aborted upload never allocates an upload URL', async () => {
  let calls = 0;
  await assert.rejects(
    uploadFile(
      caller(() => {
        calls++;
      }),
      {},
      {bytes: Buffer.from('x'), filename: 'x', source: 'inline'},
      AbortSignal.abort(),
    ),
    /request_upload_url/,
  );
  assert.equal(calls, 0);
});
