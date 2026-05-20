import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  REVIEW_CATEGORY_CONFIGS,
  REVIEW_CATEGORY_ORDER,
  analyzeReviewConflicts,
  appendScopedDiffPart,
  appendTextAccumulator,
  buildCategoryReviewerFailureMessage,
  buildCategoryReviewResult,
  buildChangedFileDetails,
  buildPackageSelfReviewBlockConfig,
  createTextAccumulator,
  decodeGitQuotedPath,
  getAccumulatedLineCount,
  getRemainingBudget,
  getRemainingCategoryBudgetMs,
  buildReviewSuiteResult,
  isSameOrNestedPath,
  normalizeGitDiffPath,
  normalizeRepoPath,
  parseDiffHeaderPaths,
  parseNewHunkRange,
  formatReviewFindingId,
  rangesIntersect,
  sanitizeArtifactPathSegment,
  validateReviewerSubmitReadiness,
  validateReviewResult,
  type ReviewCategory,
  type ReviewMeta,
  type ReviewScope,
} from '../src/review-core.ts';

test('review category registry exposes stable first-slice order and objectives', () => {
  assert.deepEqual(REVIEW_CATEGORY_ORDER, [
    'adversarial',
    'simplify',
    'standardize',
    'prune',
    'dry',
  ]);
  assert.deepEqual(
    REVIEW_CATEGORY_CONFIGS.map(config => config.category),
    REVIEW_CATEGORY_ORDER,
  );
  assert.equal(
    REVIEW_CATEGORY_CONFIGS.every(config => {
      return config.label.length > 0 && config.objective.length > 0;
    }),
    true,
  );
  assert.match(
    REVIEW_CATEGORY_CONFIGS.find(config => config.category === 'dry')
      ?.objective ?? '',
    /duplicated logic/i,
  );
});

function makeMeta(overrides: Partial<ReviewMeta> = {}): ReviewMeta {
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
      cacheRead: 4,
      cacheWrite: 5,
      totalTokens: 14,
      cost: 0.01,
    },
    ...overrides,
  };
}

function makeScope(overrides: Partial<ReviewScope> = {}): ReviewScope {
  return {
    repoRoot: '/repo',
    branch: 'feature',
    baseRef: 'origin/main',
    mergeBase: 'abc123',
    snapshotTree: 'tree123',
    snapshotTempDir: '/tmp/polish-solution-test',
    snapshotEnv: {},
    diff: '',
    diffBytes: 0,
    diffLines: 0,
    changedFiles: ['src/changed.ts'],
    untrackedFiles: [],
    changedFileDetails: {
      'src/changed.ts': {
        ranges: [{start: 10, end: 12}],
        enforceLineValidation: true,
      },
    },
    ...overrides,
  };
}

function makeCategoryResultWithFinding(options: {
  category: ReviewCategory;
  title: string;
  recommendation: string;
  file?: string;
  line_start?: number;
  line_end?: number;
}) {
  return buildCategoryReviewResult(
    options.category,
    {
      status: 'needs-attention',
      summary: `${options.category} finding`,
      findings: [
        {
          title: options.title,
          body: 'body',
          file: options.file ?? 'src/changed.ts',
          line_start: options.line_start ?? 10,
          line_end: options.line_end ?? 12,
          confidence: 'high',
          recommendation: options.recommendation,
        },
      ],
    },
    makeMeta(),
  );
}

test('sanitizeArtifactPathSegment produces safe lowercase path segments', () => {
  assert.equal(
    sanitizeArtifactPathSegment('  My Repo: Feature/One!  ', 'fallback'),
    'my-repo-feature-one',
  );
  assert.equal(sanitizeArtifactPathSegment('🤖', 'fallback'), 'fallback');
});

test('normalizeRepoPath confines paths to the repository root', () => {
  const repoRoot = path.resolve('/tmp/repo');

  assert.equal(normalizeRepoPath(undefined, repoRoot), undefined);
  assert.equal(normalizeRepoPath('  ', repoRoot), undefined);
  assert.equal(
    normalizeRepoPath('./src/../package.json', repoRoot),
    'package.json',
  );
  assert.equal(
    normalizeRepoPath(path.join(repoRoot, 'src', 'index.ts'), repoRoot),
    'src/index.ts',
  );
  assert.throws(
    () => normalizeRepoPath('../outside.ts', repoRoot),
    /outside the repository root/,
  );
  assert.throws(
    () => normalizeRepoPath(path.resolve('/tmp/outside.ts'), repoRoot),
    /outside the repository root/,
  );
});

