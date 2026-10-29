import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_DIFF_BUDGET, LARGE_DIFF_BUDGET} from '../src/diff-budget.ts';
import {PullRequestContext, PullRequestReader} from '../src/pr-context.ts';
import {
  appendScopedDiffPart,
  createTextAccumulator,
} from '../src/review-core.ts';
import {REVIEW_TOOL_PARAMS} from '../src/review-tool-contract.ts';

// All input is generated synthetic text; these tests make no GitHub/model calls.
test('large-diff runtime and public contract agree without widening normal mode', () => {
  assert.deepEqual(DEFAULT_DIFF_BUDGET, {
    maxBytes: 150 * 1024,
    maxLines: 6000,
  });
  assert.deepEqual(LARGE_DIFF_BUDGET, {
    maxBytes: 393216,
    maxLines: 10000,
  });
  const schema = REVIEW_TOOL_PARAMS as unknown as {
    properties: {largeDiff: {description: string}};
  };
  assert.match(
    schema.properties.largeDiff.description,
    /10,000 lines or 384 KiB/,
  );
});

test('large-diff byte boundary is inclusive and normal mode remains bounded', () => {
  const append = (text: string, budget = LARGE_DIFF_BUDGET) =>
    appendScopedDiffPart('', text, createTextAccumulator(), budget);
  const boundary = 'x'.repeat(LARGE_DIFF_BUDGET.maxBytes);
  assert.equal(append(boundary), boundary);
  assert.throws(() => append(boundary + 'x'), /too large/);
  const moderate = 'x'.repeat(320 * 1024);
  assert.equal(append(moderate), moderate);
  assert.throws(() => append(moderate, DEFAULT_DIFF_BUDGET), /too large/);
  const normal = 'x'.repeat(DEFAULT_DIFF_BUDGET.maxBytes);
  assert.equal(append(normal, DEFAULT_DIFF_BUDGET), normal);
  assert.throws(() => append(normal + 'x', DEFAULT_DIFF_BUDGET), /too large/);
});

test('large-diff accounting includes UTF-8 bytes and cumulative separators', () => {
  const unicode = 'é'.repeat(LARGE_DIFF_BUDGET.maxBytes / 2);
  assert.equal(Buffer.byteLength(unicode), LARGE_DIFF_BUDGET.maxBytes);
  assert.equal(
    appendScopedDiffPart(
      '',
      unicode,
      createTextAccumulator(),
      LARGE_DIFF_BUDGET,
    ),
    unicode,
  );
  assert.throws(
    () =>
      appendScopedDiffPart(
        '',
        unicode + 'x',
        createTextAccumulator(),
        LARGE_DIFF_BUDGET,
      ),
    /too large/,
  );
  const accumulator = createTextAccumulator();
  const first = appendScopedDiffPart(
    '',
    'x'.repeat(LARGE_DIFF_BUDGET.maxBytes - 2),
    accumulator,
    LARGE_DIFF_BUDGET,
  );
  const complete = appendScopedDiffPart(
    first,
    'y',
    accumulator,
    LARGE_DIFF_BUDGET,
  );
  assert.equal(Buffer.byteLength(complete), LARGE_DIFF_BUDGET.maxBytes);
  assert.throws(
    () => appendScopedDiffPart(complete, 'z', accumulator, LARGE_DIFF_BUDGET),
    /too large/,
  );
});

test('large diffs retain the independent 10000-line ceiling', () => {
  const boundary = 'x\n'.repeat(LARGE_DIFF_BUDGET.maxLines);
  assert.equal(
    appendScopedDiffPart(
      '',
      boundary,
      createTextAccumulator(),
      LARGE_DIFF_BUDGET,
    ),
    boundary,
  );
  assert.throws(
    () =>
      appendScopedDiffPart(
        '',
        boundary + 'x\n',
        createTextAccumulator(),
        LARGE_DIFF_BUDGET,
      ),
    /too large/,
  );
});

function contextWithRelatedDiff(diff: string): PullRequestContext {
  const primary = {
    id: 'primary',
    url: 'https://github.com/example/primary/pull/1',
    repository: 'example/primary',
    headRepository: 'example/primary',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    title: 'Synthetic shared-budget fixture',
    body: 'Companion: https://github.com/example/companion/pull/2',
    descriptionHash: 'c'.repeat(64),
    changedFileCount: 1,
    observedAt: new Date(0).toISOString(),
  };
  const reader = new PullRequestReader();
  reader.pullRequest = async (url, id) => ({
    ...primary,
    id,
    url,
    repository: 'example/companion',
    headRepository: 'example/companion',
    body: '',
  });
  reader.related = async snapshot => ({
    ...snapshot,
    mergeBase: 'a'.repeat(40),
    diff,
    changedFiles: ['example.txt'],
    changedFileDetails: {},
  });
  return new PullRequestContext(reader, primary, {
    source: 'bundled',
    text: 'Synthetic policy fixture',
    hash: 'd'.repeat(64),
  });
}

test('primary and related PR diffs share the same byte and line ceilings', async () => {
  const primary = 'p'.repeat(200 * 1024);
  const related = 'r'.repeat(LARGE_DIFF_BUDGET.maxBytes - primary.length - 1);
  const exact = contextWithRelatedDiff(related);
  await exact.captureRelated(LARGE_DIFF_BUDGET, primary);
  assert.equal(exact.related.length, 1);
  await assert.rejects(
    contextWithRelatedDiff(related + 'r').captureRelated(
      LARGE_DIFF_BUDGET,
      primary,
    ),
    /Combined primary\/related diff exceeds/,
  );
  const primaryLines = 'p\n'.repeat(5000);
  const relatedLines = 'r\n'.repeat(4998);
  assert.equal((primaryLines + '\n' + relatedLines).split('\n').length, 10000);
  await contextWithRelatedDiff(relatedLines).captureRelated(
    LARGE_DIFF_BUDGET,
    primaryLines,
  );
  await assert.rejects(
    contextWithRelatedDiff(relatedLines + 'r\n').captureRelated(
      LARGE_DIFF_BUDGET,
      primaryLines,
    ),
    /Combined primary\/related diff exceeds/,
  );
});
