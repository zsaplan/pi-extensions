import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

const DISPLAY_KEY = 'pr-worktree-status';
const CACHE_VERSION = 1;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = REFRESH_INTERVAL_MS;
const LOCK_TTL_MS = 30 * 1000;
const CACHE_WRITE_LOCK_KEY = '__cache-write__';
const GH_PR_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'reviewRequests',
  'statusCheckRollup',
  'updatedAt',
].join(',');

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

interface GitHubRepoRef {
  owner: string;
  repo: string;
}

interface GitHubRemote extends GitHubRepoRef {
  name: string;
}

interface LocalGitContext {
  root: string;
  branch: string | null;
  repo: GitHubRepoRef | null;
}

interface ReviewRequestLike {
  login?: unknown;
  slug?: unknown;
  name?: unknown;
}

interface CheckLike {
  conclusion?: unknown;
  state?: unknown;
  status?: unknown;
}

export interface CachedPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewRequests: ReviewRequestLike[];
  statusCheckRollup: CheckLike[];
  updatedAt?: string;
}

interface CacheEntryBase {
  fetchedAt: number;
  expiresAt: number;
}

export interface FoundCacheEntry extends CacheEntryBase {
  kind: 'found';
  pr: CachedPullRequest;
}

interface EmptyCacheEntry extends CacheEntryBase {
  kind: 'none';
  message: string;
}

interface ErrorCacheEntry extends CacheEntryBase {
  kind: 'error';
  message: string;
}

type CacheEntry = FoundCacheEntry | EmptyCacheEntry | ErrorCacheEntry;

interface WorktreeMapping extends PullRequestRef {
  key: string;
  path: string;
  createdAt: number;
}

interface PrStatusCache {
  version: 1;
  entries: Record<string, CacheEntry>;
  worktrees: Record<string, WorktreeMapping>;
}

interface PullRequestTarget {
  key: string;
  cwd: string;
  repo: GitHubRepoRef;
  prUrl?: string;
}

type RefreshOutcome =
  | 'no-target'
  | 'cache-hit'
  | 'fresh'
  | 'none'
  | 'error'
  | 'refresh-in-progress'
  | 'stale-refresh-in-progress'
  | 'stale-error'
  | 'cache-write-error';

type RefreshSeverity = 'info' | 'warning' | 'error';

interface RefreshResult {
  entry?: CacheEntry;
  message: string;
  outcome: RefreshOutcome;
  severity: RefreshSeverity;
  cause?: CacheEntry;
}

export interface WorktreeCreateResult {
  created: boolean;
  worktreePath: string;
  pr: CachedPullRequest;
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeWorktreePath(worktreePath: string): string {
  return path.resolve(worktreePath);
}

function cacheKeyForPr(ref: PullRequestRef): string {
  return `pr:${ref.owner}/${ref.repo}#${ref.number}`;
}

function cacheKeyForBranch(repo: GitHubRepoRef, branch: string): string {
  return `branch:${repo.owner}/${repo.repo}#${branch}`;
}

function getCacheFile(cacheDir: string): string {
  return path.join(cacheDir, 'cache.json');
}

function safeFileToken(value: string): string {
  return Buffer.from(value).toString('base64url');
}

export function getCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_PR_STATUS_CACHE_DIR) return env.PI_PR_STATUS_CACHE_DIR;

  const base =
    env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache');
  return path.join(base, 'pi-pr-status');
}

export function parsePullRequestUrl(value: string): PullRequestRef | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'github.com') return null;

  const parts = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  if (parts.length < 4 || parts[2] !== 'pull') return null;

  const number = Number(parts[3]);
  if (!Number.isInteger(number) || number <= 0) return null;

  return {
    owner: parts[0],
    repo: parts[1],
    number,
    url: `https://github.com/${parts[0]}/${parts[1]}/pull/${number}`,
  };
}

export function parseGitHubRepo(remoteUrl: string): GitHubRepoRef | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {owner: sshMatch[1], repo: sshMatch[2]};
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== 'github.com') return null;

    const parts = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (parts.length < 2) return null;

    return {
      owner: parts[0],
      repo: parts[1].replace(/\.git$/, ''),
    };
  } catch {
    return null;
  }
}