test('isSameOrNestedPath treats the parent path as contained but rejects siblings', () => {
  const parent = path.resolve('/tmp/repo');

  assert.equal(isSameOrNestedPath(parent, parent), true);
  assert.equal(isSameOrNestedPath(parent, path.join(parent, 'src')), true);
  assert.equal(
    isSameOrNestedPath(parent, path.resolve('/tmp/repo-other')),
    false,
  );
});

test('buildPackageSelfReviewBlockConfig maps loaded package paths into repo-relative blockers', () => {
  const repoRoot = path.resolve('/work/repo');
  const packageRoot = path.join(repoRoot, 'polish-solution');

  const config = buildPackageSelfReviewBlockConfig({repoRoot, packageRoot});

  assert.deepEqual(config && [...config.paths], [
    'polish-solution/package.json',
  ]);
  assert.deepEqual(config?.prefixes, [
    'polish-solution/src/',
    'polish-solution/skills/',
  ]);
  assert.equal(
    buildPackageSelfReviewBlockConfig({
      repoRoot,
      packageRoot: path.resolve('/other/polish-solution'),
    }),
    undefined,
  );
});

test('text accumulator and remaining budget track utf8 bytes and logical lines', () => {
  const accumulator = createTextAccumulator();

  appendTextAccumulator(accumulator, 'one\n');
  appendTextAccumulator(accumulator, 'two');

  assert.equal(accumulator.bytes, Buffer.byteLength('one\ntwo'));
  assert.equal(getAccumulatedLineCount(accumulator), 2);
  assert.deepEqual(
    getRemainingBudget({maxBytes: 20, maxLines: 5}, accumulator),
    {
      maxBytes: 13,
      maxLines: 3,
    },
  );
});

test('appendScopedDiffPart inserts separators and enforces output budgets', () => {
  const accumulator = createTextAccumulator();
  let diff = appendScopedDiffPart('', 'first line', accumulator, {
    maxBytes: 40,
    maxLines: 3,
  });

  diff = appendScopedDiffPart(diff, 'second line', accumulator, {
    maxBytes: 40,
    maxLines: 3,
  });

  assert.equal(diff, 'first line\nsecond line');
  assert.equal(getAccumulatedLineCount(accumulator), 2);

  assert.throws(
    () =>
      appendScopedDiffPart(diff, '\nthird\nfourth', accumulator, {
        maxBytes: 40,
        maxLines: 3,
      }),
    /diff is too large/,
  );
});

test('git diff path parsing handles quoted paths, null paths, and hunk ranges', () => {
  assert.equal(
    decodeGitQuotedPath('src/spaced\\040file.ts'),
    'src/spaced file.ts',
  );
  assert.equal(
    normalizeGitDiffPath('"b/src/spaced\\040file.ts"'),
    'src/spaced file.ts',
  );
  assert.equal(normalizeGitDiffPath('/dev/null'), '/dev/null');
  assert.deepEqual(
    parseDiffHeaderPaths(
      'diff --git "a/src/old\\040name.ts" "b/src/new\\040name.ts"',
    ),
    {oldPath: 'src/old name.ts', newPath: 'src/new name.ts'},
  );
  assert.deepEqual(parseNewHunkRange('@@ -1,2 +10,3 @@ function x()'), {
    start: 10,
    end: 12,
  });
  assert.deepEqual(parseNewHunkRange('@@ -5 +8,0 @@'), {start: 8, end: 8});
});

test('buildChangedFileDetails records changed hunk ranges and disables validation for deleted files', () => {
  const diff = [
    'diff --git a/src/changed.ts b/src/changed.ts',
    '--- a/src/changed.ts',
    '+++ b/src/changed.ts',
    '@@ -1,2 +10,3 @@',
    '+new line',
    'diff --git a/src/deleted.ts b/src/deleted.ts',
    '--- a/src/deleted.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-old line',
    '',
  ].join('\n');

  assert.deepEqual(buildChangedFileDetails(diff), {
    'src/changed.ts': {
      ranges: [{start: 10, end: 12}],
      enforceLineValidation: true,
    },
    'src/deleted.ts': {
      ranges: [],
      enforceLineValidation: false,
    },
  });
});

