import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasBlockPage,
  canvasSectionHtml,
  canvasView,
  enrichSectionMatches,
} from '../src/canvas-view.ts';

function snapshot(html: string) {
  return {
    canvasId: 'F123',
    title: 'Report',
    revision: 'a'.repeat(64),
    html: `<div class="quip-canvas-content">${html}</div>`,
  };
}

test('readable blocks retain IDs, decoded content, links, and surrounding headings', () => {
  const doc = snapshot(
    '<h1 id="temp:C:title">Report</h1><h2 id="temp:C:h2">Key findings</h2><p id="temp:C:p">Cost <b>increased</b> &amp; traffic rose.<br><lnk href="https://example.com/?a=1&amp;b=2">Evidence</lnk></p>',
  );
  const {blocks} = canvasView(doc);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[2].text, 'Cost increased & traffic rose.\nEvidence');
  assert.deepEqual(blocks[2].headingPath, ['Report', 'Key findings']);
  assert.deepEqual(blocks[2].links, [
    {text: 'Evidence', url: 'https://example.com/?a=1&b=2'},
  ]);
  assert.equal(blocks[2].id, 'temp:C:p');
});

test('table cells have coordinates; duplicate list item IDs appear only once', () => {
  const doc = snapshot(
    '<table><tr><td><p id="temp:C:a">Area</p></td><td><p id="temp:C:b">Cost</p></td></tr><tr><td><p id="temp:C:c">Test</p></td><td><p id="temp:C:d">$5</p></td></tr></table><ul id="temp:C:list"><li id="temp:C:item"><span id="temp:C:item">Item</span></li><li>No ID item</li></ul>',
  );
  const {blocks, sections} = canvasView(doc);
  assert.equal(blocks.filter(block => block.id === 'temp:C:item').length, 1);
  assert.ok(blocks.some(block => block.text === 'No ID item'));
  assert.ok(!blocks.some(block => block.id === 'temp:C:list'));
  assert.ok(sections.has('temp:C:list'));
  assert.deepEqual(blocks.find(block => block.id === 'temp:C:d')?.table, {
    number: 1,
    row: 2,
    column: 2,
  });
  assert.equal(blocks[0].type, 'table_cell');
});

test('block pagination uses whole blocks and explicit hasMore/isPartial fields', () => {
  const doc = snapshot(
    '<p id="temp:C:one">First</p><p id="temp:C:two">Second</p>',
  );
  const first = canvasBlockPage(doc, 0, 1);
  assert.equal(first.blocks[0].text, 'First');
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBlockOffset, 1);
  const last = canvasBlockPage(doc, first.nextBlockOffset, 1);
  assert.equal(last.blocks[0].text, 'Second');
  assert.equal(last.hasMore, false);
  assert.equal(last.nextBlockOffset, undefined);
  assert.equal(last.isPartial, true);
  assert.equal(last.revision, first.revision);
  assert.equal(canvasBlockPage(doc).isPartial, false);
  assert.throws(() => canvasBlockPage(doc, -1));
  assert.throws(() => canvasBlockPage(doc, 0, 51));
});

test('clipped block previews expose flags and exact raw section fallback', () => {
  const raw = `<p id='temp:C:long'><b>${'🌍'.repeat(1000)}</b></p>`;
  const doc = snapshot(raw);
  const page = canvasBlockPage(doc);
  assert.equal(page.contentTruncated, true);
  assert.equal(page.blocks[0].textTruncated, true);
  assert.equal(canvasSectionHtml(doc, 'temp:C:long'), raw);
  assert.throws(() => canvasSectionHtml(doc, 'temp:C:missing'), /not found/);
});

test('lookup previews disambiguate same text under different headings', () => {
  const doc = snapshot(
    '<h2 id="temp:C:test">Test</h2><p id="temp:C:one">Cost rose</p><h2 id="temp:C:prod">Prod</h2><p id="temp:C:two">Cost rose</p>',
  );
  const matches = enrichSectionMatches(doc, [
    {id: 'temp:C:one'},
    {id: 'temp:C:two'},
    {id: 'temp:C:missing'},
  ]);
  assert.ok('headingPath' in matches[0]);
  assert.ok('headingPath' in matches[1]);
  assert.deepEqual(matches[0].headingPath, ['Test']);
  assert.deepEqual(matches[1].headingPath, ['Prod']);
  assert.equal(matches[0].preview, 'Cost rose');
  assert.equal(matches[2].foundInSnapshot, false);
});

test('readable pages are byte-bounded and do not execute scripts or return corrupted URLs', () => {
  const doc = snapshot(
    Array.from(
      {length: 50},
      (_, i) => `<p id="temp:C:p${i}">${'🌍'.repeat(600)}</p>`,
    ).join(''),
  );
  const page = canvasBlockPage(doc, 0, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) < 40000);
  assert.equal(page.hasMore, true);
  assert.ok(page.blocks.length > 0);
  const unsafe = canvasBlockPage(
    snapshot(
      `<p id="temp:C:p">Safe<script>secret()</script><lnk href="javascript:alert(1)">link</lnk><a href="https://example.com/${'x'.repeat(600)}">Long URL</a></p>`,
    ),
  );
  assert.ok(!unsafe.blocks[0].text.includes('secret'));
  assert.deepEqual(unsafe.blocks[0].links, []);
  assert.equal(unsafe.blocks[0].linksTruncated, true);
});
