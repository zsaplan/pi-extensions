import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasPage,
  checkRevision,
  editCanvasSection,
  findCanvasSections,
  MAX_CANVAS_EXPORT_BYTES,
  readCanvas,
  validateSectionEdit,
  withCanvasWrite,
} from '../src/canvas.ts';
import {type SlackApiCaller, type SlackApiEnvelope} from '../src/slack.ts';

const canvasId = 'F123';
const sectionId = 'temp:C:abc123';
const fixtureHtml = `<div class="quip-canvas-content"><h1 id="temp:C:title">Test</h1><p id="${sectionId}">Original finding</p><p id="temp:C:human">Human notes untouched 🌍</p></div>`;

function fixture(t: {after: (fn: () => void) => void}) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const state = {
    html: fixtureHtml,
    title: 'Test',
    failHistory: false,
    writes: [] as Record<string, unknown>[],
    url: 'https://files.slack.com/files-pri/T123-F123/canvas',
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), state.url);
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer test-token',
    );
    assert.equal(init?.redirect, 'error');
    return new Response(state.html, {
      headers: {'Content-Type': 'text/html; charset=utf-8'},
    });
  };
  const client: SlackApiCaller = {
    async call<T extends SlackApiEnvelope>(
      method: string,
      body: Record<string, unknown> = {},
    ): Promise<T> {
      if (method === 'files.info')
        return {
          ok: true,
          file: {
            id: canvasId,
            title: state.title,
            mimetype: 'application/vnd.slack-docs',
            url_private: state.url,
          },
        } as unknown as T;
      if (method === 'canvases.sections.lookup')
        return {ok: true, sections: [{id: sectionId}]} as unknown as T;
      assert.equal(method, 'canvases.edit');
      state.writes.push(body);
      const change = (
        body.changes as {
          operation: string;
          section_id?: string;
          document_content: {markdown: string};
        }[]
      )[0];
      if (change.operation === 'insert_at_end') {
        if (state.failHistory) throw new Error('network failure');
        state.html = state.html.replace('</div>', '<p>revision note</p></div>');
      } else {
        state.html = state.html.replace(
          'Original finding',
          change.document_content.markdown,
        );
      }
      return {ok: true} as T;
    },
  };
  return {client, state};
}

function input(expectedRevision: string) {
  return {
    canvasId,
    sectionId,
    expectedRevision,
    operation: 'replace',
    markdown: 'Updated finding',
    changeSummary: 'Reconciled new evidence',
  };
}

test('Canvas read returns current HTML/hash, pages it without exposing download URLs', async t => {
  const {client, state} = fixture(t);
  const snapshot = await readCanvas(client, 'test-token', canvasId);
  assert.equal(snapshot.html, fixtureHtml);
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes('/files-pri/'));
  const first = canvasPage(snapshot, 0, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.truncated, true);
  const next = canvasPage(snapshot, 20);
  assert.equal(first.html + next.html, fixtureHtml);
  assert.equal(first.revision, next.revision);
  checkRevision(snapshot, first.revision);
  state.title = 'Human renamed this Canvas';
  await assert.rejects(
    async () =>
      checkRevision(
        await readCanvas(client, 'test-token', canvasId),
        first.revision,
      ),
    /changed since/,
  );
  assert.throws(() => canvasPage(snapshot, -1));
  assert.throws(() => canvasPage(snapshot, 0, 12001));
});

test('section lookup returns IDs only and preserves disambiguation criteria', async t => {
  const {client} = fixture(t);
  const result = await findCanvasSections(client, canvasId, 'Original finding');
  assert.deepEqual(result.sections, [{id: sectionId}]);
  assert.equal(result.truncated, false);
  const spy: SlackApiCaller = {
    async call<T extends SlackApiEnvelope>(
      _method: string,
      body?: Record<string, unknown>,
    ) {
      assert.deepEqual(body, {
        canvas_id: canvasId,
        criteria: {contains_text: 'Findings', section_types: ['h2']},
      });
      return {
        ok: true,
        sections: Array.from({length: 101}, () => ({
          id: sectionId,
          irrelevant: 'private',
        })),
      } as unknown as T;
    },
  };
  const many = await findCanvasSections(spy, canvasId, 'Findings', 'h2');
  assert.equal(many.sections.length, 100);
  assert.equal(many.truncated, true);
  assert.ok(!JSON.stringify(many).includes('private'));
  await assert.rejects(
    findCanvasSections(client, canvasId, 'find', 'invalid'),
    /Unsupported/,
  );
});

test('targeted edit applies one block and appends an escaped revision note', async t => {
  const {client, state} = fixture(t);
  const snapshot = await readCanvas(client, 'test-token', canvasId);
  const result = await editCanvasSection(client, 'test-token', {
    ...input(snapshot.revision),
    changeSummary: '[evidence](https://example.com) reviewed',
    appendRevisionNote: true,
  });
  assert.equal(result.status, 'section_updated_and_revision_noted');
  assert.equal(state.writes.length, 2);
  assert.deepEqual(state.writes[0], {
    canvas_id: canvasId,
    changes: [
      {
        operation: 'replace',
        section_id: sectionId,
        document_content: {type: 'markdown', markdown: 'Updated finding'},
      },
    ],
  });
  assert.match(JSON.stringify(state.writes[1]), /Revision/);
  assert.ok(state.html.includes('Human notes untouched 🌍'));
  assert.ok(state.html.includes('Updated finding'));
});

