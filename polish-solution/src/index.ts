import {spawn} from 'node:child_process';
import path from 'node:path';
import {StringEnum} from '@mariozechner/pi-ai';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createReadOnlyTools,
  formatSize,
  getAgentDir,
  truncateHead,
  type ExtensionAPI,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import {Type, type Static} from '@sinclair/typebox';

type ReviewStatus = 'needs-attention' | 'approve';
type ReviewConfidence = 'low' | 'medium' | 'high';

type ReviewFinding = {
  title: string;
  body: string;
  file: string;
  line_start: number;
  line_end: number;
  confidence: ReviewConfidence;
  recommendation: string;
};

type ReviewResult = {
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
};

type ReviewScope = {
  repoRoot: string;
  branch: string;
  baseRef: string;
  mergeBase: string;
  diff: string;
  changedFiles: string[];
  untrackedFiles: string[];
};

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

const REVIEW_TOOL_PARAMS = Type.Object({
  baseRef: Type.Optional(
    Type.String({
      description:
        'Optional git base ref to diff against. Defaults to origin/main when available, otherwise main.',
    }),
  ),
});

const REVIEW_STATUS_ENUM = StringEnum(['needs-attention', 'approve'] as const, {
  description: 'Review status.',
});
const REVIEW_CONFIDENCE_ENUM = StringEnum(['low', 'medium', 'high'] as const, {
  description: 'Finding confidence.',
});

const REVIEW_FINDING_SCHEMA = Type.Object({
  title: Type.String({description: 'Short finding title.'}),
  body: Type.String({description: 'Why this is a material risk.'}),
  file: Type.String({description: 'Repo-relative file path.'}),
  line_start: Type.Integer({minimum: 1}),
  line_end: Type.Integer({minimum: 1}),
  confidence: REVIEW_CONFIDENCE_ENUM,
  recommendation: Type.String({description: 'Concrete remediation guidance.'}),
});

const SUBMIT_REVIEW_SCHEMA = Type.Object({
  status: REVIEW_STATUS_ENUM,
  summary: Type.String({description: 'One concise overall review summary.'}),
  findings: Type.Array(REVIEW_FINDING_SCHEMA),
});

const EMPTY_SCHEMA = Type.Object({});
const GIT_DIFF_SCHEMA = Type.Object({
  path: Type.Optional(
    Type.String({
      description: 'Optional repo-relative path to narrow the diff.',
    }),
  ),
});

const DEFAULT_THINKING_LEVEL = 'low' as const;
const MAX_REPAIR_ATTEMPTS = 3;
const MAX_AGENT_EXECUTION_MS = 600_000;
const MAX_DIFF_BYTES = 120_000;
const MAX_DIFF_LINES = 3_500;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const STATUS_KEY = 'polish-solution-review';
const HEARTBEAT_INTERVAL_MS = 2_000;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const REVIEWER_SYSTEM_PROMPT = `You are an adversarial code reviewer.
Default to skepticism. Try to disprove the change rather than validate it.
Prioritize expensive, dangerous, hard-to-detect failures.
Report only material findings that would materially impact design, robustness, or correctness.
Out of scope: tests, test coverage, lint-only concerns, docs-only concerns, monitoring, rollout chores, or other external supports. If the only plausible concerns are out-of-scope items such as tests or other external supports, approve with no findings.
Ground every finding in the provided diff and any repository context you inspect with tools.
Prefer one strong finding over several weak ones.
Use the available read-only tools when needed.
When you are ready, call submit_review with this exact JSON shape:
{
  "status": "needs-attention" | "approve",
  "summary": string,
  "findings": [
    {
      "title": string,
      "body": string,
      "file": string,
      "line_start": number,
      "line_end": number,
      "confidence": "low" | "medium" | "high",
      "recommendation": string
    }
  ]
}
Rules:
- Use status "needs-attention" when any material blocking risk exists.
- Use status "approve" when no substantive adversarial finding can be supported.
- findings must be empty when status is "approve".
- findings must be non-empty when status is "needs-attention".
- Keep file paths repo-relative.
- Use the most relevant file and line range for each finding.
- Do not output markdown or extra prose outside submit_review.
- The only valid completion path is submit_review. After submit_review succeeds, stop immediately.`;

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  return normalizeNewlines(value).split('\n').length;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatBulletList(items: string[]): string {
  if (items.length === 0) return '- (none)';
  return items.map(item => `- ${item}`).join('\n');
}