export function parseGitHubRemotes(remoteOutput: string): GitHubRemote[] {
  const remotes: GitHubRemote[] = [];
  const seen = new Set<string>();

  for (const line of remoteOutput.split('\n')) {
    const [name, remoteUrl] = line.trim().split(/\s+/);
    if (!name || !remoteUrl) continue;

    const repo = parseGitHubRepo(remoteUrl);
    if (!repo) continue;

    const key = `${name}:${repo.owner}/${repo.repo}`;
    if (seen.has(key)) continue;

    seen.add(key);
    remotes.push({name, ...repo});
  }

  return remotes;
}

function pickRemote(
  remotes: GitHubRemote[],
  ref?: GitHubRepoRef,
): GitHubRemote | null {
  const candidates = ref
    ? remotes.filter(
        remote => remote.owner === ref.owner && remote.repo === ref.repo,
      )
    : remotes;
  return (
    candidates.find(remote => remote.name === 'origin') ?? candidates[0] ?? null
  );
}

function sameRepo(left: GitHubRepoRef | null, right: GitHubRepoRef): boolean {
  return left?.owner === right.owner && left.repo === right.repo;
}

async function readCache(cacheDir: string): Promise<PrStatusCache> {
  try {
    const raw = await fs.readFile(getCacheFile(cacheDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PrStatusCache>;
    if (parsed.version !== CACHE_VERSION) return emptyCache();

    return {
      version: CACHE_VERSION,
      entries: parsed.entries ?? {},
      worktrees: parsed.worktrees ?? {},
    };
  } catch {
    return emptyCache();
  }
}

function emptyCache(): PrStatusCache {
  return {version: CACHE_VERSION, entries: {}, worktrees: {}};
}

async function writeCache(
  cacheDir: string,
  cache: PrStatusCache,
): Promise<void> {
  await fs.mkdir(cacheDir, {recursive: true});
  const cacheFile = getCacheFile(cacheDir);
  const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await fs.rename(tempFile, cacheFile);
}

async function updateCache(
  cacheDir: string,
  updater: (cache: PrStatusCache) => void,
): Promise<PrStatusCache> {
  const releaseLock = await acquireCacheWriteLock(cacheDir);
  try {
    const cache = await readCache(cacheDir);
    updater(cache);
    await writeCache(cacheDir, cache);
    return cache;
  } finally {
    await releaseLock();
  }
}

async function acquireCacheLock(
  cacheDir: string,
  key: string,
  now = Date.now(),
): Promise<(() => Promise<void>) | null> {
  await fs.mkdir(cacheDir, {recursive: true});
  const lockPath = path.join(cacheDir, `${safeFileToken(key)}.lock`);

  try {
    const handle = await fs.open(lockPath, 'wx');
    try {
      await handle.writeFile(`${now}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return async () => {
      await fs.unlink(lockPath).catch(() => undefined);
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
  }

  try {
    const stat = await fs.stat(lockPath);
    if (now - stat.mtimeMs > LOCK_TTL_MS) {
      await fs.unlink(lockPath).catch(() => undefined);
      return acquireCacheLock(cacheDir, key, now);
    }
  } catch {
    return acquireCacheLock(cacheDir, key, now);
  }

  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireCacheWriteLock(
  cacheDir: string,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TTL_MS;

  while (true) {
    const releaseLock = await acquireCacheLock(cacheDir, CACHE_WRITE_LOCK_KEY);
    if (releaseLock) return releaseLock;

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for PR status cache write lock.');
    }
    await sleep(25);
  }
}

async function getGitContext(
  pi: ExtensionAPI,
  cwd: string,
): Promise<LocalGitContext | null> {
  const rootResult = await pi.exec('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeout: 5_000,
  });
  if (rootResult.code !== 0) return null;

  const root = normalizeSpace(rootResult.stdout);
  if (!root) return null;

  const branchResult = await pi.exec('git', ['branch', '--show-current'], {
    cwd: root,
    timeout: 5_000,
  });
  const branch = normalizeSpace(branchResult.stdout) || null;

  const remotesResult = await pi.exec('git', ['remote', '-v'], {
    cwd: root,
    timeout: 5_000,
  });
  const remote = pickRemote(parseGitHubRemotes(remotesResult.stdout));

  return {
    root: normalizeWorktreePath(root),
    branch,
    repo: remote ? {owner: remote.owner, repo: remote.repo} : null,
  };
}

function worktreeMappingMatchesContext(
  mapping: WorktreeMapping,
  context: LocalGitContext,
): boolean {
  return (
    sameRepo(context.repo, {owner: mapping.owner, repo: mapping.repo}) &&
    context.branch === `pr-${mapping.number}`
  );
}

async function discardStaleWorktreeMapping(
  cacheDir: string,
  root: string,
): Promise<void> {
  await updateCache(cacheDir, cache => {
    delete cache.worktrees[root];
  }).catch(() => undefined);
}

async function resolveCurrentTarget(
  pi: ExtensionAPI,
  cwd: string,
  cacheDir: string,
): Promise<PullRequestTarget | null> {
  const context = await getGitContext(pi, cwd);
  if (!context) return null;

  const cache = await readCache(cacheDir);
  const mapping = cache.worktrees[context.root];
  if (mapping && worktreeMappingMatchesContext(mapping, context)) {
    return {
      key: mapping.key,
      cwd: context.root,
      repo: {owner: mapping.owner, repo: mapping.repo},
      prUrl: mapping.url,
    };
  }
  if (mapping) await discardStaleWorktreeMapping(cacheDir, context.root);

  if (!context.branch || !context.repo) return null;

  return {
    key: cacheKeyForBranch(context.repo, context.branch),
    cwd: context.root,
    repo: context.repo,
  };
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function coercePullRequest(raw: unknown): CachedPullRequest | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const number = Number(record.number);
  if (!Number.isInteger(number) || number <= 0) return null;

  const url = coerceString(record.url);
  if (!url) return null;

  return {
    number,
    title: coerceString(record.title),
    url,
    state: coerceString(record.state) || 'UNKNOWN',
    isDraft: Boolean(record.isDraft),
    reviewRequests: Array.isArray(record.reviewRequests)
      ? (record.reviewRequests as ReviewRequestLike[])
      : [],
    statusCheckRollup: Array.isArray(record.statusCheckRollup)
      ? (record.statusCheckRollup as CheckLike[])
      : [],
    updatedAt: coerceString(record.updatedAt) || undefined,
  };
}

function isNoPullRequestMessage(message: string): boolean {
  return /no pull requests? found/i.test(message);
}

async function runGhPrView(
  pi: ExtensionAPI,
  target: PullRequestTarget,
): Promise<{entry: CacheEntry; preservePreviousOnError: boolean}> {
  const args = ['pr', 'view'];
  if (target.prUrl) args.push(target.prUrl);
  args.push('--json', GH_PR_FIELDS);

  const result = await pi.exec('gh', args, {cwd: target.cwd, timeout: 15_000});
  const now = Date.now();

  if (result.code !== 0) {
    const message = normalizeSpace(
      result.stderr || result.stdout || `gh exited ${result.code}`,
    );
    if (isNoPullRequestMessage(message)) {
      return {
        entry: {
          kind: 'none',
          fetchedAt: now,
          expiresAt: now + CACHE_TTL_MS,
          message: 'No PR found for this worktree.',
        },
        preservePreviousOnError: false,
      };
    }

    return {
      entry: {
        kind: 'error',
        fetchedAt: now,
        expiresAt: now + CACHE_TTL_MS,
        message: message || 'Failed to refresh PR status.',
      },
      preservePreviousOnError: true,
    };
  }

  try {
    const pr = coercePullRequest(JSON.parse(result.stdout));
    if (!pr) throw new Error('missing pull request fields');

    return {
      entry: {
        kind: 'found',
        fetchedAt: now,
        expiresAt: now + CACHE_TTL_MS,
        pr,
      },
      preservePreviousOnError: false,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'unknown parse error';
    return {
      entry: {
        kind: 'error',
        fetchedAt: now,
        expiresAt: now + CACHE_TTL_MS,
        message: `Failed to parse gh pr view output: ${message}`,
      },
      preservePreviousOnError: true,
    };
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultFromEntry(
  entry: CacheEntry,
  outcome: RefreshOutcome,
): RefreshResult {
  if (entry.kind === 'found') {
    return {
      entry,
      outcome,
      severity: 'info',
      message:
        outcome === 'fresh'
          ? 'PR status refreshed.'
          : 'Using cached PR status.',
    };
  }

  if (entry.kind === 'none') {
    return {entry, outcome: 'none', severity: 'info', message: entry.message};
  }

  return {entry, outcome: 'error', severity: 'error', message: entry.message};
}

function cacheEntryMessage(entry: CacheEntry | undefined): string | undefined {
  if (!entry || entry.kind === 'found') return undefined;
  return entry.message;
}

function staleResult(
  entry: FoundCacheEntry,
  outcome: 'stale-error' | 'stale-refresh-in-progress',
  message: string,
  cause?: CacheEntry,
): RefreshResult {
  return {entry, outcome, severity: 'warning', message, cause};
}

async function getOrRefreshEntry(
  pi: ExtensionAPI,
  target: PullRequestTarget,
  cacheDir: string,
  force: boolean,
): Promise<RefreshResult> {
  const now = Date.now();
  const cache = await readCache(cacheDir);
  const cachedEntry = cache.entries[target.key];
  if (!force && cachedEntry && cachedEntry.expiresAt > now) {
    return resultFromEntry(cachedEntry, 'cache-hit');
  }

  const releaseLock = await acquireCacheLock(cacheDir, target.key, now);
  if (!releaseLock) {
    const latest =
      (await readCache(cacheDir)).entries[target.key] ?? cachedEntry;
    if (latest?.kind === 'found') {
      return staleResult(
        latest,
        'stale-refresh-in-progress',
        'Showing cached PR status while another refresh is in progress.',
      );
    }
    if (latest) return resultFromEntry(latest, 'cache-hit');

    return {
      outcome: 'refresh-in-progress',
      severity: 'info',
      message: 'PR status refresh is already in progress.',
    };
  }

  try {
    const latest = await readCache(cacheDir);
    const latestEntry = latest.entries[target.key];
    if (!force && latestEntry && latestEntry.expiresAt > Date.now()) {
      return resultFromEntry(latestEntry, 'cache-hit');
    }

    const {entry, preservePreviousOnError} = await runGhPrView(pi, target);
    if (preservePreviousOnError && latestEntry?.kind === 'found') {
      return staleResult(
        latestEntry,
        'stale-error',
        `Showing stale PR status; refresh failed: ${
          cacheEntryMessage(entry) ?? 'unknown refresh error'
        }`,
        entry,
      );
    }

    try {
      await updateCache(cacheDir, cache => {
        cache.entries[target.key] = entry;
      });
    } catch (error) {
      return {
        entry,
        outcome: 'cache-write-error',
        severity: entry.kind === 'error' ? 'error' : 'warning',
        message: `PR status resolved but cache update failed: ${messageFromError(
          error,
        )}`,
        cause: entry,
      };
    }

    return resultFromEntry(
      entry,
      entry.kind === 'found' ? 'fresh' : entry.kind,
    );
  } finally {
    await releaseLock();
  }
}

function labelReviewRequest(request: ReviewRequestLike): string | null {
  if (typeof request.login === 'string' && request.login)
    return `@${request.login}`;
  if (typeof request.slug === 'string' && request.slug) return request.slug;
  if (typeof request.name === 'string' && request.name) return request.name;
  return null;
}

export function summarizeReviewRequests(requests: ReviewRequestLike[]): string {
  if (requests.length === 0) return 'no review request';

  const labels = requests
    .map(labelReviewRequest)
    .filter((value): value is string => Boolean(value));
  if (labels.length === 1) return `review requested: ${labels[0]}`;

  const joined = labels.join(', ');
  if (labels.length > 1 && joined.length <= 32)
    return `review requested: ${joined}`;

  return `review requested: ${requests.length}`;
}

type CheckClassification = 'passing' | 'pending' | 'failing' | 'unknown';

function normalizeCheckValue(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : '';
}

function classifyCheck(check: CheckLike): CheckClassification {
  const values = [check.conclusion, check.state, check.status]
    .map(normalizeCheckValue)
    .filter(Boolean);

  if (
    values.some(value =>
      [
        'FAILURE',
        'FAILED',
        'ERROR',
        'CANCELLED',
        'TIMED_OUT',
        'ACTION_REQUIRED',
      ].includes(value),
    )
  ) {
    return 'failing';
  }

  if (
    values.some(value =>
      [
        'PENDING',
        'EXPECTED',
        'QUEUED',
        'IN_PROGRESS',
        'REQUESTED',
        'WAITING',
      ].includes(value),
    )
  ) {
    return 'pending';
  }

  if (
    values.some(value =>
      ['SUCCESS', 'PASSED', 'COMPLETED', 'SKIPPED', 'NEUTRAL'].includes(value),
    )
  ) {
    return 'passing';
  }

  return 'unknown';
}

export function summarizeChecks(checks: CheckLike[]): string {
  if (checks.length === 0) return 'checks none';

  const counts = {passing: 0, pending: 0, failing: 0, unknown: 0};
  for (const check of checks) counts[classifyCheck(check)] += 1;

  if (counts.failing > 0)
    return `checks failed ${counts.failing}/${checks.length}`;
  if (counts.pending > 0)
    return `checks pending ${counts.pending}/${checks.length}`;
  if (counts.unknown > 0)
    return `checks unknown ${counts.unknown}/${checks.length}`;
  return 'checks passing';
}

export function formatPrStatusLine(entry: FoundCacheEntry): string {
  const state = entry.pr.isDraft ? 'draft' : entry.pr.state.toLowerCase();
  return [
    state,
    summarizeReviewRequests(entry.pr.reviewRequests),
    summarizeChecks(entry.pr.statusCheckRollup),
    entry.pr.url,
  ].join(' · ');
}

function conciseStatusMessage(message: string): string {
  return truncatePlainText(normalizeSpace(message), 96);
}

export function formatPrStatusErrorLine(message: string): string {
  return `PR status error: ${conciseStatusMessage(message)}`;
}

function formatRefreshResultLine(result: RefreshResult): string | undefined {
  if (result.entry?.kind === 'found') {
    const line = formatPrStatusLine(result.entry);
    if (result.outcome === 'stale-error') {
      const causeMessage = cacheEntryMessage(result.cause) ?? result.message;
      return `stale: refresh failed (${conciseStatusMessage(causeMessage)}) · ${line}`;
    }
    if (result.outcome === 'stale-refresh-in-progress') {
      return `refreshing: using cached status · ${line}`;
    }
    if (result.outcome === 'cache-write-error') {
      return `cache warning: ${conciseStatusMessage(result.message)} · ${line}`;
    }
    return line;
  }

  if (result.outcome === 'refresh-in-progress') {
    return 'PR status refresh in progress…';
  }
  if (
    result.outcome === 'error' ||
    result.entry?.kind === 'error' ||
    result.outcome === 'cache-write-error'
  ) {
    return formatPrStatusErrorLine(result.message);
  }

  return undefined;
}

function truncatePlainText(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

function fitStatusLine(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;

  const separator = ' · ';
  const urlSeparatorIndex = Math.max(
    text.lastIndexOf(`${separator}https://`),
    text.lastIndexOf(`${separator}http://`),
  );
  if (urlSeparatorIndex >= 0) {
    const url = text.slice(urlSeparatorIndex + separator.length);
    if (url.length <= width) {
      const prefixWidth = width - url.length - separator.length;
      if (prefixWidth <= 0) return url;

      const prefix = truncatePlainText(
        text.slice(0, urlSeparatorIndex),
        prefixWidth,
      );
      return `${prefix}${separator}${url}`;
    }
  }

  return truncatePlainText(text, width);
}

export function rightAlignStatusLine(text: string, width: number): string {
  const fitted = fitStatusLine(text, width);
  return `${' '.repeat(Math.max(0, width - fitted.length))}${fitted}`;
}

function setPrStatusDisplay(
  ctx: ExtensionContext,
  text: string | undefined,
): void {
  if (!ctx.hasUI) return;

  // Earlier builds used footer statuses. Clear that slot so the PR line now
  // renders above pi's model/thinking footer instead of inside it.
  ctx.ui.setStatus(DISPLAY_KEY, undefined);

  if (!text) {
    ctx.ui.setWidget(DISPLAY_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(
    DISPLAY_KEY,
    () => ({
      invalidate() {},
      render(width: number): string[] {
        return [rightAlignStatusLine(text, width)];
      },
    }),
    {placement: 'belowEditor'},
  );
}

async function refreshCurrentStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: {force?: boolean} = {},
): Promise<RefreshResult> {
  try {
    const cacheDir = getCacheDir();
    const target = await resolveCurrentTarget(pi, ctx.cwd, cacheDir);

    if (!target) {
      const result: RefreshResult = {
        outcome: 'no-target',
        severity: 'info',
        message: 'No PR-capable git worktree detected.',
      };
      setPrStatusDisplay(ctx, formatRefreshResultLine(result));
      return result;
    }

    const result = await getOrRefreshEntry(
      pi,
      target,
      cacheDir,
      Boolean(options.force),
    );
    setPrStatusDisplay(ctx, formatRefreshResultLine(result));
    return result;
  } catch (error) {
    const result: RefreshResult = {
      outcome: 'error',
      severity: 'error',
      message: `PR status refresh failed: ${messageFromError(error)}`,
    };
    setPrStatusDisplay(ctx, formatRefreshResultLine(result));
    return result;
  }
}

async function readGitHubRemotes(
  pi: ExtensionAPI,
  cwd: string,
): Promise<GitHubRemote[]> {
  const result = await pi.exec('git', ['remote', '-v'], {cwd, timeout: 5_000});
  return parseGitHubRemotes(result.stdout);
}

async function isMatchingCheckout(
  pi: ExtensionAPI,
  candidatePath: string,
  ref: GitHubRepoRef,
): Promise<boolean> {
  try {
    const stat = await fs.stat(candidatePath);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }

  const rootResult = await pi.exec('git', ['rev-parse', '--show-toplevel'], {
    cwd: candidatePath,
    timeout: 5_000,
  });
  if (rootResult.code !== 0) return false;

  const root = normalizeWorktreePath(normalizeSpace(rootResult.stdout));
  if (root !== normalizeWorktreePath(candidatePath)) return false;

  const remote = pickRemote(await readGitHubRemotes(pi, candidatePath), ref);
  return Boolean(remote);
}

async function findBaseCheckout(
  pi: ExtensionAPI,
  cwd: string,
  ref: GitHubRepoRef,
): Promise<string | null> {
  const context = await getGitContext(pi, cwd);
  if (context && sameRepo(context.repo, ref)) return context.root;

  const candidates: string[] = [];
  if (context) candidates.push(path.join(path.dirname(context.root), ref.repo));

  const home = process.env.HOME || os.homedir();
  candidates.push(path.join(home, 'BriteCore', ref.repo));
  candidates.push(path.join(home, ref.repo));

  const seen = new Set<string>();
  for (const candidate of candidates.map(normalizeWorktreePath)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isMatchingCheckout(pi, candidate, ref)) return candidate;
  }

  return null;
}

export function buildWorktreePath(
  baseCheckout: string,
  repo: string,
  number: number,
): string {
  return path.join(path.dirname(baseCheckout), `${repo}-pr-${number}`);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorktreeMapping(
  cacheDir: string,
  worktreePath: string,
  ref: PullRequestRef,
): Promise<void> {
  await updateCache(cacheDir, cache => {
    cache.worktrees[normalizeWorktreePath(worktreePath)] = {
      ...ref,
      key: cacheKeyForPr(ref),
      path: normalizeWorktreePath(worktreePath),
      createdAt: Date.now(),
    };
  });
}

async function cachePullRequest(
  cacheDir: string,
  ref: PullRequestRef,
  pr: CachedPullRequest,
): Promise<void> {
  const now = Date.now();
  await updateCache(cacheDir, cache => {
    cache.entries[cacheKeyForPr(ref)] = {
      kind: 'found',
      fetchedAt: now,
      expiresAt: now + CACHE_TTL_MS,
      pr,
    };
  });
}

async function loadPullRequestByUrl(
  pi: ExtensionAPI,
  cwd: string,
  ref: PullRequestRef,
): Promise<CachedPullRequest> {
  const result = await pi.exec(
    'gh',
    ['pr', 'view', ref.url, '--json', GH_PR_FIELDS],
    {cwd, timeout: 15_000},
  );
  if (result.code !== 0) {
    throw new Error(
      normalizeSpace(
        result.stderr || result.stdout || `gh exited ${result.code}`,
      ),
    );
  }

  const pr = coercePullRequest(JSON.parse(result.stdout));
  if (!pr)
    throw new Error('gh pr view did not return expected pull request fields');
  return pr;
}

async function validateExistingWorktreePath(
  pi: ExtensionAPI,
  worktreePath: string,
  ref: PullRequestRef,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(worktreePath);
  } catch {
    throw new Error(`Existing path disappeared: ${worktreePath}.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Existing PR worktree path is not a directory: ${worktreePath}.`,
    );
  }

  const rootResult = await pi.exec('git', ['rev-parse', '--show-toplevel'], {
    cwd: worktreePath,
    timeout: 5_000,
  });
  if (rootResult.code !== 0) {
    throw new Error(
      `Existing PR worktree path is not a git checkout: ${worktreePath}.`,
    );
  }

  const root = normalizeWorktreePath(normalizeSpace(rootResult.stdout));
  if (root !== normalizeWorktreePath(worktreePath)) {
    throw new Error(
      `Existing PR worktree path resolves to ${root}, not ${worktreePath}.`,
    );
  }

  const remote = pickRemote(await readGitHubRemotes(pi, worktreePath), ref);
  if (!remote) {
    throw new Error(
      `Existing PR worktree path is not a checkout for ${ref.owner}/${ref.repo}: ${worktreePath}.`,
    );
  }

  const expectedBranch = `pr-${ref.number}`;
  const branchResult = await pi.exec('git', ['branch', '--show-current'], {
    cwd: worktreePath,
    timeout: 5_000,
  });
  const branch = normalizeSpace(branchResult.stdout);
  if (branch !== expectedBranch) {
    throw new Error(
      `Existing PR worktree path is on ${
        branch || 'detached HEAD'
      }, expected ${expectedBranch}: ${worktreePath}.`,
    );
  }

  const fetchResult = await pi.exec(
    'git',
    ['fetch', remote.name, `pull/${ref.number}/head`],
    {cwd: worktreePath, timeout: 60_000},
  );
  if (fetchResult.code !== 0) {
    throw new Error(
      normalizeSpace(
        fetchResult.stderr ||
          fetchResult.stdout ||
          'git fetch failed for existing PR worktree',
      ),
    );
  }

  const headResult = await pi.exec('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    timeout: 5_000,
  });
  const fetchHeadResult = await pi.exec('git', ['rev-parse', 'FETCH_HEAD'], {
    cwd: worktreePath,
    timeout: 5_000,
  });
  const head = normalizeSpace(headResult.stdout);
  const fetchHead = normalizeSpace(fetchHeadResult.stdout);
  if (
    headResult.code !== 0 ||
    fetchHeadResult.code !== 0 ||
    !head ||
    !fetchHead
  ) {
    throw new Error(
      `Could not verify existing PR worktree HEAD for ${worktreePath}.`,
    );
  }
  if (head !== fetchHead) {
    throw new Error(
      `Existing PR worktree path is not at the latest PR ref for ${
        ref.url
      }: ${worktreePath}.`,
    );
  }
}

async function createPullRequestWorktree(
  pi: ExtensionAPI,
  cwd: string,
  url: string,
): Promise<WorktreeCreateResult> {
  const ref = parsePullRequestUrl(url);
  if (!ref)
    throw new Error(
      'Usage: /pr-worktree https://github.com/OWNER/REPO/pull/NUMBER',
    );

  const baseCheckout = await findBaseCheckout(pi, cwd, ref);
  if (!baseCheckout) {
    throw new Error(`No local checkout found for ${ref.owner}/${ref.repo}.`);
  }

  const worktreePath = normalizeWorktreePath(
    buildWorktreePath(baseCheckout, ref.repo, ref.number),
  );
  const cacheDir = getCacheDir();
  const pr = await loadPullRequestByUrl(pi, baseCheckout, ref);

  if (await pathExists(worktreePath)) {
    await validateExistingWorktreePath(pi, worktreePath, ref);
    await ensureWorktreeMapping(cacheDir, worktreePath, ref);
    await cachePullRequest(cacheDir, ref, pr);
    return {created: false, worktreePath, pr};
  }

  const remote = pickRemote(await readGitHubRemotes(pi, baseCheckout), ref);
  if (!remote)
    throw new Error(
      `No matching git remote found for ${ref.owner}/${ref.repo}.`,
    );

  const fetchResult = await pi.exec(
    'git',
    ['fetch', remote.name, `pull/${ref.number}/head`],
    {cwd: baseCheckout, timeout: 60_000},
  );
  if (fetchResult.code !== 0) {
    throw new Error(
      normalizeSpace(
        fetchResult.stderr || fetchResult.stdout || 'git fetch failed',
      ),
    );
  }

  const branchName = `pr-${ref.number}`;
  const worktreeResult = await pi.exec(
    'git',
    ['worktree', 'add', '-B', branchName, worktreePath, 'FETCH_HEAD'],
    {cwd: baseCheckout, timeout: 60_000},
  );
  if (worktreeResult.code !== 0) {
    throw new Error(
      normalizeSpace(
        worktreeResult.stderr ||
          worktreeResult.stdout ||
          'git worktree add failed',
      ),
    );
  }

  await ensureWorktreeMapping(cacheDir, worktreePath, ref);
  await cachePullRequest(cacheDir, ref, pr);
  return {created: true, worktreePath, pr};
}

function shellQuote(value: string): string {
  const quote = String.fromCharCode(39);
  return `${quote}${value.split(quote).join(`${quote}\\${quote}${quote}`)}${quote}`;
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, match => `\\${match}`)}"`;
}

async function handlePrRefresh(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const result = await refreshCurrentStatus(pi, ctx, {force: true});
  if (!ctx.hasUI) return;

  ctx.ui.notify(result.message, result.severity);
}

async function handlePrWorktree(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const result = await createPullRequestWorktree(pi, ctx.cwd, args.trim());
    const verb = result.created ? 'Created' : 'Using existing';
    const reviewPrompt = `/skill:pr-polish-review ${result.pr.url}`;
    const nextCommand = `cd ${shellQuote(
      result.worktreePath,
    )} && pi ${shellDoubleQuote(reviewPrompt)}`;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `${verb} ${result.worktreePath}. Start it with: ${nextCommand}`,
        'info',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(message, 'error');
    else throw error;
  }
}

