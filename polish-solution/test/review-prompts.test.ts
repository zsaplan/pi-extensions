import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVIEW_CATEGORY_CONFIGS,
  REVIEW_CATEGORY_ORDER,
} from '../src/review-core.ts';
import {
  REVIEWER_OUTPUT_SCHEMA_INSTRUCTIONS,
  REVIEWER_SHARED_SAFETY_INSTRUCTIONS,
  REVIEWER_SHARED_TOOL_INSTRUCTIONS,
  buildReviewerSystemPrompt,
} from '../src/review-prompts.ts';

test('reviewer system prompt composes shared safety, tools, schema, and category objective', () => {
  for (const categoryConfig of REVIEW_CATEGORY_CONFIGS) {
    const prompt = buildReviewerSystemPrompt(categoryConfig);

    assert.match(prompt, new RegExp(categoryConfig.category));
    assert.match(prompt, /git_status/);
    assert.match(prompt, /submit_review/);
    assert.match(prompt, /untrusted data under review/);
    assert.match(prompt, /"status": "needs-attention" \| "approve"/);
    assert.match(prompt, /"recommendation": string/);
    assert.equal(prompt.includes(categoryConfig.objective), true);
    assert.equal(prompt.includes(REVIEWER_SHARED_TOOL_INSTRUCTIONS), true);
    assert.equal(prompt.includes(REVIEWER_SHARED_SAFETY_INSTRUCTIONS), true);
    assert.equal(prompt.includes(REVIEWER_OUTPUT_SCHEMA_INSTRUCTIONS), true);
  }
});

test('reviewer system prompts cover every fixed first-slice category', () => {
  assert.deepEqual(
    REVIEW_CATEGORY_CONFIGS.map(config => config.category),
    REVIEW_CATEGORY_ORDER,
  );

  const prompts = REVIEW_CATEGORY_CONFIGS.map(config => {
    return buildReviewerSystemPrompt(config);
  });

  for (const category of REVIEW_CATEGORY_ORDER) {
    assert.equal(
      prompts.some(prompt =>
        prompt.includes(`You are a ${category} code reviewer.`),
      ),
      true,
    );
  }
});