function formatToolOutput(content: string, hint?: string): string {
  const truncation = truncateHead(content, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  let text = truncation.content || '(empty)';
  if (truncation.truncated) {
    const extra = [
      `truncated to ${truncation.outputLines} of ${truncation.totalLines} lines`,
      `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})`,
    ];
    if (hint) extra.push(hint);
    text += `\n\n[${extra.join('; ')}]`;
  }
  return text;
}

function createProgressReporter(onUpdate: any, ctx: any) {
  let heartbeatId: NodeJS.Timeout | undefined;
  let spinnerIndex = 0;

  const setFooterStatus = (message: string | undefined): void => {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, message);
  };

  const emit = (
    message: string,
    details?: Record<string, unknown>,
    options?: {notify?: boolean},
  ): void => {
    onUpdate?.({
      content: [{type: 'text', text: message}],
      details: {
        phase: 'progress',
        progressMessage: message,
        ...(details ?? {}),
      },
    });
    setFooterStatus(message);
    if (options?.notify && ctx?.hasUI) {
      ctx.ui.notify(message, 'info');
    }
  };

  const stopHeartbeat = (): void => {
    if (heartbeatId !== undefined) {
      clearInterval(heartbeatId);
      heartbeatId = undefined;
    }
  };

  const startHeartbeat = (
    baseMessage: string,
    details?: Record<string, unknown>,
  ): void => {
    stopHeartbeat();
    const startedAt = Date.now();

    const tick = (): void => {
      const elapsedMs = Date.now() - startedAt;
      const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
      spinnerIndex += 1;
      emit(`${frame} ${baseMessage} (${formatElapsed(elapsedMs)})`, {
        ...(details ?? {}),
        phase: 'heartbeat',
        baseMessage,
        elapsedMs,
      });
    };

    tick();
    heartbeatId = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  };

  return {
    update(
      message: string,
      details?: Record<string, unknown>,
      options?: {notify?: boolean},
    ): void {
      stopHeartbeat();
      emit(message, details, options);
    },
    startHeartbeat,
    stopHeartbeat,
    clear(): void {
      stopHeartbeat();
      setFooterStatus(undefined);
    },
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    okExitCodes?: number[];
  },
): Promise<CommandResult> {
  const okExitCodes = options.okExitCodes ?? [0];

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = (): void => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore termination errors from already-exited processes.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore termination errors from already-exited processes.
        }
      }, 5_000);
    };

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, {once: true});
    }

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', error => {
      settle(() => reject(error));
    });
    child.on('close', code => {
      settle(() => {
        if (aborted) {
          reject(new Error('Operation aborted'));
          return;
        }

        const result: CommandResult = {
          stdout: normalizeNewlines(stdout),
          stderr: normalizeNewlines(stderr),
          code: code ?? -1,
        };

        if (okExitCodes.includes(result.code)) {
          resolve(result);
          return;
        }

        reject(
          new Error(
            result.stderr.trim() ||
              `${command} exited with code ${result.code}`,
          ),
        );
      });
    });
  });
}

async function runGit(
  repoRoot: string,
  args: string[],
  signal?: AbortSignal,
  okExitCodes?: number[],
): Promise<CommandResult> {
  return await runCommand('git', args, {cwd: repoRoot, signal, okExitCodes});
}

function normalizeBaseRef(rawBaseRef: string | undefined): string | undefined {
  const normalized = rawBaseRef?.trim();
  return normalized ? normalized : undefined;
}

