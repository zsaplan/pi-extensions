import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  KB_ROOT_ENV_VAR,
  STRUCTURED_FACT_SYNTAX_GUIDANCE,
  ensureMarkdownRelativePath,
  ensureWithinRoot,
  getKbRoot as getSharedKbRoot,
  lintKnowledgeBase,
  listMarkdownFiles,
  normalizeNewlines,
  parseStructuredFactFileContent,
  renderStructuredFactBullet,
  splitIntoLines,
  toRootRelativePath,
  type FactLintIssue,
} from "@zsaplan/rain-core";

export type Citation = {
  path: string;
  file: string;
  startLine: number;
  endLine: number;
  quote: string;
};

export type LookupUsage = {
  model?: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export type LookupExecutionMeta = {
  model: string;
  kbRoot: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  elapsed: string;
  usage: LookupUsage;
};

export type VerificationResult = {
  status: "answered" | "insufficient_evidence" | "conflict";
  data: Record<string, unknown>;
  citations: Citation[];
  missingInformation: string[];
  warnings: string[];
  meta?: {
    model: string;
    kbRoot: string;
  };
};

export type LookupArtifactRef = {
  id: string;
  path: string;
};

export type LookupDiagnostics = {
  messages?: unknown[];
  toolAccess?: LookupToolAccessRecord;
  usage?: LookupUsage;
};

export type LookupOutcome = {
  result: VerificationResult;
  execution: LookupExecutionMeta;
  diagnostics?: LookupDiagnostics;
};

export type LookupToolResult = VerificationResult & {
  result: VerificationResult;
  execution: LookupExecutionMeta;
  diagnostics?: LookupDiagnostics;
  artifact?: LookupArtifactRef;
  artifactFormat?: "jsonl";
  artifactWarning?: string;
};

type StructuredReadFact = {
  lineNumber: number;
  canonical: string;
  relation: string;
  object: string;
  qualifiers: string[];
};

type ReadOutput = {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  heading: string | null;
  structuredFacts: StructuredReadFact[];
  content: string;
};

type GrepHit = {
  file: string;
  lineNumber: number;
  line: string;
};

type SubmitResultInput = VerificationResult;

type ValidationContext = {
  kbRoot: string;
  model: string;
  fileIndex?: FactFileIndex;
};

type FactFileIndex = {
  validFiles: string[];
  validFileSet: Set<string>;
  invalidFiles: Array<{ file: string; issues: FactLintIssue[] }>;
  warnings: string[];
};

type RainmanQueryEntry = {
  ranAt: number;
  status?: VerificationResult["status"];
  hit: boolean;
  isError: boolean;
  elapsedMs?: number;
  totalTokens?: number;
  warningCount?: number;
  malformedFileCount?: number;
  artifactId?: string;
  artifactPath?: string;
};

type RuntimeState = {
  activeRuns: number;
  activeActivities: Map<string, { message: string; spinnerFrame: string | null; updatedAt: number }>;
  sessionQueries: number;
  sessionHits: number;
  sessionErrors: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastElapsedMs: number | null;
  lastTotalTokens: number | null;
  lastWarningCount: number | null;
  lastMalformedFileCount: number | null;
  lastArtifactPath: string | null;
};

type SubmittedResultState = {
  value?: VerificationResult;
  wait: Promise<VerificationResult>;
  resolve: (value: VerificationResult) => void;
};

type PromptAttemptResult =
  | { kind: "prompt-complete" }
  | { kind: "prompt-error"; error: unknown }
  | { kind: "submitted" };

export type LookupToolAccessRecord = {
  activeToolNames: string[];
  configuredToolNames: string[];
  systemPromptHasAvailableTools?: boolean;
  systemPromptHasSubmitResult?: boolean;
  availableToolsSection?: string;
};

type ToolErrorDetails = Record<string, unknown> | undefined;

type ToolCallError = Error & {
  code?: string;
  details?: ToolErrorDetails;
};

type LookupSessionError = Error & {
  lookupUsage?: LookupUsage;
  lookupMessages?: unknown[];
  lookupToolAccess?: LookupToolAccessRecord;
};

export type LookupArtifactMode = "off" | "failure" | "always";

type LookupErrorRecord = {
  name: string;
  message: string;
  stack?: string;
};

type LookupRunRecord = {
  version: 1;
  toolName: "rainman_lookup";
  toolCallId: string;
  runId: string;
  createdAt: string;
  question: string;
  status: "success" | "error";
  lookupStatus?: VerificationResult["status"];
  execution: LookupExecutionMeta;
  result?: VerificationResult;
  error?: LookupErrorRecord;
  diagnostics?: LookupDiagnostics;
  fileIndex?: {
    validFiles: number;
    invalidFiles: number;
    warnings: string[];
  };
};

type EvalCase = {
  id: string;
  question: string;
  expectedStatus?: VerificationResult["status"];
  requiredAnswerSubstrings?: string[];
  forbiddenAnswerSubstrings?: string[];
  requiredClaims?: string[];
  requiredConcepts?: string[][];
  forbiddenClaims?: string[];
  expectedCitationFiles?: string[];
  requiredCitationQuoteSubstrings?: string[];
  minCitationCount?: number;
  maxCitationCount?: number;
  maxElapsedMs?: number;
};

type EvalSuite = {
  name: string;
  description?: string;
  cases: EvalCase[];
};

type EvalCaseResult = {
  id: string;
  question: string;
  repeatIndex: number;
  repeatCount: number;
  ok: boolean;
  status: "success" | "error";
  lookupStatus?: VerificationResult["status"];
  elapsedMs: number;
  elapsed: string;
  totalTokens: number;
  cost: number;
  failureReasons: string[];
  answer?: string;
  citationFiles: string[];
  error?: string;
};

type EvalRunResult = {
  suite: string;
  createdAt: string;
  model: string;
  thinkingLevel: typeof RAINMAN_THINKING_LEVEL;
  kbRoot: string;
  cases: EvalCaseResult[];
  summary: {
    uniqueCases: number;
    repeatCount: number;
    total: number;
    passed: number;
    failed: number;
    averageElapsedMs: number;
    totalTokens: number;
    totalCost: number;
  };
};

type LookupArtifactEntryBase = {
  version: 1;
  toolName: "rainman_lookup";
  toolCallId: string;
  runId: string;
  timestamp: string;
};

type LookupArtifactEntry =
  | (LookupArtifactEntryBase & {
    entryType: "run-started";
    question: string;
    debugMode: LookupArtifactMode;
  })
  | (LookupArtifactEntryBase & {
    entryType: "progress";
    message: string;
    details?: unknown;
  })
  | (LookupArtifactEntryBase & {
    entryType: "progress-content";
    content: string;
    details?: unknown;
  })
  | (LookupArtifactEntryBase & {
    entryType: "lookup-event";
    event: unknown;
  })
  | (LookupArtifactEntryBase & {
    entryType: "run-finished";
    status: LookupRunRecord["status"];
    record: LookupRunRecord;
  });

type LookupArtifactWriter = {
  mode: LookupArtifactMode;
  ref?: LookupArtifactRef;
  append(entry: LookupArtifactEntry): Promise<void>;
  appendBestEffort(entry: LookupArtifactEntry): void;
  flush(): Promise<void>;
  discard(): Promise<void>;
  getWarning(): string | undefined;
};

const LOOKUP_TOOL_PARAMS = Type.Object({
  question: Type.String({
    description: "Question to look up against Raincatcher knowledge files.",
    minLength: 1,
  }),
});

const citationSchema = Type.Object({
  path: Type.String(),
  file: Type.String(),
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  quote: Type.String(),
});

const submitResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal("answered"),
    Type.Literal("insufficient_evidence"),
    Type.Literal("conflict"),
  ]),
  data: Type.Record(Type.String(), Type.Any()),
  citations: Type.Array(citationSchema),
  missingInformation: Type.Array(Type.String()),
  warnings: Type.Array(Type.String()),
  meta: Type.Optional(
    Type.Object({
      model: Type.String(),
      kbRoot: Type.String(),
    }),
  ),
});

