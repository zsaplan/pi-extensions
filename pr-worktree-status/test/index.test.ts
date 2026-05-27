import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildWorktreePath,
  formatFooterStatus,
  getCacheDir,
  parseGitHubRemotes,
  parseGitHubRepo,
  parsePullRequestUrl,
  summarizeChecks,
  summarizeReviewRequests,
  type FoundCacheEntry,
} from '../src/index.ts';

test('parsePullRequestUrl accepts GitHub PR URLs and normalizes them', () => {
  assert.deepEqual(
    parsePullRequestUrl(
      'https://github.com/IntuitiveWebSolutions/platform/pull/1234?tab=files',
    ),
    {
      owner: 'IntuitiveWebSolutions',
      repo: 'platform',
      number: 1234,
      url: 'https://github.com/IntuitiveWebSolutions/platform/pull/1234',
    },
  );

  assert.deepEqual(parsePullRequestUrl('github.com/o/r/pull/7'), {
    owner: 'o',
    repo: 'r',
    number: 7,
    url: 'https://github.com/o/r/pull/7',
  });

  assert.equal(parsePullRequestUrl('https://github.com/o/r/issues/7'), null);
});

test('parseGitHubRepo supports common remote URL shapes', () => {
  assert.deepEqual(parseGitHubRepo('git@github.com:owner/repo.git'), {
    owner: 'owner',
    repo: 'repo',
  });
  assert.deepEqual(parseGitHubRepo('ssh://git@github.com/owner/repo.git'), {
    owner: 'owner',
    repo: 'repo',
  });
  assert.deepEqual(parseGitHubRepo('https://github.com/owner/repo.git'), {
    owner: 'owner',
    repo: 'repo',
  });
  assert.equal(parseGitHubRepo('git@example.com:owner/repo.git'), null);
});

test('parseGitHubRemotes deduplicates fetch and push remotes', () => {
  assert.deepEqual(
    parseGitHubRemotes(
      'origin git@github.com:owner/repo.git (fetch)\n' +
        'origin git@github.com:owner/repo.git (push)\n' +
        'upstream https://github.com/owner/repo.git (fetch)',
    ),
    [
      {name: 'origin', owner: 'owner', repo: 'repo'},
      {name: 'upstream', owner: 'owner', repo: 'repo'},
    ],
  );
});

test('summarizeReviewRequests keeps the footer compact', () => {
  assert.equal(summarizeReviewRequests([]), 'no review request');
  assert.equal(
    summarizeReviewRequests([{login: 'zach'}]),
    'review requested: @zach',
  );
  assert.equal(
    summarizeReviewRequests([
      {login: 'a'},
      {login: 'b'},
      {login: 'c'},
      {login: 'd'},
    ]),
    'review requested: @a, @b, @c, @d',
  );
  assert.equal(
    summarizeReviewRequests([
      {login: 'very-long-reviewer-a'},
      {login: 'very-long-reviewer-b'},
    ]),
    'review requested: 2',
  );
});

test('summarizeChecks prioritizes failing, then pending, then passing', () => {
  assert.equal(summarizeChecks([]), 'checks none');
  assert.equal(
    summarizeChecks([{conclusion: 'SUCCESS'}, {conclusion: 'SKIPPED'}]),
    'checks passing',
  );
  assert.equal(
    summarizeChecks([{conclusion: 'SUCCESS'}, {status: 'IN_PROGRESS'}]),
    'checks pending 1/2',
  );
  assert.equal(
    summarizeChecks([{status: 'IN_PROGRESS'}, {conclusion: 'FAILURE'}]),
    'checks failed 1/2',
  );
});

test('formatFooterStatus uses concrete fields and includes the full URL', () => {
  const entry: FoundCacheEntry = {
    kind: 'found',
    fetchedAt: 1,
    expiresAt: 2,
    pr: {
      number: 1234,
      title: 'Example PR',
      url: 'https://github.com/IntuitiveWebSolutions/platform/pull/1234',
      state: 'OPEN',
      isDraft: false,
      reviewRequests: [{slug: 'platform'}],
      statusCheckRollup: [{conclusion: 'SUCCESS'}, {status: 'QUEUED'}],
    },
  };

  assert.equal(
    formatFooterStatus(entry),
    'PR #1234 · open · review requested: platform · checks pending 1/2 · https://github.com/IntuitiveWebSolutions/platform/pull/1234',
  );
  assert.doesNotMatch(formatFooterStatus(entry), /REVIEW_REQUIRED/);
});

test('buildWorktreePath follows the sibling <repo>-pr-<number> convention', () => {
  assert.equal(
    buildWorktreePath('/Users/zach/BriteCore/platform', 'platform', 1234),
    path.join('/Users/zach/BriteCore', 'platform-pr-1234'),
  );
});

test('getCacheDir defaults to XDG cache and allows an explicit override', () => {
  assert.equal(
    getCacheDir({XDG_CACHE_HOME: '/tmp/cache'}),
    path.join('/tmp/cache', 'pi-pr-status'),
  );
  assert.equal(
    getCacheDir({PI_PR_STATUS_CACHE_DIR: '/tmp/pr-cache'}),
    '/tmp/pr-cache',
  );
});
