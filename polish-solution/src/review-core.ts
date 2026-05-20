import path from 'node:path';
import {formatSize} from '@mariozechner/pi-coding-agent';

export type ReviewStatus = 'needs-attention' | 'approve';
export type ReviewConfidence = 'low' | 'medium' | 'high';

export const REVIEW_CATEGORY_ORDER = [
  'adversarial',
  'simplify',
  'standardize',
  'prune',
  'dry',
] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORY_ORDER)[number];

export type ReviewCategoryConfig = {
  category: ReviewCategory;
  label: string;
  objective: string;
};

export const REVIEW_CATEGORY_CONFIGS: readonly ReviewCategoryConfig[] = [
  {
    category: 'adversarial',
    label: 'Adversarial Review',
    objective:
      'Find material correctness, robustness, design, safety, and edge-case risks. Prioritize dangerous or expensive failures and report only material blocking risks.',
  },
  {
    category: 'simplify',
    label: 'Simplify Review',
    objective:
      'Catch avoidable complexity that makes the change harder to reason about or maintain. Look for unnecessary abstractions, moving parts, or state/control-flow complexity.',
  },
  {
    category: 'standardize',
    label: 'Standardize Review',
    objective:
      'Catch deviations from existing repository or package conventions. Prefer nearby patterns, established helpers, validation conventions, error shapes, and extension APIs.',
  },
  {
    category: 'prune',
    label: 'Prune Review',
    objective:
      'Catch dead, redundant, or no-longer-needed code, data, comments, documentation, compatibility shims, generated artifacts, or branches produced by the change.',
  },
  {
    category: 'dry',
    label: 'DRY Review',
    objective:
      'Catch duplicated logic where divergence would create bugs or maintenance risk, especially repeated prompts, schemas, result mapping, error handling, validation, orchestration, or artifact plumbing.',
  },
];

export type ReviewerFindingInput = {
  title: string;
  body: string;
  file: string;
  line_start: number;
  line_end: number;
  confidence: ReviewConfidence;
  recommendation: string;
};

export type ReviewFinding = ReviewerFindingInput & {
  id: string;
  category: ReviewCategory;
  conflicts_with?: string[];
};

export type ChildReviewResult = {
  status: ReviewStatus;
  summary: string;
  findings: ReviewerFindingInput[];
};