const readParameters = Type.Object({
  filePath: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

const findParameters = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

const grepParameters = Type.Object({
  pattern: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

const QUERY_ENTRY_TYPE = "rainman-query";
const RUN_ENTRY_TYPE = "rainman-lookup-run";
const DEBUG_ARTIFACTS_ENV_VAR = "PI_RAINMAN_DEBUG_ARTIFACTS";
const DEFAULT_READ_LIMIT = 200;
const DEFAULT_FIND_LIMIT = 20;
const DEFAULT_GREP_LIMIT = 20;
const RAINMAN_THINKING_LEVEL = "off" as const;
const MAX_REPAIR_ATTEMPTS = 1;
const MAX_AGENT_EXECUTION_MS = 45_000;
const STATUS_KEY = "rainman";
const HEARTBEAT_INTERVAL_MS = 2_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RAINMAN_SELF_TEST_QUESTION =
  "__rainman_self_test__ Return insufficient_evidence unless a lint-clean knowledge file literally answers this exact string.";
const EVAL_RESULTS_DIRNAME = "rainman-evals";
const LOOKUP_DIRECTIVE_PATTERNS = [
  /\brainman\b/,
  /\braincatcher\b/,
  /\bknowledge base\b/,
  /\bwhat do we know about\b/,
  /\bwhat did we (?:already )?(?:determine|decide|learn)\b/,
  /\baccording to\b/,
  /\bpreviously-derived\b/,
  /\bprior conclusion\b/,
] as const;
const LOOKUP_TOPIC_PATTERNS = [
  /\bworkflow\b/,
  /\bconvention\b/,
  /\bpreference\b/,
  /\bsource of truth\b/,
  /\bowner(?:ship)?\b/,
  /\brepo(?:sitory)?\b/,
  /\bpath\b/,
  /\blocation\b/,
  /\bcache\b/,
  /\bcaching\b/,
  /\binvalidat(?:e|ion)\b/,
  /\bbehavior\b/,
  /\bworkaround\b/,
  /\bexplanation\b/,
  /\bdocumented\b/,
  /\bknown\b/,
] as const;
const LOOKUP_SKIP_PATTERNS = [
  /\bright now\b/,
  /\bat the moment\b/,
  /\bwhat changed\b/,
  /\brecent changes?\b/,
  /\bjust changed\b/,
  /\blogs?\b/,
  /\btrace(?:back|s)?\b/,
  /\bgrafana\b/,
  /\bloki\b/,
  /\btempo\b/,
  /\bprometheus\b/,
  /\bmetric(?:s)?\b/,
  /\bdashboard\b/,
  /\brepro(?:duce|duction)?\b/,
  /\bincident\b/,
  /\boutage\b/,
  /\bcurrently (?:failing|broken|erroring|timing out|slow)\b/,
  /\b(?:failing|broken|erroring|timing out|slow)\b.*\b(?:right now|currently|today)\b/,
  /\b(?:right now|currently|today)\b.*\b(?:failing|broken|erroring|timing out|slow)\b/,
] as const;
const QUESTION_PREFIX_PATTERN = /^(what|where|which|who|when|why|how|is|are|do|does|did|can|should|could|would|explain|describe|summarize|confirm)\b/;

const LOOKUP_POLICY_APPEND = `Rainman lookup policy:
- Rainman is a knowledge cache of stable, previously-derived project understanding captured in Raincatcher.
- For likely-stable questions about workflows, conventions, preferences, ownership, source-of-truth repos, paths, locations, cache behavior, prior conclusions, or recurring explanations, call rainman_lookup before exploring code or files.
- If rainman_lookup returns status answered, use that evidence-backed result.
- If it returns status insufficient_evidence or conflict, continue with normal repo/code/log/db investigation as needed.
- Skip rainman-first lookup for live-state, very recent change, or current-incident questions.`;

const SYSTEM_PROMPT = `You are a correctness-first knowledge lookup agent.

Available tools:
- find: Find markdown files under the knowledge root by filename or path fragment. Navigation only, not evidence.
- grep: Search markdown files under the knowledge root for matching text. Navigation only, not evidence.
- read: Read a lint-clean structured fact file under the knowledge root and return line-numbered content plus parsed fact summaries.
- submit_result: Submit the final structured response. This is the only valid completion path.

Guidelines:
- Rainman is a fast citation lookup agent, not a researcher.
- Rainman is a knowledge cache of stable, previously-derived project understanding captured in Raincatcher markdown files.
- Answer only from lint-clean markdown files inside the configured knowledge root.
- Default strategy: find with 1-3 key nouns, prefer __DEFINITION/__REPOSITORY/__WORKFLOW files, read the single best file first, and submit if it contains enough evidence.
- Read additional files only when the first read lacks direct evidence for the question.
- Use grep only when find returns no plausible topic file or when you need one narrow phrase.
- Use find and grep only for navigation.
- Only read output counts as evidence.
- The read tool returns raw line-numbered content plus parsed structured fact summaries for the requested range.
- Every populated field in data must have one or more exact citations.
- Citation quote values must match the raw file text exactly and must omit the read tool's display-only line-number prefixes like "3 | ".
- Submit as soon as you have 1-3 cited facts that answer the question.
- If no direct evidence is available after six tool calls, return status insufficient_evidence so the caller can continue with normal investigation.
- If relevant knowledge files conflict, return status conflict so the caller can investigate further.
- Use only the tools listed above.
- The only valid completion path is submit_result.
- If submit_result succeeds, stop immediately and do not add extra text.
- Prefer the smallest valid payload.

Canonical Rain fact syntax reference:
${STRUCTURED_FACT_SYNTAX_GUIDANCE}

Use these response shapes:
- answered: data = {"answer":"..."}, citations = [{"path":"/data/answer", ...}], missingInformation = [], warnings = []
- insufficient_evidence: data = {}, citations = [], missingInformation = ["..."] if helpful, warnings = []
- conflict: data = {"conflicts":["...","..."]}, citations = [{"path":"/data/conflicts/0", ...}], missingInformation = [], warnings = []
For citations, quote must exactly match the cited raw file lines without read-output line-number prefixes.`;

export class ToolInputError extends Error {
  readonly code: string;
  readonly details?: ToolErrorDetails;

  constructor(code: string, message: string, details?: ToolErrorDetails) {
    super(message);
    this.name = "ToolInputError";
    this.code = code;
    this.details = details;
  }
}

export class ResultValidationError extends Error {
  readonly code: string;
  readonly details?: ToolErrorDetails;

  constructor(code: string, message: string, details?: ToolErrorDetails) {
    super(message);
    this.name = "ResultValidationError";
    this.code = code;
    this.details = details;
  }
}

function escapeSegment(segment: string | number): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

function buildPointer(segments: Array<string | number>): string {
  if (segments.length === 0) return "";
  return `/${segments.map(escapeSegment).join("/")}`;
}

function getValueAtPointer(target: unknown, pointer: string): unknown {
  if (pointer === "") return target;
  if (!pointer.startsWith("/")) return undefined;

  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

  let current: unknown = target;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }

    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function collectLeafPointers(value: unknown, baseSegments: Array<string | number> = []): string[] {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectLeafPointers(entry, [...baseSegments, index]));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [];
    return entries.flatMap(([key, entryValue]) => collectLeafPointers(entryValue, [...baseSegments, key]));
  }

  return [buildPointer(baseSegments)];
}

function getKbRoot(): string {
  return getSharedKbRoot(getAgentDir());
}

function ensureKbReady(kbRoot: string): void {
  if (!fs.existsSync(kbRoot)) {
    throw new Error(`Knowledge root does not exist: ${kbRoot}`);
  }

  if (!fs.statSync(kbRoot).isDirectory()) {
    throw new Error(`Knowledge root is not a directory: ${kbRoot}`);
  }
}

export function ensureKnowledgeMarkdownPath(filePath: string): void {
  if (filePath.split(/[\\/]+/).includes("..")) {
    throw new ToolInputError("PATH_ESCAPE", `Path traversal is not allowed: ${filePath}`, { filePath });
  }

  try {
    ensureMarkdownRelativePath(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes("Only markdown files") ? "NON_MARKDOWN_FILE" : "PATH_ESCAPE";
    throw new ToolInputError(code, message, { filePath });
  }
}

export function ensureWithinKbRoot(kbRoot: string, relativePath: string): string {
  try {
    return ensureWithinRoot(kbRoot, relativePath);
  } catch (error) {
    throw new ToolInputError("PATH_ESCAPE", error instanceof Error ? error.message : String(error), {
      kbRoot,
      relativePath,
    });
  }
}

export function toKbRelativePath(kbRoot: string, absolutePath: string): string {
  try {
    return toRootRelativePath(kbRoot, absolutePath);
  } catch (error) {
    throw new ToolInputError("PATH_ESCAPE", error instanceof Error ? error.message : String(error), {
      kbRoot,
      absolutePath,
    });
  }
}

function summarizeFiles(files: string[], max = 5): string {
  if (files.length <= max) return files.join(", ");
  return `${files.slice(0, max).join(", ")}, ...`;
}

export function buildFactFileIndex(kbRoot: string): FactFileIndex {
  const lintResult = lintKnowledgeBase(kbRoot);
  const issuesByFile = new Map<string, FactLintIssue[]>();

  for (const issue of lintResult.issues) {
    const list = issuesByFile.get(issue.file) ?? [];
    list.push(issue);
    issuesByFile.set(issue.file, list);
  }

  const allFiles = listMarkdownFiles(kbRoot);
  const invalidFiles = [...issuesByFile.entries()]
    .map(([file, issues]) => ({ file, issues }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const validFiles = allFiles.filter((file) => !issuesByFile.has(file));
  const warnings = [...lintResult.warnings];

  if (invalidFiles.length > 0) {
    warnings.push(
      `Skipped ${invalidFiles.length} malformed fact file${invalidFiles.length === 1 ? "" : "s"} from evidence: ${summarizeFiles(invalidFiles.map((entry) => entry.file))}`,
    );
  }

  return {
    validFiles,
    validFileSet: new Set(validFiles),
    invalidFiles,
    warnings,
  };
}

function assertPositiveInteger(value: number, code: string, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ToolInputError(code, `${label} must be a positive integer`, { [label]: value });
  }
}

export function readTool(kbRoot: string, fileIndex: FactFileIndex, input: Static<typeof readParameters>): ReadOutput {
  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_READ_LIMIT;

  assertPositiveInteger(offset, "INVALID_OFFSET", "offset");
  assertPositiveInteger(limit, "INVALID_LIMIT", "limit");

  ensureKnowledgeMarkdownPath(input.filePath);
  if (!fileIndex.validFileSet.has(input.filePath)) {
    throw new ToolInputError(
      "INVALID_FACT_FILE",
      "File is malformed or unavailable as structured evidence.",
      { filePath: input.filePath },
    );
  }

  const absolutePath = ensureWithinKbRoot(kbRoot, input.filePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  const lines = splitIntoLines(content);
  const parsed = parseStructuredFactFileContent(content);
  const startIndex = Math.min(offset - 1, lines.length);
  const selectedLines = lines.slice(startIndex, startIndex + limit);
  const startLine = selectedLines.length > 0 ? startIndex + 1 : offset;
  const endLine = selectedLines.length > 0 ? startIndex + selectedLines.length : startIndex;
  const structuredFacts = parsed.bullets
    .filter((bullet) => bullet.lineNumber >= startLine && bullet.lineNumber <= endLine)
    .map((bullet) => ({
      lineNumber: bullet.lineNumber,
      canonical: renderStructuredFactBullet(bullet.parsed),
      relation: bullet.parsed.relation,
      object: bullet.parsed.object,
      qualifiers: bullet.parsed.qualifiers.map((qualifier) => `${qualifier.key}=${qualifier.value}`),
    }));

  return {
    filePath: toKbRelativePath(kbRoot, absolutePath),
    startLine,
    endLine,
    totalLines: lines.length,
    heading: parsed.heading,
    structuredFacts,
    content: selectedLines.map((line, index) => `${startIndex + index + 1} | ${line}`).join("\n"),
  };
}

export function findTool(fileIndex: FactFileIndex, input: Static<typeof findParameters>): string[] {
  const query = input.query.trim().toLowerCase();
  const limit = input.limit ?? DEFAULT_FIND_LIMIT;
  assertPositiveInteger(limit, "INVALID_LIMIT", "limit");

  return fileIndex.validFiles
    .filter((file) => file.toLowerCase().includes(query))
    .slice(0, limit);
}

export function grepTool(kbRoot: string, fileIndex: FactFileIndex, input: Static<typeof grepParameters>): GrepHit[] {
  const pattern = input.pattern.trim().toLowerCase();
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  assertPositiveInteger(limit, "INVALID_LIMIT", "limit");
  if (!pattern) return [];

  const hits: GrepHit[] = [];
  for (const file of fileIndex.validFiles) {
    const content = fs.readFileSync(ensureWithinKbRoot(kbRoot, file), "utf8");
    const lines = splitIntoLines(content);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.toLowerCase().includes(pattern)) continue;

      hits.push({
        file,
        lineNumber: index + 1,
        line,
      });

      if (hits.length >= limit) return hits;
    }
  }

  return hits;
}

export function readCitationLines(kbRoot: string, relativeFilePath: string, startLine: number, endLine: number): string {
  ensureKnowledgeMarkdownPath(relativeFilePath);
  const absolutePath = ensureWithinKbRoot(kbRoot, relativeFilePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  const lines = splitIntoLines(content);

  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new ResultValidationError("LINE_RANGE_OUT_OF_BOUNDS", "Citation line range is out of bounds", {
      file: relativeFilePath,
      startLine,
      endLine,
      totalLines: lines.length,
    });
  }

  return lines.slice(startLine - 1, endLine).join("\n");
}

export function validateCitations(kbRoot: string, citations: Citation[], fileIndex?: FactFileIndex): void {
  for (const citation of citations) {
    if (!citation.path.startsWith("/data")) {
      throw new ResultValidationError("INVALID_CITATION_PATH", "Citation path must target /data", {
        path: citation.path,
      });
    }

    ensureKnowledgeMarkdownPath(citation.file);
    ensureWithinKbRoot(kbRoot, citation.file);

    if (fileIndex && !fileIndex.validFileSet.has(citation.file)) {
      throw new ResultValidationError("INVALID_CITATION_FILE", "Citation file is malformed or unavailable as structured evidence", {
        file: citation.file,
      });
    }

    if (citation.endLine < citation.startLine) {
      throw new ResultValidationError(
        "INVALID_CITATION",
        "Citation endLine must be greater than or equal to startLine",
        { citation },
      );
    }

    const actualQuote = readCitationLines(kbRoot, citation.file, citation.startLine, citation.endLine);
    if (normalizeNewlines(actualQuote) !== normalizeNewlines(citation.quote)) {
      throw new ResultValidationError("QUOTE_MISMATCH", "Citation quote does not match file contents", {
        citation,
        actualQuote,
      });
    }
  }
}

export function validateFieldCoverage(data: Record<string, unknown>, citations: Citation[]): void {
  const requiredPointers = collectLeafPointers(data, ["data"]);
  const citedPointers = new Set(citations.map((citation) => citation.path));

  for (const pointer of requiredPointers) {
    if (!pointer.startsWith("/data")) continue;

    if (getValueAtPointer({ data }, pointer) === undefined) {
      throw new ResultValidationError("INVALID_CITATION_PATH", "Citation path does not target a populated response field", {
        path: pointer,
      });
    }

    if (!citedPointers.has(pointer)) {
      throw new ResultValidationError("UNCITED_FIELD", "Populated field is missing citation coverage", {
        path: pointer,
      });
    }
  }

  for (const citation of citations) {
    if (getValueAtPointer({ data }, citation.path) === undefined) {
      throw new ResultValidationError(
        "INVALID_CITATION_PATH",
        "Citation path does not resolve to a populated response field",
        { path: citation.path },
      );
    }
  }
}

function assertStringArray(value: unknown[], fieldName: string): void {
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ResultValidationError("INVALID_SCHEMA", `${fieldName} entries must be strings`, {
        fieldName,
        entry,
      });
    }
  }
}

function assertOnlyDataKeys(
  data: Record<string, unknown>,
  expectedKeys: string[],
  status: VerificationResult["status"],
): void {
  const expectedKeySet = new Set(expectedKeys);
  const actualKeys = Object.keys(data);
  const unsupportedKeys = actualKeys.filter((key) => !expectedKeySet.has(key));
  if (unsupportedKeys.length > 0) {
    throw new ResultValidationError(
      "UNSUPPORTED_DATA_FIELD",
      `${status} results may only populate ${expectedKeys.length > 0 ? expectedKeys.join(", ") : "no data fields"}`,
      { status, unsupportedKeys },
    );
  }
}

function validateStatusDataShape(status: VerificationResult["status"], data: Record<string, unknown>): void {
  if (status === "answered") {
    if (typeof data.answer !== "string") {
      throw new ResultValidationError("INVALID_SCHEMA", "answered results must populate data.answer", {
        status,
      });
    }
    assertOnlyDataKeys(data, ["answer"], status);
    return;
  }

  if (status === "conflict") {
    if (!Array.isArray(data.conflicts) || data.conflicts.length === 0) {
      throw new ResultValidationError("INVALID_SCHEMA", "conflict results must populate data.conflicts", {
        status,
      });
    }

    for (const conflict of data.conflicts) {
      if (typeof conflict !== "string") {
        throw new ResultValidationError("INVALID_SCHEMA", "conflict entries must be strings", {
          status,
        });
      }
    }

    assertOnlyDataKeys(data, ["conflicts"], status);
    return;
  }

  assertOnlyDataKeys(data, [], status);
}

export function validateResult(input: SubmitResultInput, context: ValidationContext): VerificationResult {
  const status = input?.status;
  if (status !== "answered" && status !== "insufficient_evidence" && status !== "conflict") {
    throw new ResultValidationError("INVALID_STATUS", "Unsupported response status", { status });
  }

  if (!input || typeof input !== "object") {
    throw new ResultValidationError("INVALID_SCHEMA", "Result payload must be an object");
  }

  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
    throw new ResultValidationError("INVALID_SCHEMA", "data must be an object");
  }

  if (!Array.isArray(input.citations)) {
    throw new ResultValidationError("INVALID_SCHEMA", "citations must be an array");
  }

  if (!Array.isArray(input.missingInformation)) {
    throw new ResultValidationError("INVALID_SCHEMA", "missingInformation must be an array");
  }

  if (!Array.isArray(input.warnings)) {
    throw new ResultValidationError("INVALID_SCHEMA", "warnings must be an array");
  }

  assertStringArray(input.missingInformation, "missingInformation");
  assertStringArray(input.warnings, "warnings");
  validateStatusDataShape(status, input.data);

  for (const citation of input.citations) {
    if (!citation || typeof citation !== "object") {
      throw new ResultValidationError("INVALID_CITATION", "Each citation must be an object", { citation });
    }

    if (
      typeof citation.path !== "string"
      || typeof citation.file !== "string"
      || !Number.isInteger(citation.startLine)
      || !Number.isInteger(citation.endLine)
      || typeof citation.quote !== "string"
    ) {
      throw new ResultValidationError("INVALID_CITATION", "Citation fields are invalid", { citation });
    }
  }

  validateCitations(context.kbRoot, input.citations, context.fileIndex);
  validateFieldCoverage(input.data, input.citations);

  return {
    status,
    data: input.data,
    citations: input.citations,
    missingInformation: input.missingInformation,
    warnings: input.warnings,
    meta: {
      model: context.model,
      kbRoot: context.kbRoot,
    },
  };
}