test('rangesIntersect only accepts overlapping line ranges', () => {
  const ranges = [
    {start: 10, end: 12},
    {start: 20, end: 20},
  ];

  assert.equal(rangesIntersect(ranges, 9, 9), false);
  assert.equal(rangesIntersect(ranges, 9, 10), true);
  assert.equal(rangesIntersect(ranges, 20, 21), true);
});

test('reviewer submit readiness requires per-category status and diff inspection', () => {
  assert.throws(
    () =>
      validateReviewerSubmitReadiness({
        statusInspected: false,
        fullDiffInspected: false,
      }),
    /git_status first/,
  );
  assert.throws(
    () =>
      validateReviewerSubmitReadiness({
        statusInspected: true,
        fullDiffInspected: false,
      }),
    /unscoped git_diff call first/,
  );
  assert.doesNotThrow(() =>
    validateReviewerSubmitReadiness({
      statusInspected: true,
      fullDiffInspected: true,
    }),
  );
});

test('category reviewer budget and failure helpers are deterministic', () => {
  assert.equal(getRemainingCategoryBudgetMs(1000, 1250, 900), 650);
  assert.equal(getRemainingCategoryBudgetMs(1000, 900, 900), 900);
  assert.equal(
    buildCategoryReviewerFailureMessage('simplify', 'timed out'),
    'simplify review failed: timed out',
  );
  assert.equal(
    buildCategoryReviewerFailureMessage(
      'simplify',
      'simplify review failed: timed out',
    ),
    'simplify review failed: timed out',
  );
});

test('category aggregation assigns visible finding ids and preserves compatibility fields', () => {
  assert.equal(formatReviewFindingId('adversarial', 1), 'adversarial-01');

  const categoryResult = buildCategoryReviewResult(
    'adversarial',
    {
      status: 'needs-attention',
      summary: 'found one',
      findings: [
        {
          title: 'Guard matters',
          body: 'The changed guard prevents bad input.',
          file: 'src/changed.ts',
          line_start: 10,
          line_end: 10,
          confidence: 'high',
          recommendation: 'Keep the guard.',
        },
      ],
    },
    makeMeta(),
  );

  assert.deepEqual(categoryResult.findings[0], {
    id: 'adversarial-01',
    category: 'adversarial',
    title: 'Guard matters',
    body: 'The changed guard prevents bad input.',
    file: 'src/changed.ts',
    line_start: 10,
    line_end: 10,
    confidence: 'high',
    recommendation: 'Keep the guard.',
  });

  const suiteResult = buildReviewSuiteResult([categoryResult], makeMeta());

  assert.equal(suiteResult.status, 'needs-attention');
  assert.equal(suiteResult.findings[0].id, 'adversarial-01');
  assert.equal(suiteResult.category_results[0], categoryResult);
  assert.deepEqual(suiteResult.conflicts, []);
  assert.match(suiteResult.summary, /1 finding across 1 review category/);
});

test('conflict analysis prefers adversarial over prune remove/keep conflicts', () => {
  const adversarial = makeCategoryResultWithFinding({
    category: 'adversarial',
    title: 'Keep validation guard',
    recommendation:
      'Keep the changed validation guard because it blocks bad input.',
  });
  const prune = makeCategoryResultWithFinding({
    category: 'prune',
    title: 'Delete redundant guard',
    recommendation: 'Delete the validation guard as redundant.',
  });

  const analysis = analyzeReviewConflicts([adversarial, prune]);
  const suite = buildReviewSuiteResult(
    analysis.categoryResults,
    makeMeta(),
    analysis.conflicts,
  );

  assert.equal(analysis.conflicts.length, 1);
  assert.deepEqual(analysis.conflicts[0].finding_ids, [
    'adversarial-01',
    'prune-01',
  ]);
  assert.equal(analysis.conflicts[0].resolution, 'prefer-adversarial');
  assert.equal(analysis.conflicts[0].preferred_finding_id, 'adversarial-01');
  assert.equal(suite.status, 'needs-attention');
  assert.deepEqual(suite.findings[0].conflicts_with, ['prune-01']);
  assert.deepEqual(suite.findings[1].conflicts_with, ['adversarial-01']);
});

