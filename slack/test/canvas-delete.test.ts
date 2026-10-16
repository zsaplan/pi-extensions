import assert from 'node:assert/strict';
import test from 'node:test';
import {deleteCanvasSection, deletionPreview} from '../src/canvas-delete.ts';
import {readCanvas} from '../src/canvas.ts';
import type {SlackApiCaller, SlackApiEnvelope} from '../src/slack.ts';

function fixture(t: {after: (fn: () => void) => void}) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const target =
    '<ul id="temp:C:list"><li id="temp:C:item">Obsolete finding</li></ul>';
  const state = {
    html: `<div class="quip-canvas-content"><h2 id="temp:C:heading">Findings</h2>${target}<p id="temp:C:human">Human context</p></div>`,
    writes: 0,
    loseResponse: false,
    failReadBack: false,
  };
  globalThis.fetch = async () => {
    if (state.writes && state.failReadBack) throw new Error('Network failure');
    return new Response(state.html, {headers: {'content-type': 'text/html'}});
  };
  const client: SlackApiCaller = {
    async call<T extends SlackApiEnvelope>(
      method: string,
      body?: Record<string, unknown>,
    ): Promise<T> {
      if (method === 'files.info')
        return {
          ok: true,
          file: {
            id: 'F123',
            title: 'Test',
            mimetype: 'application/vnd.slack-docs',
            url_private: 'https://files.slack.com/files-pri/T123-F123/canvas',
          },
        } as unknown as T;
      assert.equal(method, 'canvases.edit');
      assert.deepEqual(body, {
        canvas_id: 'F123',
        changes: [{operation: 'delete', section_id: 'temp:C:list'}],
      });
      state.writes++;
      state.html = state.html.replace(target, '');
      if (state.loseResponse) throw new Error('Response lost');
      return {ok: true} as T;
    },
  };
  const read = () => readCanvas(client, 'test-token', 'F123');
  return {client, state, read};
}
const input = (revision: string) => ({
  canvasId: 'F123',
  sectionId: 'temp:C:list',
  expectedRevision: revision,
  changeSummary: 'Remove superseded finding',
});

test('deletion previews descendants and deletes exactly one section without rewriting others', async t => {
  const {client, state, read} = fixture(t);
  const before = await read();
  const preview = deletionPreview(before, input(before.revision));
  assert.deepEqual(preview.affectedIds, ['temp:C:list', 'temp:C:item']);
  assert.ok(preview.html.includes('Obsolete finding'));
  const result = await deleteCanvasSection(
    client,
    'test-token',
    input(before.revision),
  );
  assert.equal(result.status, 'section_deleted');
  assert.equal(state.writes, 1);
  assert.ok(state.html.includes('Human context'));
  assert.ok(state.html.includes('Findings'));
  assert.ok(!state.html.includes('temp:C:list'));
});

test('post-confirmation drift, absent targets, and oversized previews prevent deletion', async t => {
  const {client, state, read} = fixture(t);
  const before = await read();
  assert.throws(
    () =>
      deletionPreview(before, {
        ...input(before.revision),
        sectionId: 'temp:C:missing',
      }),
    /absent/,
  );
  state.html = state.html.replace('Human context', 'New human evidence');
  await assert.rejects(
    deleteCanvasSection(client, 'test-token', input(before.revision)),
    /changed since/,
  );
  state.html = state.html.replace('Obsolete finding', 'x'.repeat(4001));
  const large = await read();
  assert.throws(
    () => deletionPreview(large, input(large.revision)),
    /preview exceeds/,
  );
  assert.equal(state.writes, 0);
});

test('ambiguous repeated IDs and oversized descendant sets fail closed', async t => {
  const {state, read} = fixture(t);
  state.html = state.html.replace(
    'Obsolete finding',
    '<span id="temp:C:item">Obsolete finding</span>',
  );
  const nested = await read();
  assert.equal(
    deletionPreview(nested, input(nested.revision)).affectedIds.length,
    2,
  );
  state.html = state.html.replace('id="temp:C:human"', 'id="temp:C:list"');
  const ambiguous = await read();
  assert.throws(
    () => deletionPreview(ambiguous, input(ambiguous.revision)),
    /Ambiguous/,
  );
  state.html = `<div class="quip-canvas-content"><ul id="temp:C:list">${Array.from({length: 21}, (_, i) => `<li id="temp:C:item${i}">Text</li>`).join('')}</ul></div>`;
  const large = await read();
  assert.throws(
    () => deletionPreview(large, input(large.revision)),
    /more than 20/,
  );
  assert.equal(state.writes, 0);
});

test('heading preview excludes its chapter and document wrapper cannot be deleted', async t => {
  const {state, read} = fixture(t);
  const before = await read();
  const heading = deletionPreview(before, {
    ...input(before.revision),
    sectionId: 'temp:C:heading',
  });
  assert.ok(!heading.html.includes('Human context'));
  assert.deepEqual(heading.affectedIds, ['temp:C:heading']);
  state.html = state.html.replace(
    'class="quip-canvas-content"',
    'class="quip-canvas-content" id="temp:C:root"',
  );
  const root = await read();
  assert.throws(
    () =>
      deletionPreview(root, {
        ...input(root.revision),
        sectionId: 'temp:C:root',
      }),
    /not a supported/,
  );
});

test('lost delete response is uncertain and never automatically retried', async t => {
  const {client, state, read} = fixture(t);
  const before = await read();
  state.loseResponse = true;
  const result = await deleteCanvasSection(
    client,
    'test-token',
    input(before.revision),
  );
  assert.equal(result.status, 'deletion_uncertain');
  assert.equal(state.writes, 1);
  assert.ok(!state.html.includes('Obsolete finding'));
});

test('acknowledged deletion with failed read-back is explicitly unverified', async t => {
  const {client, state, read} = fixture(t);
  const before = await read();
  state.failReadBack = true;
  const result = await deleteCanvasSection(
    client,
    'test-token',
    input(before.revision),
  );
  assert.equal(result.status, 'deletion_acknowledged_unverified');
  assert.equal(state.writes, 1);
});

test('cancellation and concurrent stale deletion do not cause repeated mutations', async t => {
  const {client, state, read} = fixture(t);
  const before = await read();
  await assert.rejects(
    deleteCanvasSection(
      client,
      'test-token',
      input(before.revision),
      AbortSignal.abort(),
    ),
  );
  assert.equal(state.writes, 0);
  const results = await Promise.allSettled([
    deleteCanvasSection(client, 'test-token', input(before.revision)),
    deleteCanvasSection(client, 'test-token', input(before.revision)),
  ]);
  assert.equal(
    results.filter(result => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(state.writes, 1);
});
