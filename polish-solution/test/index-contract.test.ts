import assert from 'node:assert/strict';
import test from 'node:test';
import {REVIEW_TOOL_PARAMS} from '../src/review-tool-contract.ts';

test('public polish_solution_review parameters remain baseRef-only in first slice', () => {
  const schema = REVIEW_TOOL_PARAMS as unknown as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  assert.deepEqual(Object.keys(schema.properties ?? {}), ['baseRef']);
  assert.equal(schema.required, undefined);
});