test('conflict analysis leaves standardize/prune preserve/delete deadlocks unresolved', () => {
  const standardize = makeCategoryResultWithFinding({
    category: 'standardize',
    title: 'Preserve compatibility shim',
    recommendation:
      'Preserve the compatibility shim to match the existing extension API shape.',
  });
  const prune = makeCategoryResultWithFinding({
    category: 'prune',
    title: 'Delete obsolete shim',
    recommendation: 'Delete the same compatibility shim as obsolete.',
  });

  const analysis = analyzeReviewConflicts([standardize, prune]);
  const suite = buildReviewSuiteResult(
    analysis.categoryResults,
    makeMeta(),
    analysis.conflicts,
  );

  assert.equal(analysis.conflicts.length, 1);
  assert.deepEqual(analysis.conflicts[0].finding_ids, [
    'standardize-01',
    'prune-01',
  ]);
  assert.equal(analysis.conflicts[0].resolution, 'needs-user-direction');
  assert.equal('preferred_finding_id' in analysis.conflicts[0], false);
  assert.equal(suite.status, 'needs-attention');
  assert.match(suite.summary, /user direction is needed/);
});

test('conflict analysis ignores overlapping findings without explicit opposing action pairs', () => {
  const simplify = makeCategoryResultWithFinding({
    category: 'simplify',
    title: 'Clarify helper flow',
    recommendation: 'Clarify the helper flow around the changed branch.',
  });
  const dry = makeCategoryResultWithFinding({
    category: 'dry',
    title: 'Centralize branch wording',
    recommendation: 'Centralize branch wording near the existing helper.',
  });

  const analysis = analyzeReviewConflicts([simplify, dry]);

  assert.deepEqual(analysis.conflicts, []);
  assert.equal(
    analysis.categoryResults[0].findings[0].conflicts_with,
    undefined,
  );
});

test('suite aggregation approves only when all categories approve and no conflicts exist', () => {
  const approvedCategoryResults = REVIEW_CATEGORY_ORDER.map(category =>
    buildCategoryReviewResult(
      category,
      {status: 'approve', summary: `${category} ok`, findings: []},
      makeMeta(),
    ),
  );

  const approvedSuite = buildReviewSuiteResult(
    approvedCategoryResults,
    makeMeta(),
  );
  assert.equal(approvedSuite.status, 'approve');
  assert.deepEqual(approvedSuite.findings, []);
  assert.match(approvedSuite.summary, /All 5 review categories approved/);

  const conflictedSuite = buildReviewSuiteResult(
    approvedCategoryResults,
    makeMeta(),
    [
      {
        finding_ids: ['adversarial-01', 'prune-01'],
        summary: 'test conflict',
        resolution: 'needs-user-direction',
        rationale: 'test rationale',
      },
    ],
  );
  assert.equal(conflictedSuite.status, 'needs-attention');
  assert.match(conflictedSuite.summary, /user direction is needed/);
});

test('validateReviewResult trims accepted findings and enforces changed-file/hunk invariants', () => {
  const accepted = validateReviewResult(
    {
      status: 'needs-attention',
      summary: '  summary  ',
      findings: [
        {
          title: '  title  ',
          body: '  body  ',
          file: ' src/changed.ts ',
          line_start: 11,
          line_end: 11,
          confidence: 'high',
          recommendation: '  fix it  ',
        },
      ],
    },
    makeScope(),
  );

  assert.deepEqual(accepted, {
    status: 'needs-attention',
    summary: 'summary',
    findings: [
      {
        title: 'title',
        body: 'body',
        file: 'src/changed.ts',
        line_start: 11,
        line_end: 11,
        confidence: 'high',
        recommendation: 'fix it',
      },
    ],
  });

  assert.throws(
    () =>
      validateReviewResult(
        {
          status: 'approve',
          summary: 'summary',
          findings: accepted.findings,
        },
        makeScope(),
      ),
    /approve.*no findings/,
  );
  assert.throws(
    () =>
      validateReviewResult(
        {
          status: 'needs-attention',
          summary: 'summary',
          findings: [],
        },
        makeScope(),
      ),
    /needs-attention.*at least one finding/,
  );
  assert.throws(
    () =>
      validateReviewResult(
        {
          status: 'needs-attention',
          summary: 'summary',
          findings: [
            {
              ...accepted.findings[0],
              file: 'src/unchanged.ts',
            },
          ],
        },
        makeScope(),
      ),
    /must reference a changed file/,
  );
  assert.throws(
    () =>
      validateReviewResult(
        {
          status: 'needs-attention',
          summary: 'summary',
          findings: [
            {
              ...accepted.findings[0],
              line_start: 30,
              line_end: 31,
            },
          ],
        },
        makeScope(),
      ),
    /must intersect a changed hunk/,
  );
});