export type ReviewUsage = {
  model?: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export type ReviewMeta = {
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  elapsed: string;
  usage: ReviewUsage;
};

export type CategoryReviewResult = {
  category: ReviewCategory;
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
  meta: ReviewMeta;
};

export type ConflictResolution =
  | 'prefer-adversarial'
  | 'prefer-standardize'
  | 'prefer-prune'
  | 'prefer-simplify'
  | 'prefer-dry'
  | 'needs-user-direction';

export type ReviewConflict = {
  finding_ids: [string, string];
  summary: string;
  resolution: ConflictResolution;
  preferred_finding_id?: string;
  rationale: string;
};

export type ReviewSuiteResult = {
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
  category_results: CategoryReviewResult[];
  conflicts: ReviewConflict[];
  meta: ReviewMeta;
};

export type ReviewerToolInspectionState = {
  statusInspected: boolean;
  fullDiffInspected: boolean;
};

export type ReviewResult = ChildReviewResult;

export type LineRange = {
  start: number;
  end: number;
};

export type ChangedFileValidation = {
  ranges: LineRange[];
  enforceLineValidation: boolean;
};

export type ReviewScope = {
  repoRoot: string;
  branch: string;
  baseRef: string;
  mergeBase: string;
  snapshotTree: string;
  snapshotTempDir: string;
  snapshotEnv: NodeJS.ProcessEnv;
  diff: string;
  diffBytes: number;
  diffLines: number;
  changedFiles: string[];
  untrackedFiles: string[];
  changedFileDetails: Record<string, ChangedFileValidation>;
};

export type OutputBudget = {
  maxBytes: number;
  maxLines: number;
};

export type TextAccumulator = {
  bytes: number;
  newlineCount: number;
  hasContent: boolean;
  endsWithNewline: boolean;
};

export type ReviewSubmitInput = ReviewResult;

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function countNewlines(value: string): number {
  let total = 0;
  for (const char of value) {
    if (char === '\n') total += 1;
  }
  return total;
}

export function createTextAccumulator(): TextAccumulator {
  return {
    bytes: 0,
    newlineCount: 0,
    hasContent: false,
    endsWithNewline: false,
  };
}

export function appendTextAccumulator(
  accumulator: TextAccumulator,
  text: string,
): void {
  if (!text) return;
  accumulator.bytes += Buffer.byteLength(text, 'utf8');
  accumulator.newlineCount += countNewlines(text);
  accumulator.hasContent = true;
  accumulator.endsWithNewline = text.endsWith('\n');
}

export function getAccumulatedLineCount(accumulator: TextAccumulator): number {
  if (!accumulator.hasContent) return 0;
  return accumulator.newlineCount + (accumulator.endsWithNewline ? 0 : 1);
}

export function createDiffTooLargeError(
  bytes: number,
  lines: number,
  options?: {exact?: boolean},
): Error {
  const qualifier = options?.exact ? '' : 'at least ';
  return new Error(
    `polish_solution_review did not run because the current diff is too large for one reviewer pass (${qualifier}${lines} lines, ${formatSize(bytes)}). Narrow the change set or choose a different baseRef.`,
  );
}

export function createUntrackedFileBudgetError(
  filePath: string,
  rawSizeBytes: number,
  remainingBudget: OutputBudget,
): Error {
  return new Error(
    `polish_solution_review did not run because the current diff is too large for one reviewer pass (untracked file "${filePath}" is ${formatSize(rawSizeBytes)} before diff encoding, exceeding the remaining byte budget of ${formatSize(Math.max(0, remainingBudget.maxBytes))}). Narrow the change set or choose a different baseRef.`,
  );
}

export function createToolOutputTooLargeError(
  toolName: string,
  bytes: number,
  lines: number,
): Error {
  return new Error(
    `${toolName} output is too large to inspect safely (${lines} lines, ${formatSize(bytes)}). Narrow the request and retry.`,
  );
}

export function sanitizeArtifactPathSegment(
  value: string,
  fallback: string,
): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return sanitized || fallback;
}

export function isSameOrNestedPath(
  parentPath: string,
  candidatePath: string,
): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function toRepoRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function buildPackageSelfReviewBlockConfig(options: {
  repoRoot: string;
  packageRoot: string;
}): {paths: Set<string>; prefixes: string[]} | undefined {
  if (!isSameOrNestedPath(options.repoRoot, options.packageRoot)) {
    return undefined;
  }

  const relativePackageRoot = toRepoRelativePath(
    path.relative(options.repoRoot, options.packageRoot),
  );
  const packageRootPrefix = relativePackageRoot
    ? `${relativePackageRoot}/`
    : '';

  return {
    paths: new Set<string>([`${packageRootPrefix}package.json`]),
    prefixes: [`${packageRootPrefix}src/`, `${packageRootPrefix}skills/`],
  };
}

