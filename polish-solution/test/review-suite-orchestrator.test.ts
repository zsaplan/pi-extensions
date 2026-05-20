import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVIEW_CATEGORY_CONFIGS,
  runCategoryReviewSequence,
  type CategorySequenceEvent,
  type ReviewMeta,
} from '../src/review-core.ts';

function makeMeta(): ReviewMeta {
  return {
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    elapsedMs: 1000,
    elapsed: '0:01',
    usage: {
      model: 'test/model',
      turns: 1,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: 0,
    },
  };
}

test('category sequence creates one fresh runner state per category in order', async () => {
  const seenCategories: string[] = [];
  const stateObjects: Array<{diffCache: Record<string, string>}> = [];
  const events: CategorySequenceEvent[] = [];

  const result = await runCategoryReviewSequence(
    REVIEW_CATEGORY_CONFIGS.slice(0, 3),
    async categoryConfig => {
      const state: {diffCache: Record<string, string>} = {diffCache: {}};
      state.diffCache[categoryConfig.category] = 'inspected';
      stateObjects.push(state);
      seenCategories.push(categoryConfig.category);
      return {
        category: categoryConfig.category,
        review: {
          status: 'approve',
          summary: `${categoryConfig.category} ok`,
          findings: [],
        },
        meta: makeMeta(),
      };
    },
    event => events.push(event),
  );

  assert.deepEqual(seenCategories, ['adversarial', 'simplify', 'standardize']);
  assert.equal(new Set(stateObjects).size, 3);
  assert.equal('simplify' in stateObjects[0].diffCache, false);
  assert.deepEqual(
    result.categoryResults.map(categoryResult => categoryResult.category),
    seenCategories,
  );
  assert.deepEqual(
    events.map(event => event.type),
    [
      'category-started',
      'category-finished',
      'category-started',
      'category-finished',
      'category-started',
      'category-finished',
      'conflict-analysis',
    ],
  );
});

test('category sequence stops on first failure and preserves partial diagnostics', async () => {
  const events: CategorySequenceEvent[] = [];
  const attemptedCategories: string[] = [];
  const expectedError = new Error('simplify failed');

  await assert.rejects(
    () =>
      runCategoryReviewSequence(
        REVIEW_CATEGORY_CONFIGS.slice(0, 3),
        async categoryConfig => {
          attemptedCategories.push(categoryConfig.category);
          if (categoryConfig.category === 'simplify') throw expectedError;
          return {
            category: categoryConfig.category,
            review: {
              status: 'approve',
              summary: `${categoryConfig.category} ok`,
              findings: [],
            },
            meta: makeMeta(),
          };
        },
        event => events.push(event),
      ),
    error => {
      assert.equal(error, expectedError);
      assert.equal(
        (error as {failedCategory?: string}).failedCategory,
        'simplify',
      );
      assert.deepEqual(
        (
          error as {categoryResults?: Array<{category: string}>}
        ).categoryResults?.map(result => result.category),
        ['adversarial'],
      );
      return true;
    },
  );

  assert.deepEqual(attemptedCategories, ['adversarial', 'simplify']);
  assert.deepEqual(
    events.map(
      event =>
        `${event.type}:${'categoryConfig' in event ? event.categoryConfig.category : 'suite'}:${'status' in event ? event.status : ''}`,
    ),
    [
      'category-started:adversarial:',
      'category-finished:adversarial:success',
      'category-started:simplify:',
      'category-finished:simplify:error',
    ],
  );
  const failureEvent = events[3];
  assert.equal(failureEvent.type, 'category-finished');
  assert.equal(failureEvent.status, 'error');
  assert.deepEqual(
    failureEvent.completedCategoryResults.map(result => result.category),
    ['adversarial'],
  );
});
