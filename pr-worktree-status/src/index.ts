import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';

const STATUS_KEY = 'pr-worktree-status';
const CACHE_VERSION = 1;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = REFRESH_INTERVAL_MS;
const LOCK_TTL_MS = 30 * 1000;
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

interface RefreshResult {
  entry?: CacheEntry;
  message: string;
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
  const cache = await readCache(cacheDir);
  updater(cache);
  await writeCache(cacheDir, cache);
  return cache;
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

async function resolveCurrentTarget(
  pi: ExtensionAPI,
  cwd: string,
  cacheDir: string,
): Promise<PullRequestTarget | null> {
  const context = await getGitContext(pi, cwd);
  if (!context) return null;

  const cache = await readCache(cacheDir);
  const mapping = cache.worktrees[context.root];
  if (mapping) {
    return {
      key: mapping.key,
      cwd: context.root,
      repo: {owner: mapping.owner, repo: mapping.repo},
      prUrl: mapping.url,
    };
  }

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

async function getOrRefreshEntry(
  pi: ExtensionAPI,
  target: PullRequestTarget,
  cacheDir: string,
  force: boolean,
): Promise<CacheEntry | undefined> {
  const now = Date.now();
  const cache = await readCache(cacheDir);
  const cachedEntry = cache.entries[target.key];
  if (!force && cachedEntry && cachedEntry.expiresAt > now) return cachedEntry;

  const releaseLock = await acquireCacheLock(cacheDir, target.key, now);
  if (!releaseLock) {
    const latest = (await readCache(cacheDir)).entries[target.key];
    return latest ?? cachedEntry;
  }

  try {
    const latest = await readCache(cacheDir);
    const latestEntry = latest.entries[target.key];
    if (!force && latestEntry && latestEntry.expiresAt > Date.now()) {
      return latestEntry;
    }

    const {entry, preservePreviousOnError} = await runGhPrView(pi, target);
    if (preservePreviousOnError && latestEntry?.kind === 'found')
      return latestEntry;

    await updateCache(cacheDir, cache => {
      cache.entries[target.key] = entry;
    });
    return entry;
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

export function formatFooterStatus(entry: FoundCacheEntry): string {
  const state = entry.pr.isDraft ? 'draft' : entry.pr.state.toLowerCase();
  return [
    `PR #${entry.pr.number}`,
    state,
    summarizeReviewRequests(entry.pr.reviewRequests),
    summarizeChecks(entry.pr.statusCheckRollup),
    entry.pr.url,
  ].join(' · ');
}

async function refreshCurrentStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: {force?: boolean; notify?: boolean} = {},
): Promise<RefreshResult> {
  const cacheDir = getCacheDir();
  const target = await resolveCurrentTarget(pi, ctx.cwd, cacheDir);

  if (!target) {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    return {message: 'No PR-capable git worktree detected.'};
  }

  const entry = await getOrRefreshEntry(
    pi,
    target,
    cacheDir,
    Boolean(options.force),
  );
  if (entry?.kind === 'found') {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(entry));
    return {entry, message: 'PR status refreshed.'};
  }

  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  return {
    entry,
    message: entry?.message ?? 'PR status refresh is already in progress.',
  };
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

async function handlePrRefresh(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const result = await refreshCurrentStatus(pi, ctx, {
    force: true,
    notify: true,
  });
  if (!ctx.hasUI) return;

  if (result.entry?.kind === 'found') {
    ctx.ui.notify('PR status refreshed.', 'info');
  } else {
    ctx.ui.notify(
      result.message,
      result.entry?.kind === 'error' ? 'error' : 'info',
    );
  }
}

async function handlePrWorktree(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const result = await createPullRequestWorktree(pi, ctx.cwd, args.trim());
    const verb = result.created ? 'Created' : 'Using existing';
    const nextCommand = `cd ${shellQuote(result.worktreePath)} && pi`;
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
  let refreshTimer: NodeJS.Timeout | undefined;

  pi.registerCommand('pr-refresh', {
    description:
      'Force-refresh the current worktree PR footer status using gh.',
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

    void refreshCurrentStatus(pi, ctx);
    refreshTimer = setInterval(() => {
      void refreshCurrentStatus(pi, ctx);
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
