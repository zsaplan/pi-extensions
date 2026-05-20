import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCategoryFinishedArtifactEntry,
  buildCategoryStartedArtifactEntry,
  buildConflictAnalysisArtifactEntry,
  buildReviewerEventArtifactEntry,
  type ReviewArtifactEntryBaseFields,
} from '../src/review-artifacts.ts';
import {
  REVIEW_CATEGORY_CONFIGS,
  buildCategoryReviewResult,
  type CategoryReviewResult,
  type ReviewMeta,
} from '../src/review-core.ts';

function makeBase(): ReviewArtifactEntryBaseFields {
  return {
    version: 1,
    toolName: 'polish_solution_review',
    toolCallId: 'tool-1',
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function makeMeta(): ReviewMeta {
  return {
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    elapsedMs: 1000,
    elapsed: '0:01',
    usage: {
      model: 'test/model',
      turns: 1,
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: 0,
    },
  };
}

function makeCategoryResult(): CategoryReviewResult {
  return buildCategoryReviewResult(
    'adversarial',
    {status: 'approve', summary: 'ok', findings: []},
    makeMeta(),
  );
}

test('category artifact builders preserve boundary metadata', () => {
  const categoryConfig = REVIEW_CATEGORY_CONFIGS[1];
  const started = buildCategoryStartedArtifactEntry(
    makeBase(),
    categoryConfig,
    2,
    5,
  );

  assert.equal(started.entryType, 'category-started');
  assert.equal(started.category, 'simplify');
  assert.equal(started.ordinal, 2);
  assert.equal(started.totalCategories, 5);
  assert.equal(started.label, 'Simplify Review');

  const result = makeCategoryResult();
  const finished = buildCategoryFinishedArtifactEntry(makeBase(), {
    category: 'adversarial',
    ordinal: 1,
    totalCategories: 5,
    status: 'success',
    result,
  });

  assert.equal(finished.entryType, 'category-finished');
  assert.equal(finished.status, 'success');
  assert.equal(finished.result, result);
});

test('reviewer-event and conflict-analysis artifact builders keep category context', () => {
  const reviewerEvent = buildReviewerEventArtifactEntry(
    makeBase(),
    {type: 'tool_execution_start', toolName: 'git_diff'},
    {category: 'dry', ordinal: 5, totalCategories: 5},
  );

  assert.equal(reviewerEvent.entryType, 'reviewer-event');
  assert.equal(reviewerEvent.category, 'dry');
  assert.equal(reviewerEvent.ordinal, 5);
  assert.deepEqual(reviewerEvent.event, {
    type: 'tool_execution_start',
    toolName: 'git_diff',
  });

  const categoryResult = makeCategoryResult();
  const conflictAnalysis = buildConflictAnalysisArtifactEntry(
    makeBase(),
    [categoryResult],
    [
      {
        finding_ids: ['adversarial-01', 'prune-01'],
        summary: 'conflict',
        resolution: 'prefer-adversarial',
        preferred_finding_id: 'adversarial-01',
        rationale: 'test',
      },
    ],
  );

  assert.equal(conflictAnalysis.entryType, 'conflict-analysis');
  assert.deepEqual(conflictAnalysis.categoryResults, [categoryResult]);
  assert.equal(conflictAnalysis.conflicts[0].resolution, 'prefer-adversarial');
});

test('category failure artifact preserves error and completed results', () => {
  const completed = makeCategoryResult();
  const failed = buildCategoryFinishedArtifactEntry(makeBase(), {
    category: 'simplify',
    ordinal: 2,
    totalCategories: 5,
    status: 'error',
    error: {name: 'Error', message: 'boom'},
    completedCategoryResults: [completed],
  });

  assert.equal(failed.entryType, 'category-finished');
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.error, {name: 'Error', message: 'boom'});
  assert.deepEqual(failed.completedCategoryResults, [completed]);
});