function normalizeRepoPath(
  rawPath: string | undefined,
  repoRoot: string,
): string | undefined {
  const trimmed = rawPath?.trim();
  if (!trimmed) return undefined;

  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  const absolutePath = path.isAbsolute(withoutAt)
    ? path.resolve(withoutAt)
    : path.resolve(repoRoot, withoutAt);
  const relativePath = path
    .relative(repoRoot, absolutePath)
    .replace(/\\/g, '/');

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Path is outside the repository root: ${rawPath}`);
  }

  return relativePath === '' || relativePath === '.' ? undefined : relativePath;
}

async function getRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await runCommand('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    signal,
  }).catch(() => {
    throw new Error(
      'polish_solution_review requires the current working directory to already be inside a git repository or worktree.',
    );
  });

  return result.stdout.trim();
}

async function resolveBaseRef(
  repoRoot: string,
  requestedBaseRef: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const explicitBaseRef = normalizeBaseRef(requestedBaseRef);
  if (explicitBaseRef) {
    await runGit(
      repoRoot,
      ['rev-parse', '--verify', '--quiet', `${explicitBaseRef}^{commit}`],
      signal,
    ).catch(() => {
      throw new Error(
        `polish_solution_review did not run because the base ref \"${explicitBaseRef}\" could not be resolved to a commit.`,
      );
    });
    return explicitBaseRef;
  }

  for (const candidate of ['origin/main', 'main']) {
    try {
      await runGit(
        repoRoot,
        ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
        signal,
      );
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    'polish_solution_review did not run because neither "origin/main" nor "main" could be resolved.',
  );
}

async function resolveMergeBase(
  repoRoot: string,
  baseRef: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(
    repoRoot,
    ['merge-base', 'HEAD', baseRef],
    signal,
  ).catch(() => {
    throw new Error(
      `polish_solution_review did not run because no merge-base could be found between HEAD and \"${baseRef}\".`,
    );
  });

  const mergeBase = result.stdout.trim();
  if (!mergeBase) {
    throw new Error(
      `polish_solution_review did not run because no merge-base could be found between HEAD and \"${baseRef}\".`,
    );
  }
  return mergeBase;
}

async function getCurrentBranch(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(
    repoRoot,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    signal,
  );
  return result.stdout.trim() || 'HEAD';
}