function toToolErrorMessage(error: unknown): string {
  const e = error as ToolCallError;
  return JSON.stringify({
    code: typeof e?.code === "string" ? e.code : "TOOL_ERROR",
    message: e instanceof Error ? e.message : String(error),
    details: e?.details,
  });
}

function createSubmittedResultState(): SubmittedResultState {
  let resolveWait = (_value: VerificationResult) => {};
  const wait = new Promise<VerificationResult>((resolve) => {
    resolveWait = resolve;
  });

  const state: SubmittedResultState = {
    wait,
    resolve(value) {
      if (state.value) return;
      state.value = value;
      resolveWait(value);
    },
  };

  return state;
}

function getRegisteredToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];

  return [...new Set(tools.flatMap((tool) => {
    return tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
      ? [(tool as { name: string }).name]
      : [];
  }))].sort((left, right) => left.localeCompare(right));
}

function buildLookupToolAccessRecord(session: any): LookupToolAccessRecord {
  const systemPrompt = typeof session?.systemPrompt === "string" ? session.systemPrompt : "";
  const availableToolsSection = extractAvailableToolsSection(systemPrompt);
  return {
    activeToolNames: getRegisteredToolNames(session?.state?.tools),
    configuredToolNames: typeof session?.getAllTools === "function"
      ? getRegisteredToolNames(session.getAllTools())
      : [],
    systemPromptHasAvailableTools: availableToolsSection !== undefined,
    systemPromptHasSubmitResult: systemPrompt.includes("submit_result"),
    availableToolsSection,
  };
}

function extractAvailableToolsSection(systemPrompt: string): string | undefined {
  const start = systemPrompt.indexOf("Available tools:");
  if (start === -1) return undefined;

  const tail = systemPrompt.slice(start);
  const endMarkers = ["\n\nIn addition to the tools above,", "\n\nGuidelines:"];
  const end = endMarkers
    .map((marker) => tail.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];

  return (end === undefined ? tail : tail.slice(0, end)).trim();
}

function getSessionMessages(session: any): unknown[] {
  return Array.isArray(session?.messages) ? session.messages : [];
}

function getMissingToolNames(expectedToolNames: string[], availableToolNames: string[]): string[] {
  return expectedToolNames.filter((toolName) => !availableToolNames.includes(toolName));
}

function getAssistantTextParts(messages: unknown[]): string[] {
  const texts: string[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== "assistant") continue;

    const content = messageRecord.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;

      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== "text" || typeof partRecord.text !== "string") continue;
      texts.push(partRecord.text);
    }
  }

  return texts;
}

function getLookupPseudoToolCallToolNames(messages: unknown[]): string[] | undefined {
  const toolNames = new Set<string>();

  for (const text of getAssistantTextParts(messages)) {
    for (const line of normalizeNewlines(text).split("\n")) {
      const match = /^to=([A-Za-z0-9_]+)/.exec(line.trim());
      if (!match) continue;
      toolNames.add(match[1]);
    }
  }

  return toolNames.size > 0 ? [...toolNames].sort((left, right) => left.localeCompare(right)) : undefined;
}

function createLookupPseudoToolCallError(toolNames: string[]): Error {
  return new Error(
    "Rainman lookup emitted pseudo tool-call text " +
      `(${toolNames.join(", ")}) instead of invoking tools. ` +
      "This usually means the isolated lookup agent lost its tool scaffolding.",
  );
}

function getLookupSessionDiagnostics(error: unknown): LookupDiagnostics | undefined {
  if (!error || typeof error !== "object") return undefined;

  const errorRecord = error as LookupSessionError;
  if (
    errorRecord.lookupUsage === undefined &&
    errorRecord.lookupMessages === undefined &&
    errorRecord.lookupToolAccess === undefined
  ) {
    return undefined;
  }

  return {
    usage: errorRecord.lookupUsage,
    messages: errorRecord.lookupMessages,
    toolAccess: errorRecord.lookupToolAccess,
  };
}