export function normalizeRepoPath(
  rawPath: string | undefined,
  repoRoot: string,
): string | undefined {
  const trimmed = rawPath?.trim();
  if (!trimmed) return undefined;

  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(repoRoot, trimmed);
  const relativePath = path
    .relative(repoRoot, absolutePath)
    .replace(/\\/g, '/');

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Path is outside the repository root: ${rawPath}`);
  }

  return relativePath === '' || relativePath === '.' ? undefined : relativePath;
}

export function getRemainingBudget(
  budget: OutputBudget,
  accumulator: TextAccumulator,
  options?: {reserveBytes?: number; reserveLines?: number},
): OutputBudget {
  return {
    maxBytes:
      budget.maxBytes - accumulator.bytes - (options?.reserveBytes ?? 0),
    maxLines:
      budget.maxLines -
      getAccumulatedLineCount(accumulator) -
      (options?.reserveLines ?? 0),
  };
}

export function appendScopedDiffPart(
  currentDiff: string,
  nextDiff: string,
  accumulator: TextAccumulator,
  budget?: OutputBudget,
): string {
  if (!nextDiff) return currentDiff;

  const needsSeparator =
    currentDiff.length > 0 &&
    !currentDiff.endsWith('\n') &&
    !nextDiff.startsWith('\n');
  const textToAppend = needsSeparator ? `\n${nextDiff}` : nextDiff;
  appendTextAccumulator(accumulator, textToAppend);

  if (budget) {
    const diffLines = getAccumulatedLineCount(accumulator);
    if (accumulator.bytes > budget.maxBytes || diffLines > budget.maxLines) {
      throw createDiffTooLargeError(accumulator.bytes, diffLines, {
        exact: true,
      });
    }
  }

  return currentDiff + textToAppend;
}

export function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }

    index += 1;
    if (index >= value.length) {
      bytes.push('\\'.charCodeAt(0));
      break;
    }

    const escaped = value[index];
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (
        index + 1 < value.length &&
        octal.length < 3 &&
        /[0-7]/.test(value[index + 1])
      ) {
        index += 1;
        octal += value[index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    switch (escaped) {
      case 'a':
        bytes.push(0x07);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'v':
        bytes.push(0x0b);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case '\\':
        bytes.push(0x5c);
        break;
      default:
        bytes.push(...Buffer.from(escaped));
        break;
    }
  }

  return Buffer.from(bytes).toString('utf8');
}

export function normalizeGitDiffPath(
  rawPath: string | undefined,
): string | undefined {
  const trimmed = rawPath?.trim();
  if (!trimmed) return undefined;

  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? decodeGitQuotedPath(trimmed.slice(1, -1))
      : trimmed;
  if (unquoted === '/dev/null') return unquoted;
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) {
    return unquoted.slice(2);
  }
  return unquoted;
}

function readGitPathToken(
  value: string,
  startIndex: number,
): {token: string; nextIndex: number} | undefined {
  if (startIndex >= value.length) return undefined;

  if (value[startIndex] !== '"') {
    const nextSpace = value.indexOf(' ', startIndex);
    const endIndex = nextSpace === -1 ? value.length : nextSpace;
    return {
      token: value.slice(startIndex, endIndex),
      nextIndex: endIndex,
    };
  }

  let index = startIndex + 1;
  while (index < value.length) {
    const char = value[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') {
      return {
        token: value.slice(startIndex, index + 1),
        nextIndex: index + 1,
      };
    }
    index += 1;
  }

  return undefined;
}

export function parseDiffHeaderPaths(line: string): {
  oldPath?: string;
  newPath?: string;
} {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return {};

  const oldToken = readGitPathToken(line, prefix.length);
  if (!oldToken || line[oldToken.nextIndex] !== ' ') return {};

  const newToken = readGitPathToken(line, oldToken.nextIndex + 1);
  if (!newToken) return {};

  return {
    oldPath: normalizeGitDiffPath(oldToken.token),
    newPath: normalizeGitDiffPath(newToken.token),
  };
}

export function parseNewHunkRange(line: string): LineRange | undefined {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return undefined;

  const start = Number(match[1]);
  const count = match[2] ? Number(match[2]) : 1;
  if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0) {
    return undefined;
  }

  if (count === 0) {
    const anchor = Math.max(1, start);
    return {
      start: anchor,
      end: anchor,
    };
  }

  return {
    start,
    end: start + count - 1,
  };
}

export function buildChangedFileDetails(
  diff: string,
): Record<string, ChangedFileValidation> {
  const details: Record<string, ChangedFileValidation> = {};
  let headerPaths: {oldPath?: string; newPath?: string} = {};
  let currentFile: string | undefined;
  let currentFileDeleted = false;

  const ensureDetail = (filePath: string): ChangedFileValidation => {
    details[filePath] ??= {
      ranges: [],
      enforceLineValidation: false,
    };
    return details[filePath];
  };

  for (const line of normalizeNewlines(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      headerPaths = parseDiffHeaderPaths(line);
      currentFile = headerPaths.newPath ?? headerPaths.oldPath;
      currentFileDeleted = false;
      if (currentFile) ensureDetail(currentFile);
      continue;
    }

    if (line.startsWith('+++ ')) {
      const nextPath = normalizeGitDiffPath(line.slice(4));
      if (nextPath && nextPath !== '/dev/null') {
        currentFile = nextPath;
        currentFileDeleted = false;
        ensureDetail(currentFile);
      } else {
        currentFile = headerPaths.oldPath;
        currentFileDeleted = true;
        if (currentFile) {
          ensureDetail(currentFile).enforceLineValidation = false;
        }
      }
      continue;
    }

    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      if (currentFile) ensureDetail(currentFile).enforceLineValidation = false;
      continue;
    }

    if (!line.startsWith('@@ ') || !currentFile || currentFileDeleted) continue;

    const range = parseNewHunkRange(line);
    if (!range) continue;

    const detail = ensureDetail(currentFile);
    detail.ranges.push(range);
    detail.enforceLineValidation = true;
  }

  return details;
}

export function rangesIntersect(
  ranges: LineRange[],
  start: number,
  end: number,
): boolean {
  return ranges.some(range => start <= range.end && end >= range.start);
}

export function validateReviewerSubmitReadiness(
  state: ReviewerToolInspectionState,
): void {
  if (!state.statusInspected) {
    throw new Error(
      'submit_review requires inspecting the fixed review scope with git_status first.',
    );
  }
  if (!state.fullDiffInspected) {
    throw new Error(
      'submit_review requires inspecting the full fixed diff with an unscoped git_diff call first.',
    );
  }
}

export function getRemainingCategoryBudgetMs(
  startedAtMs: number,
  nowMs: number,
  timeoutMs: number,
): number {
  return timeoutMs - Math.max(0, nowMs - startedAtMs);
}

export function buildCategoryReviewerFailureMessage(
  category: ReviewCategory,
  message: string,
): string {
  if (message.startsWith(`${category} review`)) return message;
  return `${category} review failed: ${message}`;
}

export function formatReviewFindingId(
  category: ReviewCategory,
  ordinal: number,
): string {
  return `${category}-${String(ordinal).padStart(2, '0')}`;
}

function cloneReviewFinding(finding: ReviewFinding): ReviewFinding {
  return {
    ...finding,
    conflicts_with: finding.conflicts_with
      ? [...finding.conflicts_with]
      : undefined,
  };
}

function cloneCategoryReviewResult(
  result: CategoryReviewResult,
): CategoryReviewResult {
  return {
    ...result,
    findings: result.findings.map(cloneReviewFinding),
  };
}

export function buildCategoryReviewResult(
  category: ReviewCategory,
  review: ChildReviewResult,
  meta: ReviewMeta,
): CategoryReviewResult {
  return {
    category,
    status: review.status,
    summary: review.summary,
    findings: review.findings.map((finding, index) => {
      return {
        ...finding,
        id: formatReviewFindingId(category, index + 1),
        category,
      };
    }),
    meta,
  };
}

type OpposingActionPair = 'remove-keep' | 'remove-extract' | 'inline-extract';

type DetectedOpposingActionPair = {
  pair: OpposingActionPair;
  leftAction: string;
  rightAction: string;
};

const REMOVE_ACTION_PATTERN = /\b(?:remove|delete|drop|prune)\b/i;
const KEEP_ACTION_PATTERN = /\b(?:keep|retain|preserve)\b/i;
const EXTRACT_ACTION_PATTERN = /\b(?:extract|share|abstract|dedupe)\b/i;
const INLINE_ACTION_PATTERN = /\b(?:inline|simplify)\b/i;

function textMatches(pattern: RegExp, value: string): boolean {
  return pattern.test(value);
}

function detectOpposingActionPair(
  left: ReviewFinding,
  right: ReviewFinding,
): DetectedOpposingActionPair | undefined {
  const leftText = `${left.title} ${left.recommendation}`;
  const rightText = `${right.title} ${right.recommendation}`;
  const leftRemove = textMatches(REMOVE_ACTION_PATTERN, leftText);
  const rightRemove = textMatches(REMOVE_ACTION_PATTERN, rightText);
  const leftKeep = textMatches(KEEP_ACTION_PATTERN, leftText);
  const rightKeep = textMatches(KEEP_ACTION_PATTERN, rightText);
  const leftExtract = textMatches(EXTRACT_ACTION_PATTERN, leftText);
  const rightExtract = textMatches(EXTRACT_ACTION_PATTERN, rightText);
  const leftInline = textMatches(INLINE_ACTION_PATTERN, leftText);
  const rightInline = textMatches(INLINE_ACTION_PATTERN, rightText);

  if (leftRemove && rightKeep) {
    return {pair: 'remove-keep', leftAction: 'remove', rightAction: 'keep'};
  }
  if (leftKeep && rightRemove) {
    return {pair: 'remove-keep', leftAction: 'keep', rightAction: 'remove'};
  }
  if (leftRemove && rightExtract) {
    return {
      pair: 'remove-extract',
      leftAction: 'remove',
      rightAction: 'extract',
    };
  }
  if (leftExtract && rightRemove) {
    return {
      pair: 'remove-extract',
      leftAction: 'extract',
      rightAction: 'remove',
    };
  }
  if (leftInline && rightExtract) {
    return {
      pair: 'inline-extract',
      leftAction: 'inline',
      rightAction: 'extract',
    };
  }
  if (leftExtract && rightInline) {
    return {
      pair: 'inline-extract',
      leftAction: 'extract',
      rightAction: 'inline',
    };
  }

  return undefined;
}

function resolveReviewConflict(
  left: ReviewFinding,
  right: ReviewFinding,
  actionPair: DetectedOpposingActionPair,
): Pick<ReviewConflict, 'resolution' | 'preferred_finding_id' | 'rationale'> {
  if (left.category === 'adversarial' || right.category === 'adversarial') {
    const preferred = left.category === 'adversarial' ? left : right;
    return {
      resolution: 'prefer-adversarial',
      preferred_finding_id: preferred.id,
      rationale:
        'Adversarial findings take priority over non-adversarial category conflicts in the first-slice resolver.',
    };
  }

  if (
    (left.category === 'standardize' &&
      (right.category === 'simplify' || right.category === 'dry')) ||
    (right.category === 'standardize' &&
      (left.category === 'simplify' || left.category === 'dry'))
  ) {
    const preferred = left.category === 'standardize' ? left : right;
    return {
      resolution: 'prefer-standardize',
      preferred_finding_id: preferred.id,
      rationale:
        'Repository/package convention findings take priority over simplify or DRY conflicts in the first-slice resolver.',
    };
  }

  if (
    actionPair.pair === 'remove-extract' &&
    ((left.category === 'prune' && right.category === 'dry') ||
      (right.category === 'prune' && left.category === 'dry'))
  ) {
    const preferred = left.category === 'prune' ? left : right;
    return {
      resolution: 'prefer-prune',
      preferred_finding_id: preferred.id,
      rationale:
        'Prune findings take priority over DRY extraction when the explicit conflict is remove/delete/drop/prune versus extract/share/abstract/dedupe.',
    };
  }

  if (
    actionPair.pair === 'inline-extract' &&
    ((left.category === 'simplify' && right.category === 'dry') ||
      (right.category === 'simplify' && left.category === 'dry'))
  ) {
    const preferred = left.category === 'simplify' ? left : right;
    return {
      resolution: 'prefer-simplify',
      preferred_finding_id: preferred.id,
      rationale:
        'Simplify findings take priority over DRY extraction when the explicit conflict is inline/simplify versus extract/share/abstract/dedupe.',
    };
  }

  return {
    resolution: 'needs-user-direction',
    rationale:
      'The first-slice resolver detected an explicit opposing action pair but no deterministic priority rule applies.',
  };
}

function addConflictReference(
  finding: ReviewFinding,
  conflictId: string,
): void {
  finding.conflicts_with ??= [];
  if (!finding.conflicts_with.includes(conflictId)) {
    finding.conflicts_with.push(conflictId);
  }
}

export function analyzeReviewConflicts(
  categoryResults: CategoryReviewResult[],
): {categoryResults: CategoryReviewResult[]; conflicts: ReviewConflict[]} {
  const clonedCategoryResults = categoryResults.map(cloneCategoryReviewResult);
  const findings = clonedCategoryResults.flatMap(result => result.findings);
  const findingsById = new Map(findings.map(finding => [finding.id, finding]));
  const conflicts: ReviewConflict[] = [];

  for (let leftIndex = 0; leftIndex < findings.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < findings.length;
      rightIndex += 1
    ) {
      const left = findings[leftIndex];
      const right = findings[rightIndex];
      if (left.category === right.category) continue;
      if (left.file !== right.file) continue;
      if (
        !(
          left.line_start <= right.line_end && left.line_end >= right.line_start
        )
      ) {
        continue;
      }

      const actionPair = detectOpposingActionPair(left, right);
      if (!actionPair) continue;

      const conflictResolution = resolveReviewConflict(left, right, actionPair);
      conflicts.push({
        finding_ids: [left.id, right.id],
        summary: `${left.id} (${actionPair.leftAction}) conflicts with ${right.id} (${actionPair.rightAction}) on ${left.file}:${Math.max(left.line_start, right.line_start)}-${Math.min(left.line_end, right.line_end)}.`,
        ...conflictResolution,
      });
      addConflictReference(findingsById.get(left.id) ?? left, right.id);
      addConflictReference(findingsById.get(right.id) ?? right, left.id);
    }
  }

  return {categoryResults: clonedCategoryResults, conflicts};
}

function buildReviewSuiteSummary(
  categoryResults: CategoryReviewResult[],
  conflicts: ReviewConflict[],
): string {
  const findingCount = categoryResults.reduce((total, result) => {
    return total + result.findings.length;
  }, 0);
  const unresolvedConflictCount = conflicts.filter(conflict => {
    return conflict.resolution === 'needs-user-direction';
  }).length;

  const categoryText = `${categoryResults.length} review categor${categoryResults.length === 1 ? 'y' : 'ies'}`;
  if (unresolvedConflictCount > 0) {
    return `${findingCount} finding${findingCount === 1 ? '' : 's'} across ${categoryText}; user direction is needed for ${unresolvedConflictCount} unresolved conflict${unresolvedConflictCount === 1 ? '' : 's'}.`;
  }
  if (findingCount > 0 || conflicts.length > 0) {
    const conflictText = conflicts.length
      ? ` with ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`
      : '';
    return `${findingCount} finding${findingCount === 1 ? '' : 's'} across ${categoryText}${conflictText}.`;
  }
  return `All ${categoryText} approved with no findings.`;
}

export type CategorySessionBase = {
  category: ReviewCategory;
  review: ChildReviewResult;
  meta: ReviewMeta;
};

export type CategoryRunContext = {
  ordinal: number;
  totalCategories: number;
};

export type CategorySequenceEvent =
  | ({
      type: 'category-started';
      categoryConfig: ReviewCategoryConfig;
    } & CategoryRunContext)
  | ({
      type: 'category-finished';
      categoryConfig: ReviewCategoryConfig;
      status: 'success';
      result: CategoryReviewResult;
    } & CategoryRunContext)
  | ({
      type: 'category-finished';
      categoryConfig: ReviewCategoryConfig;
      status: 'error';
      error: unknown;
      completedCategoryResults: CategoryReviewResult[];
    } & CategoryRunContext)
  | {
      type: 'conflict-analysis';
      categoryResults: CategoryReviewResult[];
      conflicts: ReviewConflict[];
    };

export type CategorySequenceResult<TSession extends CategorySessionBase> = {
  sessionResults: TSession[];
  categoryResults: CategoryReviewResult[];
  conflicts: ReviewConflict[];
};

export type CategorySequenceError = Error & {
  failedCategory?: ReviewCategory;
  categoryResults?: CategoryReviewResult[];
  sessionResults?: CategorySessionBase[];
};

export async function runCategoryReviewSequence<
  TSession extends CategorySessionBase,
>(
  categoryConfigs: readonly ReviewCategoryConfig[],
  runCategory: (
    categoryConfig: ReviewCategoryConfig,
    context: CategoryRunContext,
  ) => Promise<TSession>,
  onEvent?: (event: CategorySequenceEvent) => void,
): Promise<CategorySequenceResult<TSession>> {
  const categoryResults: CategoryReviewResult[] = [];
  const sessionResults: TSession[] = [];

  for (const [index, categoryConfig] of categoryConfigs.entries()) {
    const context = {
      ordinal: index + 1,
      totalCategories: categoryConfigs.length,
    };
    onEvent?.({type: 'category-started', categoryConfig, ...context});

    let sessionResult: TSession;
    try {
      sessionResult = await runCategory(categoryConfig, context);
    } catch (error) {
      onEvent?.({
        type: 'category-finished',
        categoryConfig,
        ...context,
        status: 'error',
        error,
        completedCategoryResults: categoryResults,
      });
      const sequenceError =
        error instanceof Error
          ? (error as CategorySequenceError)
          : (new Error(String(error)) as CategorySequenceError);
      sequenceError.failedCategory = categoryConfig.category;
      sequenceError.categoryResults = categoryResults;
      sequenceError.sessionResults = sessionResults;
      throw sequenceError;
    }

    sessionResults.push(sessionResult);
    const categoryResult = buildCategoryReviewResult(
      sessionResult.category,
      sessionResult.review,
      sessionResult.meta,
    );
    categoryResults.push(categoryResult);
    onEvent?.({
      type: 'category-finished',
      categoryConfig,
      ...context,
      status: 'success',
      result: categoryResult,
    });
  }

  const conflictAnalysis = analyzeReviewConflicts(categoryResults);
  onEvent?.({
    type: 'conflict-analysis',
    categoryResults: conflictAnalysis.categoryResults,
    conflicts: conflictAnalysis.conflicts,
  });

  return {
    sessionResults,
    categoryResults: conflictAnalysis.categoryResults,
    conflicts: conflictAnalysis.conflicts,
  };
}

export function buildReviewSuiteResult(
  categoryResults: CategoryReviewResult[],
  meta: ReviewMeta,
  conflicts: ReviewConflict[] = [],
): ReviewSuiteResult {
  const findings = categoryResults.flatMap(result => result.findings);
  const status: ReviewStatus =
    categoryResults.every(result => result.status === 'approve') &&
    conflicts.length === 0
      ? 'approve'
      : 'needs-attention';

  return {
    status,
    summary: buildReviewSuiteSummary(categoryResults, conflicts),
    findings,
    category_results: categoryResults,
    conflicts,
    meta,
  };
}

export function validateReviewResult(
  input: ReviewSubmitInput,
  scope: ReviewScope,
): ReviewResult {
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error('summary must not be empty');
  }

  const changedFileSet = new Set(scope.changedFiles);
  const findings = input.findings.map(finding => {
    const title = finding.title.trim();
    const body = finding.body.trim();
    const file = finding.file.trim();
    const recommendation = finding.recommendation.trim();

    if (!title) throw new Error('finding.title must not be empty');
    if (!body) throw new Error('finding.body must not be empty');
    if (!file) throw new Error('finding.file must not be empty');
    if (!recommendation) {
      throw new Error('finding.recommendation must not be empty');
    }
    if (finding.line_end < finding.line_start) {
      throw new Error(
        'finding.line_end must be greater than or equal to finding.line_start',
      );
    }
    if (!changedFileSet.has(file)) {
      throw new Error(`finding.file must reference a changed file: ${file}`);
    }

    const fileDetails = scope.changedFileDetails[file];
    if (
      fileDetails?.enforceLineValidation &&
      !rangesIntersect(fileDetails.ranges, finding.line_start, finding.line_end)
    ) {
      throw new Error(
        `finding line range must intersect a changed hunk in ${file}`,
      );
    }

    return {
      title,
      body,
      file,
      line_start: finding.line_start,
      line_end: finding.line_end,
      confidence: finding.confidence,
      recommendation,
    } satisfies ReviewerFindingInput;
  });

  if (input.status === 'approve' && findings.length > 0) {
    throw new Error('status "approve" must have no findings');
  }
  if (input.status === 'needs-attention' && findings.length === 0) {
    throw new Error(
      'status "needs-attention" must include at least one finding',
    );
  }

  return {
    status: input.status,
    summary,
    findings,
  };
}