test('human changes since read reject the edit and revision note', async t => {
  const {client, state} = fixture(t);
  const snapshot = await readCanvas(client, 'test-token', canvasId);
  state.html = state.html.replace(
    'Human notes untouched',
    'Human added crucial evidence',
  );
  await assert.rejects(
    editCanvasSection(client, 'test-token', input(snapshot.revision)),
    /changed since it was read/,
  );
  assert.equal(state.writes.length, 0);
});

test('missing section rejects the edit even with a current revision', async t => {
  const {client, state} = fixture(t);
  const snapshot = await readCanvas(client, 'test-token', canvasId);
  await assert.rejects(
    editCanvasSection(client, 'test-token', {
      ...input(snapshot.revision),
      sectionId: 'temp:C:missing',
    }),
    /target section is absent/,
  );
  assert.equal(state.writes.length, 0);
});

test('history failure reports edit success without repeating the write', async t => {
  const {client, state} = fixture(t);
  state.failHistory = true;
  const snapshot = await readCanvas(client, 'test-token', canvasId);
  await assert.rejects(
    editCanvasSection(client, 'test-token', {
      ...input(snapshot.revision),
      appendRevisionNote: true,
    }),
    /edit SUCCEEDED.*do NOT repeat/,
  );
  assert.equal(state.writes.length, 2);
  assert.ok(state.html.includes('Updated finding'));
});

test('concurrent local edits serialize and reject the stale second edit', async t => {
  const {client, state} = fixture(t);
  const snapshot = await readCanvas(client, 'test-token', canvasId);
  const results = await Promise.allSettled([
    editCanvasSection(client, 'test-token', input(snapshot.revision)),
    editCanvasSection(client, 'test-token', input(snapshot.revision)),
  ]);
  assert.equal(
    results.filter(result => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(state.writes.length, 1);
});

test('default section edit returns summary without a visible revision note', async t => {
  const {client, state} = fixture(t);
  const snapshot = await readCanvas(client, 'test-token', canvasId);
  const result = await editCanvasSection(
    client,
    'test-token',
    input(snapshot.revision),
  );
  assert.equal(result.status, 'section_updated');
  assert.equal(result.changeSummary, 'Reconciled new evidence');
  assert.equal(state.writes.length, 1);
  assert.ok(!state.html.includes('revision note'));
});

test('failed queued operation releases its lock', async () => {
  await assert.rejects(
    withCanvasWrite('FQUEUED', async () => {
      throw new Error('failure');
    }),
  );
  assert.equal(await withCanvasWrite('FQUEUED', async () => 'next'), 'next');
});

test('invalid edit shapes cannot fall through to whole-document replacement', () => {
  for (const patch of [
    {sectionId: ''},
    {expectedRevision: 'old'},
    {operation: 'delete'},
    {changeSummary: 'one\ntwo'},
    {markdown: ''},
  ]) {
    assert.throws(() =>
      validateSectionEdit({...input('a'.repeat(64)), ...patch}),
    );
  }
});

test('Canvas reads reject other hosts, redirects, wrong-file URLs, and login HTML without leaking URLs', async t => {
  const {client, state} = fixture(t);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('redirect to https://private.example/secret');
  };
  for (const url of [
    'https://evil.test/secret',
    'http://files.slack.com/files-pri/T123-F123/canvas',
    'https://files.slack.com/files-pri/T123-F999/canvas',
  ]) {
    state.url = url;
    await assert.rejects(
      readCanvas(client, 'test-token', canvasId),
      (error: Error) => {
        assert.ok(!error.message.includes('secret'));
        return true;
      },
    );
  }
  assert.equal(calls, 0);
  state.url = 'https://files.slack.com/files-pri/T123-F123/canvas';
  await assert.rejects(
    readCanvas(client, 'test-token', canvasId),
    /Private URL omitted/,
  );
  globalThis.fetch = async () =>
    new Response('<html>Login</html>', {
      headers: {'content-type': 'text/html'},
    });
  await assert.rejects(
    readCanvas(client, 'test-token', canvasId),
    /Unrecognized Canvas export/,
  );
});

test('Canvas export enforces declared and streamed byte limits', async t => {
  const {client} = fixture(t);
  globalThis.fetch = async () =>
    new Response('x', {
      headers: {
        'content-type': 'text/html',
        'content-length': String(MAX_CANVAS_EXPORT_BYTES + 1),
      },
    });
  await assert.rejects(readCanvas(client, 'test-token', canvasId), /4 MiB/);
  globalThis.fetch = async () =>
    new Response('x'.repeat(MAX_CANVAS_EXPORT_BYTES + 1), {
      headers: {'content-type': 'text/html'},
    });
  await assert.rejects(readCanvas(client, 'test-token', canvasId), /4 MiB/);
});

test('aborted Canvas read never requests content or edits', async t => {
  const {client, state} = fixture(t);
  await assert.rejects(
    readCanvas(client, 'test-token', canvasId, AbortSignal.abort()),
  );
  assert.equal(state.writes.length, 0);
});
