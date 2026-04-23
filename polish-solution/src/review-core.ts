import path from 'node:path';
import {formatSize} from '@mariozechner/pi-coding-agent';

export type ReviewStatus = 'needs-attention' | 'approve';
export type ReviewConfidence = 'low' | 'medium' | 'high';

export type ReviewFinding = {
  title: string;
  body: string;
  file: string;
  line_start: number;
  line_end: number;
  confidence: ReviewConfidence;
  recommendation: string;
};

export type ReviewResult = {
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
};

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
    } satisfies ReviewFinding;
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
