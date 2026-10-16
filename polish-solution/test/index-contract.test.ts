import assert from 'node:assert/strict';
import test from 'node:test';
import {REVIEW_TOOL_PARAMS} from '../src/review-tool-contract.ts';

test('public polish_solution_review parameters expose optional large-diff mode', () => {
  const schema = REVIEW_TOOL_PARAMS as unknown as {
    properties?: Record<string, {description?: string}>;
    required?: string[];
  };

  assert.deepEqual(Object.keys(schema.properties ?? {}), [
    'baseRef',
    'largeDiff',
  ]);
  assert.match(
    schema.properties?.largeDiff?.description ?? '',
    /cost more, take longer, and may reduce review quality/,
  );
  assert.equal(schema.required, undefined);
});
