import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  REVIEW_CATEGORY_CONFIGS,
  REVIEW_CATEGORY_ORDER,
  appendScopedDiffPart,
  appendTextAccumulator,
  buildCategoryReviewerFailureMessage,
  buildChangedFileDetails,
  buildPackageSelfReviewBlockConfig,
  createTextAccumulator,
  decodeGitQuotedPath,
  getAccumulatedLineCount,
  getRemainingBudget,
  getRemainingCategoryBudgetMs,
  isSameOrNestedPath,
  normalizeGitDiffPath,
  normalizeRepoPath,
  parseDiffHeaderPaths,
  parseNewHunkRange,
  rangesIntersect,
  sanitizeArtifactPathSegment,
  validateReviewerSubmitReadiness,
  validateReviewResult,
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