function attachLookupSessionDiagnostics(
  error: unknown,
  session: any,
  modelName: string,
  lookupToolAccess: LookupToolAccessRecord,
): Error {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const diagnosticError = normalizedError as LookupSessionError;
  diagnosticError.lookupMessages = getSessionMessages(session);
  diagnosticError.lookupToolAccess = lookupToolAccess;
  diagnosticError.lookupUsage = buildLookupUsage(diagnosticError.lookupMessages, modelName);
  return diagnosticError;
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildErrorRecord(error: unknown): LookupErrorRecord {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  return {
    name: normalizedError.name,
    message: normalizedError.message,
    stack: normalizedError.stack,
  };
}

function sanitizeArtifactPathSegment(value: string, fallback: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

export function getLookupArtifactMode(): LookupArtifactMode {
  const rawMode = process.env[DEBUG_ARTIFACTS_ENV_VAR]?.trim().toLowerCase();
  if (!rawMode || rawMode === "failure" || rawMode === "errors" || rawMode === "error") return "failure";
  if (rawMode === "1" || rawMode === "true" || rawMode === "always" || rawMode === "on") return "always";
  if (rawMode === "0" || rawMode === "false" || rawMode === "off" || rawMode === "none") return "off";
  return "failure";
}

function getLookupArtifactDirectory(): string {
  return path.join(getAgentDir(), "data", "rainman-lookup");
}

function buildLookupArtifactEntryBase(toolCallId: string, runId: string): LookupArtifactEntryBase {
  return {
    version: 1,
    toolName: "rainman_lookup",
    toolCallId,
    runId,
    timestamp: new Date().toISOString(),
  };
}

async function createLookupArtifactWriter(options: {
  toolCallId: string;
  runId: string;
  question: string;
  mode: LookupArtifactMode;
}): Promise<LookupArtifactWriter> {
  let ref: LookupArtifactRef | undefined;
  let warning: string | undefined;
  let writeQueue = Promise.resolve();

  const setWarning = (error: unknown): void => {
    if (warning) return;
    warning = error instanceof Error ? error.message : String(error);
  };

  const enqueueAppend = (entry: LookupArtifactEntry): Promise<void> => {
    if (!ref) return Promise.resolve();

    const serializedEntry = `${JSON.stringify(cloneJsonValue(entry))}\n`;
    const nextWrite = writeQueue
      .then(() => appendFile(ref!.path, serializedEntry, { encoding: "utf8", mode: 0o600 }))
      .catch((error) => {
        setWarning(error);
      });
    writeQueue = nextWrite;
    return nextWrite;
  };

  if (options.mode !== "off") {
    try {
      const artifactDirectory = getLookupArtifactDirectory();
      await mkdir(artifactDirectory, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const questionSlug = sanitizeArtifactPathSegment(options.question, "lookup");
      ref = {
        id: options.runId,
        path: path.join(artifactDirectory, `${timestamp}_${questionSlug}_${options.runId}.jsonl`),
      };

      await appendFile(
        ref.path,
        `${JSON.stringify({
          ...buildLookupArtifactEntryBase(options.toolCallId, options.runId),
          entryType: "run-started",
          question: options.question,
          debugMode: options.mode,
        } satisfies LookupArtifactEntry)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      setWarning(error);
      ref = undefined;
    }
  }

  return {
    mode: options.mode,
    ref,
    append(entry: LookupArtifactEntry): Promise<void> {
      return enqueueAppend(entry);
    },
    appendBestEffort(entry: LookupArtifactEntry): void {
      void enqueueAppend(entry);
    },
    async flush(): Promise<void> {
      await writeQueue;
    },
    async discard(): Promise<void> {
      await writeQueue;
      if (!ref) return;
      await rm(ref.path, { force: true }).catch((error) => {
        setWarning(error);
      });
      ref = undefined;
    },
    getWarning(): string | undefined {
      return warning;
    },
  };
}

function buildLookupArtifactEvent(
  eventRecord: Record<string, unknown>,
  attempt: number,
  maxAttempts: number,
): unknown | undefined {
  switch (eventRecord.type) {
    case "turn_start":
    case "turn_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return cloneJsonValue({ attempt, maxAttempts, ...eventRecord });
    case "message_end": {
      const message = eventRecord.message;
      if (!message || typeof message !== "object") return undefined;
      const role = (message as Record<string, unknown>).role;
      if (role !== "assistant" && role !== "toolResult") return undefined;
      return cloneJsonValue({ attempt, maxAttempts, ...eventRecord });
    }
    default:
      return undefined;
  }
}

function formatReadResult(result: ReadOutput): string {
  const linesSection = result.content || "(no content in requested range)";
  const structuredFactsSection = result.structuredFacts.length > 0
    ? result.structuredFacts.map((fact) => `- line ${fact.lineNumber} | ${fact.canonical}`).join("\n")
    : "(none in requested range)";

  return [
    `file: ${result.filePath}`,
    `heading: ${result.heading ?? "(none)"}`,
    `startLine: ${result.startLine}`,
    `endLine: ${result.endLine}`,
    `totalLines: ${result.totalLines}`,
    "structured_facts:",
    structuredFactsSection,
    "content:",
    linesSection,
  ].join("\n");
}

function formatFindResult(matches: string[]): string {
  if (matches.length === 0) return "No matches found.";
  return matches.map((match, index) => `${index + 1}. ${match}`).join("\n");
}

function formatGrepResult(matches: GrepHit[]): string {
  if (matches.length === 0) return "No matches found.";
  return matches.map((match) => `${match.file}:${match.lineNumber} | ${match.line}`).join("\n");
}

const CANDIDATE_STOPWORDS = new Set([
  "about",
  "company",
  "context",
  "could",
  "does",
  "exact",
  "from",
  "have",
  "into",
  "located",
  "location",
  "should",
  "source",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "work",
  "workspace",
  "would",
]);

const CANDIDATE_SUFFIX_BOOSTS = new Map([
  ["DEFINITION", 80],
  ["REPOSITORY", 60],
  ["LOCATION", 50],
  ["WORKFLOW", 35],
  ["CONFIGURATION", 25],
  ["DEPLOYMENT", 20],
  ["TROUBLESHOOTING", -20],
]);

function tokenizeForCandidateRanking(value: string): string[] {
  const tokens: string[] = [];
  for (const rawPart of value.split(/[^a-zA-Z0-9]+/)) {
    const compact = rawPart.toLowerCase().trim();
    if (!compact) continue;
    tokens.push(compact);
    tokens.push(...rawPart
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/));
  }

  return [...new Set(tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !CANDIDATE_STOPWORDS.has(token)))];
}

function scoreCandidateFile(questionTokens: string[], file: string, questionCompact: string): number {
  const baseName = file.replace(/\.md$/i, "");
  const [subject = "", topic = ""] = baseName.split("__");
  const subjectTokens = tokenizeForCandidateRanking(subject);
  const topicTokens = tokenizeForCandidateRanking(topic);
  const allFileTokens = new Set([...subjectTokens, ...topicTokens]);
  let score = 0;
  const compactSubject = subject.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compactSubject && questionCompact.includes(compactSubject)) score += 120;

  for (const token of questionTokens) {
    if (subjectTokens.includes(token)) score += 100;
    else if (allFileTokens.has(token)) score += 35;
  }

  score += CANDIDATE_SUFFIX_BOOSTS.get(topic) ?? 0;
  if (questionTokens.length > 0 && questionTokens.every((token) => allFileTokens.has(token))) {
    score += 40;
  }
  return score;
}

export function rankCandidateFactFiles(question: string, fileIndex: FactFileIndex, limit = 12): string[] {
  const questionTokens = tokenizeForCandidateRanking(question);
  if (questionTokens.length === 0) return [];

  const questionCompact = question.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return fileIndex.validFiles
    .map((file) => ({ file, score: scoreCandidateFile(questionTokens, file, questionCompact) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit)
    .map((candidate) => candidate.file);
}

function buildPrompt(question: string, fileIndex: FactFileIndex): string {
  const candidateFiles = rankCandidateFactFiles(question, fileIndex);
  const candidateSection = candidateFiles.length > 0
    ? [
      "Ranked candidate files from deterministic filename matching:",
      ...candidateFiles.map((file, index) => `${index + 1}. ${file}`),
      "Start by reading candidate #1 directly with a small limit such as 20. If it contains enough evidence, submit immediately.",
      "Read candidate #2 or run narrow grep only if candidate #1 lacks direct evidence.",
    ].join("\n")
    : "No deterministic candidate files were found; use find with the question's key nouns first.";

  return [
    "Answer the question using only markdown evidence from the knowledge root.",
    "Use grep and find only for navigation.",
    "Use read to gather exact evidence from lint-clean structured fact files.",
    `Available structured fact files: ${fileIndex.validFiles.length}`,
    `Malformed fact files unavailable as evidence: ${fileIndex.invalidFiles.length}`,
    candidateSection,
    "Prefer the smallest valid data payload and the fewest tool calls that preserve citation correctness.",
    "For a normal direct answer, use data.answer and cite /data/answer.",
    "For citation.quote, copy the raw fact text only; omit display line prefixes such as '3 | '.",
    "When you are ready, call submit_result.",
    "After submit_result succeeds, stop immediately.",
    "Question:",
    question,
  ].join("\n\n");
}

function buildRepairPrompt(question: string, attempt: number): string {
  return [
    `Repair attempt ${attempt}.`,
    "Your previous turn ended without a valid submit_result.",
    "Continue from the current context and call submit_result.",
    "Do not answer in plain text.",
    "If evidence is insufficient, submit status insufficient_evidence.",
    "Question:",
    question,
  ].join("\n\n");
}

function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function shouldNudgeRainmanLookup(prompt: string): boolean {
  const normalizedPrompt = prompt.trim().toLowerCase();
  if (!normalizedPrompt) return false;
  if (matchesAnyPattern(normalizedPrompt, LOOKUP_SKIP_PATTERNS)) return false;
  if (matchesAnyPattern(normalizedPrompt, LOOKUP_DIRECTIVE_PATTERNS)) return true;

  const hasStableTopic = matchesAnyPattern(normalizedPrompt, LOOKUP_TOPIC_PATTERNS);
  if (!hasStableTopic) return false;

  return QUESTION_PREFIX_PATTERN.test(normalizedPrompt) || normalizedPrompt.includes("?");
}

function summarizeCitations(citations: Citation[]): string[] {
  return citations.map((citation) => {
    const quote = citation.quote.replace(/\s+/g, " ").trim();
    const preview = quote.length > 120 ? `${quote.slice(0, 119).trimEnd()}…` : quote;
    return `- ${citation.path} -> ${citation.file}:${citation.startLine}-${citation.endLine} — ${preview}`;
  });
}

export function formatVerificationResult(result: VerificationResult): string {
  const lines: string[] = [`status: ${result.status}`];

  if (typeof result.data.answer === "string") {
    lines.push(`answer: ${result.data.answer}`);
  } else if (Array.isArray(result.data.conflicts) && result.data.conflicts.length > 0) {
    lines.push("conflicts:");
    for (const conflict of result.data.conflicts) {
      if (typeof conflict === "string") lines.push(`- ${conflict}`);
    }
  }

  if (result.missingInformation.length > 0) {
    lines.push("missingInformation:");
    for (const item of result.missingInformation) lines.push(`- ${item}`);
  }

  if (result.warnings.length > 0) {
    lines.push("warnings:");
    for (const item of result.warnings) lines.push(`- ${item}`);
  }

  if (result.citations.length > 0) {
    lines.push("citations:");
    lines.push(...summarizeCitations(result.citations));
  }

  return lines.join("\n");
}

function createCustomTools(
  kbRoot: string,
  modelName: string,
  submittedResultState: SubmittedResultState,
  fileIndex: FactFileIndex,
): ToolDefinition[] {
  return [
    {
      name: "read",
      label: "Read",
      description: "Read a lint-clean structured fact file under the knowledge root and return line-numbered content plus parsed fact summaries.",
      promptSnippet: "read(filePath, offset?, limit?) - read structured markdown evidence with stable line numbers",
      promptGuidelines: [
        "Use read to gather evidence.",
        "Only read output counts as evidence.",
        "Citations must quote exact lines returned by read.",
      ],
      parameters: readParameters,
      execute: async (_toolCallId, params: Static<typeof readParameters>) => {
        try {
          const result = readTool(kbRoot, fileIndex, params);
          return {
            content: [{ type: "text", text: formatReadResult(result) }],
            details: result,
          };
        } catch (error) {
          throw new Error(toToolErrorMessage(error));
        }
      },
    },
    {
      name: "find",
      label: "Find",
      description: "Find markdown files under the knowledge root by filename or path fragment. Navigation only, not evidence.",
      promptSnippet: "find(query, limit?) - locate markdown files inside the knowledge root",
      promptGuidelines: ["Find results are navigation aids only and are never evidence."],
      parameters: findParameters,
      execute: async (_toolCallId, params: Static<typeof findParameters>) => {
        try {
          const result = findTool(fileIndex, params);
          return {
            content: [{ type: "text", text: formatFindResult(result) }],
            details: result,
          };
        } catch (error) {
          throw new Error(toToolErrorMessage(error));
        }
      },
    },
    {
      name: "grep",
      label: "Grep",
      description: "Search markdown files under the knowledge root for matching text. Navigation only, not evidence.",
      promptSnippet: "grep(pattern, limit?) - search markdown files for candidate evidence",
      promptGuidelines: ["Grep results are navigation aids only and are never evidence."],
      parameters: grepParameters,
      execute: async (_toolCallId, params: Static<typeof grepParameters>) => {
        try {
          const result = grepTool(kbRoot, fileIndex, params);
          return {
            content: [{ type: "text", text: formatGrepResult(result) }],
            details: result,
          };
        } catch (error) {
          throw new Error(toToolErrorMessage(error));
        }
      },
    },
    {
      name: "submit_result",
      label: "Submit Result",
      description: "Submit the final structured response. This is the only valid completion path.",
      promptSnippet:
        "submit_result(status, data, citations, missingInformation, warnings) - finalize only when every populated data field is fully supported; citation.quote must be raw file text without read line-number prefixes",
      promptGuidelines: [
        "Call submit_result exactly once when the final payload is ready.",
        "If submit_result returns an error, repair the payload and try again.",
        "After submit_result succeeds, stop immediately.",
      ],
      parameters: submitResultSchema,
      execute: async (_toolCallId, params: Static<typeof submitResultSchema>) => {
        try {
          const validated = validateResult(params as SubmitResultInput, { kbRoot, model: modelName, fileIndex });
          submittedResultState.resolve({
            ...validated,
            warnings: [...new Set([...validated.warnings, ...fileIndex.warnings])],
          });
          return {
            content: [{ type: "text", text: "submit_result accepted. Stop now." }],
            details: submittedResultState.value,
            terminate: true,
          };
        } catch (error) {
          throw new Error(toToolErrorMessage(error));
        }
      },
    },
  ];
}

function isRainmanSelfTestPass(result: VerificationResult): boolean {
  return (
    result.status === "insufficient_evidence" &&
    Object.keys(result.data).length === 0 &&
    result.citations.length === 0
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsageSummary(usage: LookupUsage): string {
  const parts = [
    `${formatTokenCount(usage.totalTokens)} tokens`,
    `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`,
  ];
  if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
  return parts.join(" · ");
}

function getFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function createEmptyLookupUsage(model?: string): LookupUsage {
  return {
    model,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

export function buildLookupUsage(messages: unknown[], fallbackModel?: string): LookupUsage {
  const usage = createEmptyLookupUsage(fallbackModel);

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== "assistant") continue;

    usage.turns += 1;

    if (!usage.model && typeof messageRecord.model === "string") {
      const provider = typeof messageRecord.provider === "string"
        ? messageRecord.provider
        : undefined;
      usage.model = provider
        ? `${provider}/${messageRecord.model}`
        : messageRecord.model;
    }

    const messageUsage = messageRecord.usage;
    if (!messageUsage || typeof messageUsage !== "object") continue;

    const usageRecord = messageUsage as Record<string, unknown>;
    const input = getFiniteNumber(usageRecord.input);
    const output = getFiniteNumber(usageRecord.output);
    const cacheRead = getFiniteNumber(usageRecord.cacheRead);
    const cacheWrite = getFiniteNumber(usageRecord.cacheWrite);
    const totalTokens = getFiniteNumber(usageRecord.totalTokens);
    usage.input += input;
    usage.output += output;
    usage.cacheRead += cacheRead;
    usage.cacheWrite += cacheWrite;
    usage.totalTokens += totalTokens || input + output + cacheRead + cacheWrite;

    const cost = usageRecord.cost;
    if (cost && typeof cost === "object") {
      usage.cost += getFiniteNumber((cost as Record<string, unknown>).total);
    }
  }

  if (!usage.totalTokens) {
    usage.totalTokens =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }

  return usage;
}

function validateEvalSuite(input: unknown, source: string): EvalSuite {
  if (!input || typeof input !== "object") {
    throw new Error(`Rainman eval suite ${source} must be a JSON object.`);
  }

  const suite = input as Record<string, unknown>;
  if (typeof suite.name !== "string" || !suite.name.trim()) {
    throw new Error(`Rainman eval suite ${source} must include a non-empty name.`);
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error(`Rainman eval suite ${source} must include one or more cases.`);
  }

  return {
    name: suite.name.trim(),
    description: typeof suite.description === "string" ? suite.description : undefined,
    cases: suite.cases.map((caseInput, index) => {
      if (!caseInput || typeof caseInput !== "object") {
        throw new Error(`Rainman eval case ${index + 1} in ${source} must be an object.`);
      }
      const record = caseInput as Record<string, unknown>;
      const id = typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : `case-${index + 1}`;
      if (typeof record.question !== "string" || !record.question.trim()) {
        throw new Error(`Rainman eval case ${id} in ${source} must include a non-empty question.`);
      }
      const expectedStatus = record.expectedStatus;
      if (
        expectedStatus !== undefined &&
        expectedStatus !== "answered" &&
        expectedStatus !== "insufficient_evidence" &&
        expectedStatus !== "conflict"
      ) {
        throw new Error(`Rainman eval case ${id} in ${source} has invalid expectedStatus.`);
      }

      return {
        id,
        question: record.question.trim(),
        expectedStatus: expectedStatus as EvalCase["expectedStatus"],
        requiredAnswerSubstrings: getStringArray(record.requiredAnswerSubstrings),
        forbiddenAnswerSubstrings: getStringArray(record.forbiddenAnswerSubstrings),
        requiredClaims: getStringArray(record.requiredClaims),
        requiredConcepts: getStringArrayArray(record.requiredConcepts),
        forbiddenClaims: getStringArray(record.forbiddenClaims),
        expectedCitationFiles: getStringArray(record.expectedCitationFiles),
        requiredCitationQuoteSubstrings: getStringArray(record.requiredCitationQuoteSubstrings),
        minCitationCount: getNonNegativeInteger(record.minCitationCount),
        maxCitationCount: getNonNegativeInteger(record.maxCitationCount),
        maxElapsedMs: typeof record.maxElapsedMs === "number" && Number.isFinite(record.maxElapsedMs)
          ? record.maxElapsedMs
          : undefined,
      };
    }),
  };
}

function getDefaultEvalSuitePath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "..", "evals", "default.json");
}

function resolveEvalSuitePath(rawPath?: string): string {
  if (!rawPath) return getDefaultEvalSuitePath();
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function readEvalSuite(suitePath: string): EvalSuite {
  const content = fs.readFileSync(suitePath, "utf8");
  return validateEvalSuite(JSON.parse(content) as unknown, suitePath);
}

function getEvalResultsDir(): string {
  return path.join(getAgentDir(), "data", EVAL_RESULTS_DIRNAME);
}

function sanitizeEvalFileSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "eval";
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function getStringArrayArray(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups = value
    .map(getStringArray)
    .filter((group): group is string[] => Array.isArray(group) && group.length > 0);
  return groups.length > 0 ? groups : undefined;
}

function normalizeRubricText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesRubricText(haystack: string, needle: string): boolean {
  return normalizeRubricText(haystack).includes(normalizeRubricText(needle));
}

function getNonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

function parseEvalArgs(input: string): { suitePath?: string; limit?: number; repeatCount: number } {
  const parts = input.split(/\s+/).filter(Boolean).slice(1);
  let repeatCount = 5;
  let limit: number | undefined;
  let suitePath: string | undefined;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "--repeat" || part === "-n") {
      repeatCount = parsePositiveInteger(parts[index + 1]) ?? repeatCount;
      index += 1;
      continue;
    }
    if (part.startsWith("--repeat=")) {
      repeatCount = parsePositiveInteger(part.slice("--repeat=".length)) ?? repeatCount;
      continue;
    }
    if (part === "--limit") {
      limit = parsePositiveInteger(parts[index + 1]) ?? limit;
      index += 1;
      continue;
    }
    if (part.startsWith("--limit=")) {
      limit = parsePositiveInteger(part.slice("--limit=".length)) ?? limit;
      continue;
    }
    if (!suitePath && !part.startsWith("-")) {
      const numeric = parsePositiveInteger(part);
      if (numeric !== undefined && limit === undefined) {
        limit = numeric;
      } else {
        suitePath = part;
      }
    }
  }

  return { suitePath, limit, repeatCount };
}

function extractAnswer(result: VerificationResult): string | undefined {
  const answer = result.data.answer;
  return typeof answer === "string" ? answer : undefined;
}

function evaluateOutcome(testCase: EvalCase, outcome: LookupOutcome, repeatIndex = 1, repeatCount = 1): EvalCaseResult {
  const failureReasons: string[] = [];
  const result = outcome.result;
  const answer = extractAnswer(result);
  const answerText = answer ?? "";
  const normalizedAnswer = answerText.toLowerCase();
  const citationFiles = [...new Set(result.citations.map((citation) => citation.file))].sort();
  const citationText = result.citations.map((citation) => citation.quote).join("\n");
  const normalizedCitationText = citationText.toLowerCase();

  if (testCase.expectedStatus && result.status !== testCase.expectedStatus) {
    failureReasons.push(`expected status ${testCase.expectedStatus}, got ${result.status}`);
  }

  for (const substring of testCase.requiredAnswerSubstrings ?? []) {
    if (!includesRubricText(answerText, substring)) {
      failureReasons.push(`answer missing substring ${JSON.stringify(substring)}`);
    }
  }

  for (const substring of testCase.forbiddenAnswerSubstrings ?? []) {
    if (includesRubricText(answerText, substring)) {
      failureReasons.push(`answer contains forbidden substring ${JSON.stringify(substring)}`);
    }
  }

  for (const claim of testCase.requiredClaims ?? []) {
    if (!includesRubricText(answerText, claim)) {
      failureReasons.push(`answer missing required claim ${JSON.stringify(claim)}`);
    }
  }

  for (const concept of testCase.requiredConcepts ?? []) {
    if (!concept.some((alternative) => includesRubricText(answerText, alternative))) {
      failureReasons.push(`answer missing required concept ${JSON.stringify(concept)}`);
    }
  }

  for (const claim of testCase.forbiddenClaims ?? []) {
    if (includesRubricText(answerText, claim)) {
      failureReasons.push(`answer contains forbidden claim ${JSON.stringify(claim)}`);
    }
  }

  for (const expectedFile of testCase.expectedCitationFiles ?? []) {
    if (!citationFiles.includes(expectedFile)) {
      failureReasons.push(`missing citation file ${expectedFile}`);
    }
  }

  for (const substring of testCase.requiredCitationQuoteSubstrings ?? []) {
    if (!includesRubricText(citationText, substring)) {
      failureReasons.push(`citations missing quote substring ${JSON.stringify(substring)}`);
    }
  }

  if (testCase.minCitationCount !== undefined && result.citations.length < testCase.minCitationCount) {
    failureReasons.push(`citation count ${result.citations.length} below minimum ${testCase.minCitationCount}`);
  }

  if (testCase.maxCitationCount !== undefined && result.citations.length > testCase.maxCitationCount) {
    failureReasons.push(`citation count ${result.citations.length} above maximum ${testCase.maxCitationCount}`);
  }

  if (testCase.maxElapsedMs !== undefined && outcome.execution.elapsedMs > testCase.maxElapsedMs) {
    failureReasons.push(`elapsed ${outcome.execution.elapsedMs}ms exceeded ${testCase.maxElapsedMs}ms`);
  }

  return {
    id: testCase.id,
    question: testCase.question,
    repeatIndex,
    repeatCount,
    ok: failureReasons.length === 0,
    status: "success",
    lookupStatus: result.status,
    elapsedMs: outcome.execution.elapsedMs,
    elapsed: outcome.execution.elapsed,
    totalTokens: outcome.execution.usage.totalTokens,
    cost: outcome.execution.usage.cost,
    failureReasons,
    answer,
    citationFiles,
  };
}

function evaluateError(testCase: EvalCase, error: unknown, startedAtMs: number, repeatIndex = 1, repeatCount = 1): EvalCaseResult {
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const diagnostics = getLookupSessionDiagnostics(error);
  const usage = diagnostics?.usage ?? createEmptyLookupUsage();
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: testCase.id,
    question: testCase.question,
    repeatIndex,
    repeatCount,
    ok: false,
    status: "error",
    elapsedMs,
    elapsed: formatElapsed(elapsedMs),
    totalTokens: usage.totalTokens,
    cost: usage.cost,
    failureReasons: [message],
    citationFiles: [],
    error: message,
  };
}

function summarizeEvalRun(suite: EvalSuite, cases: EvalCaseResult[], ctx: any, kbRoot: string, uniqueCases: number, repeatCount: number): EvalRunResult {
  const totalElapsedMs = cases.reduce((sum, result) => sum + result.elapsedMs, 0);
  const totalTokens = cases.reduce((sum, result) => sum + result.totalTokens, 0);
  const totalCost = cases.reduce((sum, result) => sum + result.cost, 0);
  return {
    suite: suite.name,
    createdAt: new Date().toISOString(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(uses first available model)",
    thinkingLevel: RAINMAN_THINKING_LEVEL,
    kbRoot,
    cases,
    summary: {
      uniqueCases,
      repeatCount,
      total: cases.length,
      passed: cases.filter((result) => result.ok).length,
      failed: cases.filter((result) => !result.ok).length,
      averageElapsedMs: cases.length ? Math.round(totalElapsedMs / cases.length) : 0,
      totalTokens,
      totalCost,
    },
  };
}

function renderEvalRunMarkdown(run: EvalRunResult): string {
  const lines = [
    `# Rainman eval run ${run.createdAt}`,
    "",
    `- Suite: ${run.suite}`,
    `- Model: ${run.model}`,
    `- Thinking level: ${run.thinkingLevel}`,
    `- KB root: ${run.kbRoot}`,
    `- Passed: ${run.summary.passed}/${run.summary.total}`,
    `- Unique cases: ${run.summary.uniqueCases}`,
    `- Repeats per case: ${run.summary.repeatCount}`,
    `- Average elapsed: ${run.summary.averageElapsedMs}ms`,
    `- Total tokens: ${run.summary.totalTokens}`,
    `- Total cost: $${run.summary.totalCost.toFixed(6)}`,
    "",
    "| Case | Run | Result | Status | Elapsed | Tokens | Notes |",
    "| --- | ---: | --- | --- | ---: | ---: | --- |"
  ];

  for (const result of run.cases) {
    const notes = result.failureReasons.length ? result.failureReasons.join("; ") : result.citationFiles.join(", ");
    lines.push(
      `| ${result.id} | ${result.repeatIndex}/${result.repeatCount} | ${result.ok ? "pass" : "fail"} | ${result.lookupStatus ?? result.status} | ${result.elapsedMs}ms | ${result.totalTokens} | ${notes.replace(/\|/g, "\\|")} |`,
    );
  }

  lines.push("");
  lines.push("## Case details");
  for (const result of run.cases) {
    lines.push("");
    lines.push(`### ${result.id} (${result.repeatIndex}/${result.repeatCount})`);
    lines.push("");
    lines.push(`Question: ${result.question}`);
    lines.push("");
    if (result.answer) {
      lines.push("Answer:");
      lines.push("");
      lines.push(result.answer);
      lines.push("");
    }
    if (result.failureReasons.length) {
      lines.push("Failures:");
      lines.push(...result.failureReasons.map((reason) => `- ${reason}`));
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function writeEvalRunArtifacts(run: EvalRunResult): Promise<{ jsonPath: string; markdownPath: string }> {
  const resultsDir = getEvalResultsDir();
  await mkdir(resultsDir, { recursive: true });
  const stamp = run.createdAt.replace(/[:.]/g, "-");
  const stem = `${stamp}_${sanitizeEvalFileSegment(run.suite)}`;
  const jsonPath = path.join(resultsDir, `${stem}.json`);
  const markdownPath = path.join(resultsDir, `${stem}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderEvalRunMarkdown(run));
  return { jsonPath, markdownPath };
}

function truncateStatusText(value: string, maxLength = 80): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatStatusPath(value: string, maxLength = 72): string {
  const normalized = value.replace(/\\/g, "/").trim();
  if (normalized.length <= maxLength) return normalized;
  return `…${normalized.slice(-(maxLength - 1))}`;
}

function getStringArgument(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function describeLookupToolActivity(toolName: string, args: unknown): string {
  switch (toolName) {
    case "find": {
      const query = getStringArgument(args, ["query"]);
      return query
        ? `Rainman locating candidate fact files for "${truncateStatusText(query, 40)}"…`
        : "Rainman locating candidate fact files…";
    }
    case "grep": {
      const pattern = getStringArgument(args, ["pattern"]);
      return pattern
        ? `Rainman searching fact files for "${truncateStatusText(pattern, 40)}"…`
        : "Rainman searching fact files…";
    }
    case "read": {
      const filePath = getStringArgument(args, ["filePath"]);
      return filePath
        ? `Rainman reading ${formatStatusPath(filePath)}…`
        : "Rainman reading a fact file…";
    }
    case "submit_result":
      return "Rainman validating and submitting the evidence-backed result…";
    default:
      return `Rainman running ${toolName}…`;
  }
}

function createLookupProgressReporter(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  setActivity: (message: string | null, spinnerFrame?: string | null) => void,
  artifactContext?: {
    writer: LookupArtifactWriter;
    toolCallId: string;
    runId: string;
  },
) {
  const toolStartedAt = Date.now();
  let heartbeatId: NodeJS.Timeout | undefined;
  let spinnerIndex = 0;

  const buildUiMessage = (
    baseMessage: string,
    options?: {
      phaseElapsedMs?: number;
    },
  ): string => {
    const toolElapsedMs = Date.now() - toolStartedAt;
    const timingParts: string[] = [];
    if (options?.phaseElapsedMs !== undefined) {
      timingParts.push(`action ${formatElapsed(options.phaseElapsedMs)}`);
    }
    timingParts.push(`total ${formatElapsed(toolElapsedMs)}`);
    return `${baseMessage} (${timingParts.join(" · ")})`;
  };

  const emit = (
    message: string,
    details?: Record<string, unknown>,
    options?: {
      notify?: boolean;
      includeContent?: boolean;
      spinnerFrame?: string;
      phaseElapsedMs?: number;
    },
  ): void => {
    const toolElapsedMs = Date.now() - toolStartedAt;
    if (options?.includeContent ?? true) {
      onUpdate?.({
        content: [{ type: "text", text: message }],
        details: {
          phase: "progress",
          progressMessage: message,
          toolElapsedMs,
          ...(details ?? {}),
        },
      });
    }

    if (details?.phase !== "heartbeat" && artifactContext) {
      artifactContext.writer.appendBestEffort({
        ...buildLookupArtifactEntryBase(artifactContext.toolCallId, artifactContext.runId),
        entryType: "progress",
        message,
        details: {
          toolElapsedMs,
          ...(details ?? {}),
        },
      });
    }

    const uiMessage = buildUiMessage(message, options);
    setActivity(uiMessage, options?.spinnerFrame);
    if (options?.notify && ctx.hasUI) {
      ctx.ui.notify(message, "info");
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
      emit(
        baseMessage,
        {
          ...(details ?? {}),
          phase: "heartbeat",
          baseMessage,
          elapsedMs,
        },
        {
          includeContent: false,
          spinnerFrame: frame,
          phaseElapsedMs: elapsedMs,
        },
      );
    };

    tick();
    heartbeatId = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  };

  return {
    update(
      message: string,
      details?: Record<string, unknown>,
      options?: { notify?: boolean; includeContent?: boolean },
    ): void {
      stopHeartbeat();
      emit(message, details, options);
    },
    startHeartbeat,
    stopHeartbeat,
    clear(): void {
      stopHeartbeat();
      setActivity(null, null);
    },
  };
}

function getTextContentOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const blockRecord = block as Record<string, unknown>;
      return blockRecord.type === "text" && typeof blockRecord.text === "string"
        ? [blockRecord.text]
        : [];
    })
    .join("\n\n")
    .trim();

  return text ? normalizeNewlines(text) : undefined;
}

export function formatActionOutputTail(content: string, maxLines = 12, maxChars = 8 * 1024): string {
  const normalized = normalizeNewlines(content);
  const lines = normalized.split("\n");
  const tailLines = lines.slice(-maxLines);
  let text = tailLines.join("\n");
  let suffix: string | undefined;

  if (tailLines.length < lines.length) {
    const startLine = lines.length - tailLines.length + 1;
    suffix = `[showing lines ${startLine}-${lines.length} of ${lines.length}]`;
  }

  if (text.length > maxChars) {
    text = `…${text.slice(-(maxChars - 1))}`;
    suffix = suffix
      ? `${suffix}; truncated to last ${maxChars} chars`
      : `[truncated to last ${maxChars} chars]`;
  }

  return suffix ? `${text}\n\n${suffix}` : text;
}

function indentTextBlock(content: string): string {
  return content
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export function buildLookupActionOutput(toolName: string, result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const output = getTextContentOutput((result as { content?: unknown }).content);
  if (!output) return undefined;

  return [
    `Current action output (${toolName}):`,
    "",
    indentTextBlock(formatActionOutputTail(output)),
  ].join("\n");
}

function subscribeToLookupSessionEvents(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  progress: ReturnType<typeof createLookupProgressReporter>,
  attempt: number,
  maxAttempts: number,
  artifactContext?: {
    writer: LookupArtifactWriter;
    toolCallId: string;
    runId: string;
  },
): () => void {
  let activeActivityKey: string | undefined;

  const startActivity = (
    key: string,
    message: string,
    details?: Record<string, unknown>,
  ): void => {
    if (activeActivityKey === key) return;
    activeActivityKey = key;
    progress.startHeartbeat(message, {
      phase: "lookup-activity",
      attempt,
      maxAttempts,
      activityKey: key,
      timeoutMs: MAX_AGENT_EXECUTION_MS,
      ...(details ?? {}),
    });
  };

  const unsubscribe = session.subscribe((event: unknown) => {
    if (!event || typeof event !== "object") return;

    const eventRecord = event as Record<string, unknown>;
    const artifactEvent = buildLookupArtifactEvent(eventRecord, attempt, maxAttempts);
    if (artifactEvent && artifactContext) {
      artifactContext.writer.appendBestEffort({
        ...buildLookupArtifactEntryBase(artifactContext.toolCallId, artifactContext.runId),
        entryType: "lookup-event",
        event: artifactEvent,
      });
    }

    switch (eventRecord.type) {
      case "turn_start": {
        const turnIndex = typeof eventRecord.turnIndex === "number"
          ? eventRecord.turnIndex + 1
          : undefined;
        startActivity(
          `turn:${turnIndex ?? "unknown"}`,
          turnIndex
            ? `Rainman analyzing the knowledge base in turn ${turnIndex}…`
            : "Rainman analyzing the knowledge base…",
          { turnIndex },
        );
        break;
      }
      case "tool_execution_start": {
        const toolName = typeof eventRecord.toolName === "string"
          ? eventRecord.toolName
          : "tool";
        const toolCallId = typeof eventRecord.toolCallId === "string"
          ? eventRecord.toolCallId
          : toolName;
        const activityMessage = describeLookupToolActivity(toolName, eventRecord.args);
        startActivity(
          `tool:${toolCallId}`,
          activityMessage,
          {
            toolName,
            toolCallId,
          },
        );
        break;
      }
      case "tool_execution_update": {
        const toolName = typeof eventRecord.toolName === "string"
          ? eventRecord.toolName
          : "tool";
        const actionOutput = buildLookupActionOutput(
          toolName,
          eventRecord.partialResult,
        );
        if (actionOutput && artifactContext) {
          artifactContext.writer.appendBestEffort({
            ...buildLookupArtifactEntryBase(artifactContext.toolCallId, artifactContext.runId),
            entryType: "progress-content",
            content: actionOutput,
            details: {
              phase: "lookup-tool-output",
              attempt,
              maxAttempts,
              toolName,
              isPartial: true,
            },
          });
        }
        break;
      }
      case "message_update": {
        const assistantEvent = eventRecord.assistantMessageEvent;
        if (!assistantEvent || typeof assistantEvent !== "object") break;

        const assistantEventRecord = assistantEvent as Record<string, unknown>;
        if (assistantEventRecord.type === "thinking_delta") {
          startActivity("thinking", "Rainman reasoning about the knowledge base…");
          break;
        }

        if (
          assistantEventRecord.type === "text_delta" &&
          typeof assistantEventRecord.delta === "string" &&
          assistantEventRecord.delta.trim()
        ) {
          startActivity("drafting", "Rainman drafting the evidence-backed result…");
        }
        break;
      }
      case "tool_execution_end": {
        const toolName = typeof eventRecord.toolName === "string"
          ? eventRecord.toolName
          : "tool";
        const actionOutput = toolName === "submit_result"
          ? undefined
          : buildLookupActionOutput(toolName, eventRecord.result);
        progress.stopHeartbeat();
        activeActivityKey = undefined;

        if (actionOutput && artifactContext) {
          artifactContext.writer.appendBestEffort({
            ...buildLookupArtifactEntryBase(artifactContext.toolCallId, artifactContext.runId),
            entryType: "progress-content",
            content: actionOutput,
            details: {
              phase: "lookup-tool-output",
              attempt,
              maxAttempts,
              toolName,
              isError: Boolean(eventRecord.isError),
            },
          });
        }

        if (eventRecord.isError) {
          progress.update(
            `Rainman tool ${toolName} failed.`,
            {
              phase: "lookup-tool-error",
              attempt,
              maxAttempts,
              toolName,
              isError: true,
            },
            { includeContent: false },
          );
          break;
        }

        if (toolName === "submit_result") {
          progress.update(
            "Rainman submitted the evidence-backed result.",
            {
              phase: "lookup-submit",
              attempt,
              maxAttempts,
              toolName,
            },
            { includeContent: false },
          );
        }
        break;
      }
      case "auto_retry_start": {
        activeActivityKey = undefined;
        progress.update("Rainman model request auto-retrying…", {
          phase: "lookup-auto-retry",
          attempt,
          maxAttempts,
        });
        break;
      }
    }
  });

  return unsubscribe;
}

async function promptWithTimeout<T>(
  operation: Promise<T>,
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(async () => {
      try {
        await session.abort();
      } catch {
        // ignore abort failure
      }
      reject(new Error(`Rainman lookup timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        void session.abort().catch(() => {
          // ignore abort failure
        });
        reject(new Error("Operation aborted"));
      };

      if (signal.aborted) {
        abortListener();
        return;
      }

      signal.addEventListener("abort", abortListener, { once: true });
    })
    : undefined;

  try {
    return await Promise.race(
      [operation, timeoutPromise].concat(abortPromise ? [abortPromise] : []),
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function runVerification(
  question: string,
  kbRoot: string,
  model: any,
  modelRegistry: any,
  thinkingLevel: any,
  signal?: AbortSignal,
  progress?: ReturnType<typeof createLookupProgressReporter>,
  artifactContext?: {
    writer: LookupArtifactWriter;
    toolCallId: string;
    runId: string;
  },
): Promise<LookupOutcome> {
  const startedAtMs = Date.now();
  const submittedResultState = createSubmittedResultState();
  const modelName = `${model.provider}/${model.id}`;
  const fileIndex = buildFactFileIndex(kbRoot);
  progress?.update(
    `Indexing Rainman knowledge base (${fileIndex.validFiles.length} clean files, ${fileIndex.invalidFiles.length} malformed skipped)…`,
    {
      phase: "index-kb",
      validFiles: fileIndex.validFiles.length,
      invalidFiles: fileIndex.invalidFiles.length,
    },
    { includeContent: false },
  );
  const lookupTools = createCustomTools(kbRoot, modelName, submittedResultState, fileIndex);
  const lookupToolNames = lookupTools.map((tool) => tool.name);
  const resourceLoader = new DefaultResourceLoader({
    cwd: kbRoot,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  progress?.update(
    "Launching isolated Rainman lookup…",
    {
      phase: "launch-lookup",
      model: modelName,
      thinkingLevel,
      timeoutMs: MAX_AGENT_EXECUTION_MS,
    },
    { includeContent: false },
  );

  const createLookupSession = async () => {
    const { session } = await createAgentSession({
      cwd: kbRoot,
      agentDir: getAgentDir(),
      model,
      // Keep the isolated lookup agent's reasoning disabled for speed.
      // Rainman returns validated citations; the caller can do any higher-level reasoning.
      thinkingLevel,
      modelRegistry,
      noTools: "builtin",
      customTools: lookupTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: MAX_REPAIR_ATTEMPTS },
      }),
    });

    return {
      session,
      lookupToolAccess: buildLookupToolAccessRecord(session),
    };
  };

  const { session, lookupToolAccess: initialLookupToolAccess } = await createLookupSession();
  let lookupToolAccess = initialLookupToolAccess;

  const buildExecutionMeta = (): LookupExecutionMeta => {
    const completedAtMs = Date.now();
    const usage = buildLookupUsage(getSessionMessages(session), modelName);
    return {
      model: usage.model ?? modelName,
      kbRoot,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs: Math.max(0, completedAtMs - startedAtMs),
      elapsed: formatElapsed(completedAtMs - startedAtMs),
      usage,
    };
  };

  const finalizeResult = (result: VerificationResult): LookupOutcome => {
    const execution = buildExecutionMeta();
    return {
      result: {
        ...result,
        meta: {
          model: result.meta?.model ?? execution.model,
          kbRoot: result.meta?.kbRoot ?? kbRoot,
        },
      },
      execution,
      diagnostics: {
        messages: getSessionMessages(session),
        toolAccess: lookupToolAccess,
        usage: execution.usage,
      },
    };
  };

  try {
    const missingConfiguredToolNames = getMissingToolNames(
      lookupToolNames,
      lookupToolAccess.configuredToolNames,
    );
    if (missingConfiguredToolNames.length > 0) {
      // Keep going: some runtime paths expose custom tools only after the first
      // prompt. The active-tool check below will fail with diagnostics if the
      // lookup tools were not registered.
    }

    const maxAttempts = MAX_REPAIR_ATTEMPTS + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        progress?.update(
          `Repairing Rainman lookup result (attempt ${attempt - 1} of ${MAX_REPAIR_ATTEMPTS})…`,
          {
            phase: "repair-attempt",
            attempt,
            maxAttempts,
          },
        );
      }

      const prompt = attempt === 1 ? buildPrompt(question, fileIndex) : buildRepairPrompt(question, attempt - 1);
      const messageCountBeforePrompt = getSessionMessages(session).length;
      const unsubscribeLookupEvents = progress
        ? subscribeToLookupSessionEvents(session, progress, attempt, maxAttempts, artifactContext)
        : undefined;
      progress?.startHeartbeat("Rainman searching the knowledge base…", {
        phase: "lookup-running",
        attempt,
        maxAttempts,
        timeoutMs: MAX_AGENT_EXECUTION_MS,
      });
      // Return as soon as submit_result validates instead of waiting for a trailing assistant turn.
      const promptOutcome = session.prompt(prompt)
        .then<PromptAttemptResult>(() => ({ kind: "prompt-complete" }))
        .catch<PromptAttemptResult>((error: unknown) => ({ kind: "prompt-error", error }));
      const submittedOutcome = submittedResultState.wait.then<PromptAttemptResult>(() => ({ kind: "submitted" }));

      let outcome: PromptAttemptResult;
      try {
        outcome = await promptWithTimeout(
          Promise.race([promptOutcome, submittedOutcome]),
          session,
          MAX_AGENT_EXECUTION_MS,
          signal,
        );
      } catch (error) {
        unsubscribeLookupEvents?.();
        progress?.stopHeartbeat();
        if (submittedResultState.value) return finalizeResult(submittedResultState.value);
        throw error;
      }

      unsubscribeLookupEvents?.();
      progress?.stopHeartbeat();

      if (outcome.kind === "submitted") {
        const result = finalizeResult(submittedResultState.value!);
        await session.abort().catch(() => {
          // ignore abort failure after accepted result
        });
        return result;
      }

      if (outcome.kind === "prompt-error") {
        if (submittedResultState.value) return finalizeResult(submittedResultState.value);
        throw outcome.error;
      }

      if (submittedResultState.value) return finalizeResult(submittedResultState.value);

      lookupToolAccess = buildLookupToolAccessRecord(session);
      const missingActiveToolNames = getMissingToolNames(
        lookupToolNames,
        lookupToolAccess.activeToolNames,
      );
      const sessionMessages = getSessionMessages(session);
      const pseudoToolCallToolNames = getLookupPseudoToolCallToolNames(
        sessionMessages.slice(messageCountBeforePrompt),
      );

      if (
        missingActiveToolNames.length > 0 &&
        (pseudoToolCallToolNames || attempt === maxAttempts)
      ) {
        throw new Error(
          "Rainman lookup session did not activate the expected tools after prompting. " +
            `Missing active tools: ${missingActiveToolNames.join(", ")}. ` +
            `Active tools: ${lookupToolAccess.activeToolNames.join(", ") || "(none)"}. ` +
            `Configured tools: ${lookupToolAccess.configuredToolNames.join(", ") || "(none)"}.`,
        );
      }

      if (pseudoToolCallToolNames) {
        throw createLookupPseudoToolCallError(pseudoToolCallToolNames);
      }
    }
  } catch (error) {
    throw attachLookupSessionDiagnostics(error, session, modelName, lookupToolAccess);
  } finally {
    session.dispose();
  }

  return finalizeResult({
    status: "insufficient_evidence",
    data: {},
    citations: [],
    missingInformation: ["The lookup session did not produce a validated evidence-backed result."],
    warnings: ["The Rainman lookup session ended without submit_result.", ...fileIndex.warnings],
    meta: {
      model: modelName,
      kbRoot,
    },
  } satisfies VerificationResult);
}

function buildLookupToolResult(options: {
  outcome: LookupOutcome;
  artifact?: LookupArtifactRef;
  artifactWarning?: string;
}): LookupToolResult {
  return {
    ...options.outcome.result,
    result: options.outcome.result,
    execution: options.outcome.execution,
    diagnostics: options.outcome.diagnostics,
    artifact: options.artifact,
    artifactFormat: options.artifact ? "jsonl" : undefined,
    artifactWarning: options.artifactWarning,
  };
}

function buildLookupRunRecord(options: {
  toolCallId: string;
  runId: string;
  question: string;
  status: "success" | "error";
  outcome?: LookupOutcome;
  execution: LookupExecutionMeta;
  error?: unknown;
  diagnostics?: LookupDiagnostics;
  fileIndex?: FactFileIndex | null;
}): LookupRunRecord {
  return {
    version: 1,
    toolName: "rainman_lookup",
    toolCallId: options.toolCallId,
    runId: options.runId,
    createdAt: options.execution.completedAt,
    question: options.question,
    status: options.status,
    lookupStatus: options.outcome?.result.status,
    execution: options.execution,
    result: options.outcome?.result,
    error: options.error ? buildErrorRecord(options.error) : undefined,
    diagnostics: options.diagnostics ?? options.outcome?.diagnostics,
    fileIndex: options.fileIndex
      ? {
        validFiles: options.fileIndex.validFiles.length,
        invalidFiles: options.fileIndex.invalidFiles.length,
        warnings: options.fileIndex.warnings,
      }
      : undefined,
  };
}

function safeBuildFactFileIndex(
  kbRoot: string,
  buildIndex: typeof buildFactFileIndex = buildFactFileIndex,
): FactFileIndex | null {
  try {
    if (!fs.existsSync(kbRoot) || !fs.statSync(kbRoot).isDirectory()) return null;
    return buildIndex(kbRoot);
  } catch {
    return null;
  }
}

function buildExecutionMetaFromError(options: {
  startedAtMs: number;
  error: unknown;
  fallbackModel: string;
  kbRoot: string;
}): LookupExecutionMeta {
  const completedAtMs = Date.now();
  const diagnostics = getLookupSessionDiagnostics(options.error);
  const usage = diagnostics?.usage ?? createEmptyLookupUsage(options.fallbackModel);
  return {
    model: usage.model ?? options.fallbackModel,
    kbRoot: options.kbRoot,
    startedAt: new Date(options.startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    elapsedMs: Math.max(0, completedAtMs - options.startedAtMs),
    elapsed: formatElapsed(completedAtMs - options.startedAtMs),
    usage,
  };
}

async function executeLookupQuestion(
  question: string,
  signal: AbortSignal | undefined,
  ctx: any,
  progress?: ReturnType<typeof createLookupProgressReporter>,
  artifactContext?: {
    writer: LookupArtifactWriter;
    toolCallId: string;
    runId: string;
  },
): Promise<LookupOutcome> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("question must not be empty");
  }

  const kbRoot = getKbRoot();
  ensureKbReady(kbRoot);

  const availableModels = ctx.modelRegistry.getAvailable();
  const model = ctx.model ?? availableModels[0];
  if (!model) {
    throw new Error("No configured model is available for rainman_lookup.");
  }

  return await runVerification(
    trimmedQuestion,
    kbRoot,
    model,
    ctx.modelRegistry,
    RAINMAN_THINKING_LEVEL,
    signal,
    progress,
    artifactContext,
  );
}

type RainmanExtensionDeps = {
  executeLookupQuestion: typeof executeLookupQuestion;
  createLookupArtifactWriter: typeof createLookupArtifactWriter;
  getKbRoot: typeof getKbRoot;
  buildFactFileIndex: typeof buildFactFileIndex;
  listMarkdownFiles: typeof listMarkdownFiles;
  getLookupArtifactMode: typeof getLookupArtifactMode;
  now: () => number;
};

export function createRainmanExtension(
  overrides: Partial<RainmanExtensionDeps> = {},
): (pi: ExtensionAPI) => void {
  const deps: RainmanExtensionDeps = {
    executeLookupQuestion,
    createLookupArtifactWriter,
    getKbRoot,
    buildFactFileIndex,
    listMarkdownFiles,
    getLookupArtifactMode,
    now: () => Date.now(),
    ...overrides,
  };

  return function rainman(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    activeRuns: 0,
    activeActivities: new Map(),
    sessionQueries: 0,
    sessionHits: 0,
    sessionErrors: 0,
    lastRunAt: null,
    lastStatus: null,
    lastElapsedMs: null,
    lastTotalTokens: null,
    lastWarningCount: null,
    lastMalformedFileCount: null,
    lastArtifactPath: null,
  };

  function restoreSessionState(ctx: any): void {
    state.activeRuns = 0;
    state.activeActivities.clear();
    state.sessionQueries = 0;
    state.sessionHits = 0;
    state.sessionErrors = 0;
    state.lastRunAt = null;
    state.lastStatus = null;
    state.lastElapsedMs = null;
    state.lastTotalTokens = null;
    state.lastWarningCount = null;
    state.lastMalformedFileCount = null;
    state.lastArtifactPath = null;

    const branchEntries = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const entry of branchEntries) {
      if (entry?.type !== "custom" || entry?.customType !== QUERY_ENTRY_TYPE) continue;
      const data = entry.data as RainmanQueryEntry | undefined;
      if (!data) continue;

      state.sessionQueries += 1;
      if (data.hit) state.sessionHits += 1;
      if (data.isError) state.sessionErrors += 1;
      if (typeof data.ranAt === "number") state.lastRunAt = data.ranAt;
      state.lastStatus = data.isError ? "error" : data.status ?? state.lastStatus;
      if (typeof data.elapsedMs === "number") state.lastElapsedMs = data.elapsedMs;
      if (typeof data.totalTokens === "number") state.lastTotalTokens = data.totalTokens;
      if (typeof data.warningCount === "number") state.lastWarningCount = data.warningCount;
      if (typeof data.malformedFileCount === "number") state.lastMalformedFileCount = data.malformedFileCount;
      if (typeof data.artifactPath === "string") state.lastArtifactPath = data.artifactPath;
    }
  }

  function getDisplayedActivity(): { message: string; spinnerFrame: string | null } | undefined {
    const activeEntries = [...state.activeActivities.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const latest = activeEntries[0];
    return latest ? { message: latest.message, spinnerFrame: latest.spinnerFrame } : undefined;
  }

  function syncStatus(ctx: any): void {
    if (!ctx?.hasUI) return;

    const displayedActivity = getDisplayedActivity();
    const theme = ctx.ui.theme;
    const icon = state.activeRuns > 0 ? theme.fg("accent", "🌧") : theme.fg("success", "🌧");
    const counts = [
      theme.fg("dim", ` q:${state.sessionQueries}`),
      theme.fg("dim", ` h:${state.sessionHits}`),
      state.sessionErrors > 0 ? theme.fg("error", ` e:${state.sessionErrors}`) : theme.fg("dim", " e:0"),
    ].join("");
    const activity = state.activeRuns > 0
      ? theme.fg(
        "dim",
        displayedActivity
          ? ` ${displayedActivity.spinnerFrame ? `${displayedActivity.spinnerFrame} ` : ""}${displayedActivity.message}`
          : " looking up",
      )
      : "";

    ctx.ui.setStatus(STATUS_KEY, `${icon} ${counts}${activity}`);
    ctx.ui.setWorkingMessage(
      displayedActivity?.message
        ?? (state.activeRuns > 0 ? "Rainman lookup in progress" : undefined),
    );
  }

  function setActiveActivity(
    ctx: any,
    ownerId: string,
    message: string | null,
    spinnerFrame: string | null = null,
  ): void {
    if (message === null) {
      state.activeActivities.delete(ownerId);
    } else {
      state.activeActivities.set(ownerId, {
        message,
        spinnerFrame,
        updatedAt: Date.now(),
      });
    }
    syncStatus(ctx);
  }

  function recordQuery(entry: RainmanQueryEntry): void {
    state.sessionQueries += 1;
    if (entry.hit) state.sessionHits += 1;
    if (entry.isError) state.sessionErrors += 1;
    state.lastRunAt = entry.ranAt;
    state.lastStatus = entry.isError ? "error" : entry.status ?? state.lastStatus;
    state.lastElapsedMs = entry.elapsedMs ?? state.lastElapsedMs;
    state.lastTotalTokens = entry.totalTokens ?? state.lastTotalTokens;
    state.lastWarningCount = entry.warningCount ?? state.lastWarningCount;
    state.lastMalformedFileCount = entry.malformedFileCount ?? state.lastMalformedFileCount;
    state.lastArtifactPath = entry.artifactPath ?? state.lastArtifactPath;
    pi.appendEntry<RainmanQueryEntry>(QUERY_ENTRY_TYPE, entry);
  }

  pi.on("session_start", async (_event, ctx: any) => {
    restoreSessionState(ctx);
    syncStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx: any) => {
    restoreSessionState(ctx);
    syncStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx: any) => {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
  });

  pi.on("before_agent_start", async (event: any) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    if (!shouldNudgeRainmanLookup(prompt)) return;

    const systemPrompt = typeof event?.systemPrompt === "string"
      ? `${event.systemPrompt}\n\n${LOOKUP_POLICY_APPEND}`
      : LOOKUP_POLICY_APPEND;

    return { systemPrompt };
  });

  pi.registerTool({
    name: "rainman_lookup",
    label: "Rainman Lookup",
    description:
      "Check Raincatcher knowledge for stable previously-derived project knowledge before re-deriving it from code or files, and return only evidence-backed results with citations.",
    promptSnippet:
      "Look up stable previously-derived project knowledge in Raincatcher before re-deriving it from code or files.",
    promptGuidelines: [
      "Use this tool first for likely-stable questions about workflows, conventions, preferences, ownership, source-of-truth repos, paths, locations, cache behavior, prior conclusions, recurring explanations, or other previously-derived project knowledge captured in Raincatcher.",
      "If rainman_lookup returns status answered, use that evidence-backed result instead of re-deriving the same knowledge.",
      "If rainman_lookup returns status insufficient_evidence or conflict, continue with normal repo/code/log/db investigation.",
      "Do not use this tool first for live state, very recent changes, or current incidents.",
    ],
    parameters: LOOKUP_TOOL_PARAMS,
    async execute(toolCallId, params: Static<typeof LOOKUP_TOOL_PARAMS>, signal, onUpdate, ctx) {
      const startedAtMs = deps.now();
      const runId = randomUUID();
      const kbRoot = deps.getKbRoot();
      const fallbackModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(unknown model)";
      const artifactWriter = await deps.createLookupArtifactWriter({
        toolCallId,
        runId,
        question: params.question,
        mode: deps.getLookupArtifactMode(),
      });
      const artifactContext = {
        writer: artifactWriter,
        toolCallId,
        runId,
      };
      const progress = createLookupProgressReporter(
        onUpdate,
        ctx,
        (message, spinnerFrame) => setActiveActivity(ctx, runId, message, spinnerFrame ?? null),
        artifactContext,
      );
      let outcome: LookupOutcome | undefined;
      let toolResult: LookupToolResult | undefined;
      let finalError: unknown;
      let executionForRecord: LookupExecutionMeta | undefined;
      let diagnosticsForRecord: LookupDiagnostics | undefined;
      const fileIndexForRecord = safeBuildFactFileIndex(kbRoot, deps.buildFactFileIndex);

      if (artifactWriter.ref) {
        onUpdate?.({
          content: [],
          details: {
            phase: "artifact-created",
            toolCallId,
            artifact: artifactWriter.ref,
            debugMode: artifactWriter.mode,
          },
        });
      }

      state.activeRuns += 1;
      syncStatus(ctx);
      progress.update(
        "Starting Rainman lookup…",
        {
          phase: "start",
          timeoutMs: MAX_AGENT_EXECUTION_MS,
        },
        { notify: true },
      );

      try {
        outcome = await deps.executeLookupQuestion(params.question, signal, ctx, progress, artifactContext);
        executionForRecord = outcome.execution;
        diagnosticsForRecord = outcome.diagnostics;
        recordQuery({
          ranAt: deps.now(),
          status: outcome.result.status,
          hit: outcome.result.status === "answered",
          isError: false,
          elapsedMs: outcome.execution.elapsedMs,
          totalTokens: outcome.execution.usage.totalTokens,
          warningCount: outcome.result.warnings.length,
          malformedFileCount: fileIndexForRecord?.invalidFiles.length,
          artifactId: artifactWriter.mode === "always" ? artifactWriter.ref?.id : undefined,
          artifactPath: artifactWriter.mode === "always" ? artifactWriter.ref?.path : undefined,
        });
        const usageSummary = formatUsageSummary(outcome.execution.usage);
        const completionSummary = [outcome.execution.elapsed, usageSummary].filter(Boolean).join(" · ");
        progress.update(`rainman_lookup finished: ${outcome.result.status}${completionSummary ? ` (${completionSummary})` : ""}.`, {
          phase: "complete",
          status: outcome.result.status,
          elapsedMs: outcome.execution.elapsedMs,
          warnings: outcome.result.warnings.length,
          usage: outcome.execution.usage,
        });
        syncStatus(ctx);
      } catch (error) {
        finalError = error;
        diagnosticsForRecord = getLookupSessionDiagnostics(error);
        executionForRecord = buildExecutionMetaFromError({
          startedAtMs,
          error,
          fallbackModel,
          kbRoot,
        });
        recordQuery({
          ranAt: deps.now(),
          hit: false,
          isError: true,
          elapsedMs: executionForRecord.elapsedMs,
          totalTokens: executionForRecord.usage.totalTokens,
          malformedFileCount: fileIndexForRecord?.invalidFiles.length,
          artifactId: artifactWriter.ref?.id,
          artifactPath: artifactWriter.ref?.path,
        });
        const message = error instanceof Error ? error.message : String(error);
        progress.update(`rainman_lookup failed: ${message}`, {
          phase: "error",
          isError: true,
          elapsedMs: executionForRecord.elapsedMs,
          usage: executionForRecord.usage,
        });
        syncStatus(ctx);
      }

      const runRecord = buildLookupRunRecord({
        toolCallId,
        runId,
        question: params.question,
        status: finalError ? "error" : "success",
        outcome,
        execution: executionForRecord ?? buildExecutionMetaFromError({
          startedAtMs,
          error: finalError,
          fallbackModel,
          kbRoot,
        }),
        error: finalError,
        diagnostics: diagnosticsForRecord,
        fileIndex: fileIndexForRecord,
      });
      await artifactWriter.append({
        ...buildLookupArtifactEntryBase(toolCallId, runId),
        entryType: "run-finished",
        status: runRecord.status,
        record: runRecord,
      });
      await artifactWriter.flush();

      if (!finalError && artifactWriter.mode === "failure") {
        await artifactWriter.discard();
      }

      const artifactRef = artifactWriter.ref;
      const artifactWarning = artifactWriter.getWarning();
      if (artifactRef) {
        pi.appendEntry(RUN_ENTRY_TYPE, {
          toolCallId,
          runId,
          artifactId: artifactRef.id,
          artifactPath: artifactRef.path,
          artifactFormat: "jsonl",
          createdAt: runRecord.createdAt,
          status: runRecord.status,
          lookupStatus: outcome?.result.status,
          elapsedMs: runRecord.execution.elapsedMs,
          totalTokens: runRecord.execution.usage.totalTokens,
        });
        onUpdate?.({
          content: [],
          details: {
            phase: "artifact-finalized",
            toolCallId,
            artifact: artifactRef,
            status: runRecord.status,
          },
        });
      } else if (artifactWriter.mode === "failure" && !finalError) {
        onUpdate?.({
          content: [],
          details: {
            phase: "artifact-discarded",
            toolCallId,
            status: runRecord.status,
          },
        });
      }

      if (artifactWarning) {
        progress.update(
          `rainman_lookup artifact warning: ${artifactWarning}`,
          {
            phase: "artifact-error",
            isError: true,
          },
          { includeContent: false },
        );
      }

      state.activeRuns = Math.max(0, state.activeRuns - 1);
      progress.clear();
      syncStatus(ctx);

      if (finalError) {
        throw finalError;
      }

      if (!outcome) {
        throw new Error("rainman_lookup completed without producing a structured lookup result.");
      }

      toolResult = buildLookupToolResult({
        outcome,
        artifact: artifactRef,
        artifactWarning,
      });
      return {
        content: [{ type: "text", text: formatVerificationResult(outcome.result) }],
        details: toolResult,
      };
    },
  });

  pi.registerCommand("rainman", {
    description: "Show Rainman lookup status or run a smoke test",
    handler: async (args, ctx) => {
      const input = (args || "").trim();
      const [subcommandRaw] = input.split(/\s+/).filter(Boolean);
      const subcommand = (subcommandRaw ?? "").toLowerCase();

      if (!ctx.hasUI) return;

      if (subcommand === "eval") {
        const evalArgs = parseEvalArgs(input);
        const suitePath = resolveEvalSuitePath(evalArgs.suitePath);
        const suite = readEvalSuite(suitePath);
        const selectedCases = evalArgs.limit ? suite.cases.slice(0, evalArgs.limit) : suite.cases;
        const evalActivityOwner = `rainman-eval-${deps.now()}`;
        const caseResults: EvalCaseResult[] = [];
        state.activeRuns += 1;
        syncStatus(ctx);

        try {
          ctx.ui.notify(
            `Rainman eval started: ${suite.name} (${selectedCases.length}/${suite.cases.length} cases, n=${evalArgs.repeatCount}).`,
            "info",
          );
          for (const [index, testCase] of selectedCases.entries()) {
            for (let repeatIndex = 1; repeatIndex <= evalArgs.repeatCount; repeatIndex += 1) {
              setActiveActivity(
                ctx,
                evalActivityOwner,
                `Rainman eval ${index + 1}/${selectedCases.length} n=${repeatIndex}/${evalArgs.repeatCount}: ${truncateStatusText(testCase.id, 32)}…`,
                null,
              );
              const startedAtMs = Date.now();
              try {
                const outcome = await deps.executeLookupQuestion(testCase.question, ctx.signal, ctx);
                caseResults.push(evaluateOutcome(testCase, outcome, repeatIndex, evalArgs.repeatCount));
              } catch (error) {
                caseResults.push(evaluateError(testCase, error, startedAtMs, repeatIndex, evalArgs.repeatCount));
              }
            }
          }

          const run = summarizeEvalRun(suite, caseResults, ctx, deps.getKbRoot(), selectedCases.length, evalArgs.repeatCount);
          const artifacts = await writeEvalRunArtifacts(run);
          ctx.ui.notify(
            [
              `Rainman eval finished: ${run.summary.passed}/${run.summary.total} passed (${run.summary.uniqueCases} cases, n=${run.summary.repeatCount}).`,
              `Average elapsed: ${run.summary.averageElapsedMs}ms`,
              `Total tokens: ${run.summary.totalTokens}`,
              `Total cost: $${run.summary.totalCost.toFixed(6)}`,
              `JSON: ${artifacts.jsonPath}`,
              `Markdown: ${artifacts.markdownPath}`,
            ].join("\n"),
            run.summary.failed ? "warning" : "info",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Rainman eval failed: ${message}`, "warning");
        } finally {
          state.activeRuns = Math.max(0, state.activeRuns - 1);
          setActiveActivity(ctx, evalActivityOwner, null);
          syncStatus(ctx);
        }
        return;
      }

      if (subcommand === "test") {
        const selfTestActivityOwner = `rainman-test-${deps.now()}`;
        const progress = createLookupProgressReporter(
          undefined,
          ctx,
          (message, spinnerFrame) => setActiveActivity(ctx, selfTestActivityOwner, message, spinnerFrame ?? null),
        );
        state.activeRuns += 1;
        syncStatus(ctx);
        progress.update(
          "Rainman self-test started.",
          {
            phase: "start",
            timeoutMs: MAX_AGENT_EXECUTION_MS,
          },
          { notify: true, includeContent: false },
        );

        try {
          const outcome = await deps.executeLookupQuestion(
            RAINMAN_SELF_TEST_QUESTION,
            ctx.signal,
            ctx,
            progress,
          );
          const result = outcome.result;

          if (!isRainmanSelfTestPass(result)) {
            ctx.ui.notify(
              [
                "Rainman self-test failed: unexpected lookup result.",
                formatVerificationResult(result),
                ...result.warnings.map((warning) => `Warning: ${warning}`),
              ].join("\n"),
              "warning",
            );
            return;
          }

          const usageSummary = formatUsageSummary(outcome.execution.usage);
          ctx.ui.notify(
            [
              "Rainman self-test passed.",
              `Lookup status: ${result.status}`,
              `Lookup runtime: ${[outcome.execution.elapsed, usageSummary].filter(Boolean).join(" · ")}`,
              ...result.warnings.map((warning) => `Warning: ${warning}`),
            ].join("\n"),
            "info",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Rainman self-test failed: ${message}`, "warning");
        } finally {
          state.activeRuns = Math.max(0, state.activeRuns - 1);
          progress.clear();
          syncStatus(ctx);
        }
        return;
      }

      if (subcommand) {
        ctx.ui.notify(`Unknown rainman subcommand: ${subcommand}. Supported: test, eval`, "warning");
        return;
      }

      const kbRoot = deps.getKbRoot();
      const exists = fs.existsSync(kbRoot);
      const fileIndex = exists ? deps.buildFactFileIndex(kbRoot) : null;
      const fileCount = exists ? deps.listMarkdownFiles(kbRoot).length : 0;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(uses first available model)";
      const lastRun = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : "never";
      const lastElapsed = state.lastElapsedMs === null ? "none" : formatElapsed(state.lastElapsedMs);
      const lastTokens = state.lastTotalTokens === null ? "none" : formatTokenCount(state.lastTotalTokens);

      ctx.ui.notify(
        [
          `KB root: ${kbRoot}`,
          `Exists: ${exists ? "yes" : "no"}`,
          `Markdown files: ${fileCount}`,
          `Lint-clean fact files: ${fileIndex?.validFiles.length ?? 0}`,
          `Malformed fact files: ${fileIndex?.invalidFiles.length ?? 0}`,
          `Model: ${model}`,
          `Thinking level: ${RAINMAN_THINKING_LEVEL}`,
          `Session queries: ${state.sessionQueries}`,
          `Session hits: ${state.sessionHits}`,
          `Session errors: ${state.sessionErrors}`,
          `Last run: ${lastRun}`,
          `Last status: ${state.lastStatus ?? "none"}`,
          `Last elapsed: ${lastElapsed}`,
          `Last tokens: ${lastTokens}`,
          `Last warnings: ${state.lastWarningCount ?? "none"}`,
          `Last malformed files: ${state.lastMalformedFileCount ?? "none"}`,
          `Last artifact: ${state.lastArtifactPath ?? "none"}`,
          `Artifact mode: ${deps.getLookupArtifactMode()} (${DEBUG_ARTIFACTS_ENV_VAR})`,
          `KB root override env: ${KB_ROOT_ENV_VAR}`,
          ...(fileIndex?.warnings ?? []).map((warning) => `Warning: ${warning}`),
        ].join("\n"),
        exists ? "info" : "warning",
      );
    },
  });
  };
}

export default function rainman(pi: ExtensionAPI): void {
  return createRainmanExtension()(pi);
}