async function getTrackedChangedFiles(
  repoRoot: string,
  mergeBase: string,
  signal?: AbortSignal,
  pathSpec?: string,
): Promise<string[]> {
  const args = ['diff', '--name-only', mergeBase, '--'];
  if (pathSpec) args.push(pathSpec);
  const result = await runGit(repoRoot, args, signal);
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

async function getTrackedDiff(
  repoRoot: string,
  mergeBase: string,
  signal?: AbortSignal,
  pathSpec?: string,
): Promise<string> {
  const args = [
    'diff',
    '--binary',
    '--find-renames',
    '--no-color',
    '--no-ext-diff',
    '--submodule=diff',
    mergeBase,
    '--',
  ];
  if (pathSpec) args.push(pathSpec);
  const result = await runGit(repoRoot, args, signal);
  return result.stdout.trimEnd();
}

async function getUntrackedFiles(
  repoRoot: string,
  signal?: AbortSignal,
  pathSpec?: string,
): Promise<string[]> {
  const args = ['ls-files', '--others', '--exclude-standard', '--'];
  if (pathSpec) args.push(pathSpec);
  const result = await runGit(repoRoot, args, signal);
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

async function getUntrackedDiff(
  repoRoot: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(
    repoRoot,
    [
      'diff',
      '--no-index',
      '--binary',
      '--no-color',
      '--',
      NULL_DEVICE,
      filePath,
    ],
    signal,
    [0, 1],
  );
  return result.stdout.trimEnd();
}

async function buildScopedDiff(
  repoRoot: string,
  mergeBase: string,
  signal?: AbortSignal,
  pathSpec?: string,
): Promise<{
  diff: string;
  changedFiles: string[];
  untrackedFiles: string[];
}> {
  const trackedChangedFiles = await getTrackedChangedFiles(
    repoRoot,
    mergeBase,
    signal,
    pathSpec,
  );
  const trackedDiff = await getTrackedDiff(
    repoRoot,
    mergeBase,
    signal,
    pathSpec,
  );
  const untrackedFiles = await getUntrackedFiles(repoRoot, signal, pathSpec);

  const diffParts = trackedDiff ? [trackedDiff] : [];
  for (const filePath of untrackedFiles) {
    const untrackedDiff = await getUntrackedDiff(repoRoot, filePath, signal);
    if (untrackedDiff) diffParts.push(untrackedDiff);
  }

  return {
    diff: diffParts.join('\n').trim(),
    changedFiles: uniqueSorted([...trackedChangedFiles, ...untrackedFiles]),
    untrackedFiles: uniqueSorted(untrackedFiles),
  };
}

async function buildReviewScope(
  cwd: string,
  requestedBaseRef: string | undefined,
  signal?: AbortSignal,
  progress?: ReturnType<typeof createProgressReporter>,
): Promise<ReviewScope> {
  progress?.update('🔎 Locating git repository…', {
    phase: 'scope',
    step: 'repo-root',
  });
  const repoRoot = await getRepoRoot(cwd, signal);

  progress?.update('🔎 Resolving review base ref…', {
    phase: 'scope',
    step: 'base-ref',
    repoRoot,
  });
  const baseRef = await resolveBaseRef(repoRoot, requestedBaseRef, signal);

  progress?.update('🔎 Computing merge-base…', {
    phase: 'scope',
    step: 'merge-base',
    repoRoot,
    baseRef,
  });
  const mergeBase = await resolveMergeBase(repoRoot, baseRef, signal);

  progress?.update('🔎 Reading branch and diff scope…', {
    phase: 'scope',
    step: 'branch-and-diff',
    repoRoot,
    baseRef,
    mergeBase,
  });
  const branch = await getCurrentBranch(repoRoot, signal);
  const scopedDiff = await buildScopedDiff(repoRoot, mergeBase, signal);

  if (!scopedDiff.diff) {
    throw new Error(
      `polish_solution_review did not run because there is no diff against merge-base ${mergeBase.slice(0, 12)} from \"${baseRef}\".`,
    );
  }

  const diffBytes = Buffer.byteLength(scopedDiff.diff, 'utf8');
  const diffLines = countLines(scopedDiff.diff);
  if (diffBytes > MAX_DIFF_BYTES || diffLines > MAX_DIFF_LINES) {
    throw new Error(
      `polish_solution_review did not run because the current diff is too large for one reviewer pass (${diffLines} lines, ${formatSize(diffBytes)}). Narrow the change set or choose a different baseRef.`,
    );
  }

  progress?.update(
    `🔎 Review scope ready: ${scopedDiff.changedFiles.length} file(s), ${diffLines} diff line(s).`,
    {
      phase: 'scope-ready',
      repoRoot,
      branch,
      baseRef,
      mergeBase,
      changedFiles: scopedDiff.changedFiles.length,
      untrackedFiles: scopedDiff.untrackedFiles.length,
      diffLines,
      diffBytes,
    },
  );

  return {
    repoRoot,
    branch,
    baseRef,
    mergeBase,
    diff: scopedDiff.diff,
    changedFiles: scopedDiff.changedFiles,
    untrackedFiles: scopedDiff.untrackedFiles,
  };
}

function validateReviewResult(
  input: Static<typeof SUBMIT_REVIEW_SCHEMA>,
): ReviewResult {
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error('summary must not be empty');
  }

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

function buildInitialPrompt(diff: string): string {
  // Intentionally pass only the fixed reviewer instructions plus the raw diff.
  return `Git diff to review:\n\n${diff}`;
}

function buildRepairPrompt(attempt: number): string {
  return [
    `Repair attempt ${attempt}.`,
    'Your previous turn ended without a valid submit_review.',
    'Continue from the current context and call submit_review with schema-valid review JSON.',
    'Do not output plain text.',
  ].join('\n\n');
}

function createReviewerTools(
  scope: ReviewScope,
  submittedReview: {value?: ReviewResult},
): ToolDefinition[] {
  return [
    {
      name: 'git_status',
      label: 'Git Status',
      description:
        'Show the fixed review scope: branch, base ref, merge-base, changed files, and untracked files.',
      promptSnippet:
        'Inspect the fixed git review scope, including changed and untracked files.',
      parameters: EMPTY_SCHEMA,
      async execute() {
        const content = [
          `branch: ${scope.branch}`,
          `baseRef: ${scope.baseRef}`,
          `mergeBase: ${scope.mergeBase}`,
          `changedFiles: ${scope.changedFiles.length}`,
          formatBulletList(scope.changedFiles),
          `untrackedFiles: ${scope.untrackedFiles.length}`,
          formatBulletList(scope.untrackedFiles),
        ].join('\n');

        return {
          content: [{type: 'text', text: formatToolOutput(content)}],
          details: {
            branch: scope.branch,
            baseRef: scope.baseRef,
            mergeBase: scope.mergeBase,
            changedFiles: scope.changedFiles,
            untrackedFiles: scope.untrackedFiles,
          },
        };
      },
    },
    {
      name: 'git_diff',
      label: 'Git Diff',
      description:
        'Show the fixed review diff against the merge-base, optionally narrowed to one repo-relative path.',
      promptSnippet:
        'Inspect the fixed git diff, optionally narrowed to one path.',
      parameters: GIT_DIFF_SCHEMA,
      async execute(
        _toolCallId,
        params: Static<typeof GIT_DIFF_SCHEMA>,
        signal,
      ) {
        const pathSpec = normalizeRepoPath(params.path, scope.repoRoot);
        const scopedDiff = await buildScopedDiff(
          scope.repoRoot,
          scope.mergeBase,
          signal,
          pathSpec,
        );

        if (!scopedDiff.diff) {
          return {
            content: [
              {
                type: 'text',
                text: pathSpec
                  ? `No diff found for ${pathSpec}.`
                  : 'No diff found for the fixed review scope.',
              },
            ],
            details: {
              path: pathSpec,
              changedFiles: scopedDiff.changedFiles,
            },
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: formatToolOutput(
                scopedDiff.diff,
                pathSpec
                  ? 'narrow further or inspect files directly with read'
                  : 'call git_diff with path to narrow the diff',
              ),
            },
          ],
          details: {
            path: pathSpec,
            changedFiles: scopedDiff.changedFiles,
            untrackedFiles: scopedDiff.untrackedFiles,
          },
        };
      },
    },
    {
      name: 'submit_review',
      label: 'Submit Review',
      description:
        'Submit the final structured review. This is the only valid completion path.',
      promptSnippet:
        'Submit the final structured review JSON once the adversarial review is complete.',
      parameters: SUBMIT_REVIEW_SCHEMA,
      async execute(_toolCallId, params: Static<typeof SUBMIT_REVIEW_SCHEMA>) {
        const validated = validateReviewResult(params);
        submittedReview.value = validated;
        return {
          content: [{type: 'text', text: 'submit_review accepted. Stop now.'}],
          details: validated,
        };
      },
    },
  ];
}

async function promptWithTimeout(
  operation: Promise<void>,
  session: Awaited<ReturnType<typeof createAgentSession>>['session'],
  timeoutMs: number,
): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(async () => {
      try {
        await session.abort();
      } catch {
        // Ignore abort failures when timing out.
      }
      reject(
        new Error(`polish_solution_review timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  try {
    await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function runReviewerSession(
  scope: ReviewScope,
  model: any,
  modelRegistry: any,
  thinkingLevel: ReturnType<ExtensionAPI['getThinkingLevel']>,
  progress?: ReturnType<typeof createProgressReporter>,
): Promise<ReviewResult> {
  const submittedReview: {value?: ReviewResult} = {};
  progress?.update('🛠 Preparing isolated reviewer resources…', {
    phase: 'reviewer-setup',
    step: 'resource-loader',
    repoRoot: scope.repoRoot,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: scope.repoRoot,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({agentsFiles: []}),
    systemPromptOverride: () => REVIEWER_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  progress?.update('🛠 Creating isolated reviewer session…', {
    phase: 'reviewer-setup',
    step: 'session-create',
    repoRoot: scope.repoRoot,
  });
  const {session} = await createAgentSession({
    cwd: scope.repoRoot,
    agentDir: getAgentDir(),
    model,
    modelRegistry,
    thinkingLevel: thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    tools: createReadOnlyTools(scope.repoRoot),
    customTools: createReviewerTools(scope, submittedReview),
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: {enabled: false},
      retry: {enabled: true, maxRetries: MAX_REPAIR_ATTEMPTS},
    }),
  });

  try {
    const maxAttempts = MAX_REPAIR_ATTEMPTS + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt =
        attempt === 1
          ? buildInitialPrompt(scope.diff)
          : buildRepairPrompt(attempt - 1);
      progress?.startHeartbeat(
        `Running isolated adversarial reviewer (attempt ${attempt}/${maxAttempts})`,
        {
          phase: 'reviewer-run',
          attempt,
          maxAttempts,
        },
      );
      try {
        await promptWithTimeout(
          session.prompt(prompt),
          session,
          MAX_AGENT_EXECUTION_MS,
        );
      } finally {
        progress?.stopHeartbeat();
      }

      if (submittedReview.value) {
        progress?.update(
          `✅ Reviewer finished with status ${submittedReview.value.status}.`,
          {
            phase: 'review-complete',
            attempt,
            maxAttempts,
            reviewStatus: submittedReview.value.status,
          },
        );
        return submittedReview.value;
      }

      if (attempt < maxAttempts) {
        progress?.update(
          `🔁 Reviewer returned invalid output. Retrying (${attempt + 1}/${maxAttempts})…`,
          {
            phase: 'review-retry',
            attempt: attempt + 1,
            maxAttempts,
          },
        );
      }
    }
  } finally {
    session.dispose();
  }

  throw new Error(
    `polish_solution_review did not receive a valid structured review after ${MAX_REPAIR_ATTEMPTS + 1} attempts.`,
  );
}

export default function polishSolution(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'polish_solution_review',
    label: 'Polish Solution Review',
    description:
      'Run an adversarial review pass on the current git worktree against a main-like base ref and return structured JSON findings.',
    promptSnippet:
      'Run an adversarial review pass on the current git worktree and return structured JSON findings.',
    promptGuidelines: [
      'Use this tool when you want an iterative adversarial review pass over the current change set.',
      'It defaults to origin/main when available, otherwise main, and it reviews the full current worktree state including non-ignored untracked files.',
      'Rerun it after each substantial remediation pass until it approves or you need user direction.',
    ],
    parameters: REVIEW_TOOL_PARAMS,
    async execute(
      _toolCallId,
      params: Static<typeof REVIEW_TOOL_PARAMS>,
      signal,
      onUpdate,
      ctx,
    ) {
      const progress = createProgressReporter(onUpdate, ctx);

      try {
        progress.update(
          '🚀 Starting adversarial review…',
          {
            phase: 'start',
            timeoutMs: MAX_AGENT_EXECUTION_MS,
          },
          {notify: true},
        );

        const currentCwd = ctx.cwd ?? process.cwd();
        const scope = await buildReviewScope(
          currentCwd,
          params.baseRef,
          signal,
          progress,
        );

        const availableModels = ctx.modelRegistry.getAvailable();
        const model = ctx.model ?? availableModels[0];
        if (!model) {
          throw new Error(
            'polish_solution_review could not find an active model to run the reviewer.',
          );
        }

        progress.update('🚀 Launching isolated adversarial reviewer…', {
          phase: 'launch-reviewer',
          branch: scope.branch,
          baseRef: scope.baseRef,
          mergeBase: scope.mergeBase,
          changedFiles: scope.changedFiles.length,
        });

        const review = await runReviewerSession(
          scope,
          model,
          ctx.modelRegistry,
          pi.getThinkingLevel(),
          progress,
        );

        progress.update(
          `✅ polish_solution_review finished: ${review.status}.`,
          {
            phase: 'complete',
            reviewStatus: review.status,
            findings: review.findings.length,
          },
        );

        return {
          content: [{type: 'text', text: JSON.stringify(review)}],
          details: review,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress.update(`❌ polish_solution_review failed: ${message}`, {
          phase: 'error',
          isError: true,
        });
        throw error;
      } finally {
        progress.clear();
      }
    },
  });
}