export default function prWorktreeStatus(pi: ExtensionAPI) {
  const refreshTimers = new Map<string, NodeJS.Timeout>();

  function clearRefreshTimer(sessionId: string): void {
    const timer = refreshTimers.get(sessionId);
    if (timer) clearInterval(timer);
    refreshTimers.delete(sessionId);
  }

  pi.registerCommand('pr-refresh', {
    description:
      'Force-refresh the current worktree PR status display using gh.',
    handler: async (_args, ctx) => {
      await handlePrRefresh(pi, ctx);
    },
  });

  pi.registerCommand('pr-worktree', {
    description:
      'Create a sibling worktree for a GitHub PR URL using <repo>-pr-<number>.',
    handler: async (args, ctx) => {
      await handlePrWorktree(pi, args, ctx);
    },
  });

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;

    const sessionId = ctx.sessionManager.getSessionId();
    clearRefreshTimer(sessionId);

    // Reserve the below-editor PR row before the async git/GitHub probe
    // completes. Without this, the footer can move down after the first paint
    // and briefly interleave old footer rows with the new PR row in some
    // terminals.
    setPrStatusDisplay(ctx, 'PR status refresh in progress…');
    void refreshCurrentStatus(pi, ctx);
    const refreshTimer = setInterval(() => {
      void refreshCurrentStatus(pi, ctx);
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
    refreshTimers.set(sessionId, refreshTimer);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    clearRefreshTimer(ctx.sessionManager.getSessionId());
    setPrStatusDisplay(ctx, undefined);
  });
}
