import fs from "node:fs";
import { Type, type Static } from "typebox";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type ExtensionAPI,
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
};

type RuntimeState = {
  activeRuns: number;
  sessionQueries: number;
  sessionHits: number;
  sessionErrors: number;
  lastRunAt: number | null;
  lastStatus: string | null;
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

type LookupToolAccessRecord = {
  activeToolNames: string[];
  configuredToolNames: string[];
};

type ToolErrorDetails = Record<string, unknown> | undefined;

type ToolCallError = Error & {
  code?: string;
  details?: ToolErrorDetails;
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
const DEFAULT_READ_LIMIT = 200;
const DEFAULT_FIND_LIMIT = 20;
const DEFAULT_GREP_LIMIT = 20;
const RAINMAN_THINKING_LEVEL = "low" as const;
const MAX_REPAIR_ATTEMPTS = 1;
const MAX_AGENT_EXECUTION_MS = 45_000;
const RAINMAN_SELF_TEST_QUESTION =
  "__rainman_self_test__ Return insufficient_evidence unless a lint-clean knowledge file literally answers this exact string.";
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
- Rainman is a knowledge cache of stable, previously-derived project understanding captured in Raincatcher markdown files.
- Answer only from lint-clean markdown files inside the configured knowledge root.
- Use find and grep only for navigation.
- Only read output counts as evidence.
- The read tool returns raw line-numbered content plus parsed structured fact summaries for the requested range.
- Every populated field in data must have one or more exact citations.
- If the knowledge base cannot safely answer, return status insufficient_evidence so the caller can continue with normal investigation.
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
For citations, quote must exactly match the cited file lines.`;

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
  return {
    activeToolNames: getRegisteredToolNames(session?.state?.tools),
    configuredToolNames: typeof session?.getAllTools === "function"
      ? getRegisteredToolNames(session.getAllTools())
      : [],
  };
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

function buildPrompt(question: string, fileIndex: FactFileIndex): string {
  return [
    "Answer the question using only markdown evidence from the knowledge root.",
    "Use grep and find only for navigation.",
    "Use read to gather exact evidence from lint-clean structured fact files.",
    `Available structured fact files: ${fileIndex.validFiles.length}`,
    `Malformed fact files unavailable as evidence: ${fileIndex.invalidFiles.length}`,
    "Prefer the smallest valid data payload.",
    "For a normal direct answer, use data.answer and cite /data/answer.",
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
        "submit_result(status, data, citations, missingInformation, warnings) - finalize only when every populated data field is fully supported",
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
) {
  const submittedResultState = createSubmittedResultState();
  const modelName = `${model.provider}/${model.id}`;
  const fileIndex = buildFactFileIndex(kbRoot);
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

  const createLookupSession = async () => {
    const { session } = await createAgentSession({
      cwd: kbRoot,
      agentDir: getAgentDir(),
      model,
      // Keep the isolated lookup agent at low reasoning effort; higher
      // settings make it more likely to roleplay tool syntax.
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
      const prompt = attempt === 1 ? buildPrompt(question, fileIndex) : buildRepairPrompt(question, attempt - 1);
      const messageCountBeforePrompt = getSessionMessages(session).length;
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
        if (submittedResultState.value) return submittedResultState.value;
        throw error;
      }

      if (outcome.kind === "submitted") {
        await session.abort().catch(() => {
          // ignore abort failure after accepted result
        });
        return submittedResultState.value!;
      }

      if (outcome.kind === "prompt-error") {
        if (submittedResultState.value) return submittedResultState.value;
        throw outcome.error;
      }

      if (submittedResultState.value) return submittedResultState.value;

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
  } finally {
    session.dispose();
  }

  return {
    status: "insufficient_evidence",
    data: {},
    citations: [],
    missingInformation: ["The lookup session did not produce a validated evidence-backed result."],
    warnings: ["The Rainman lookup session ended without submit_result.", ...fileIndex.warnings],
    meta: {
      model: modelName,
      kbRoot,
    },
  } satisfies VerificationResult;
}

async function executeLookupQuestion(
  question: string,
  signal: AbortSignal | undefined,
  ctx: any,
): Promise<VerificationResult> {
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
  );
}

export default function rainman(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    activeRuns: 0,
    sessionQueries: 0,
    sessionHits: 0,
    sessionErrors: 0,
    lastRunAt: null,
    lastStatus: null,
  };

  function restoreSessionState(ctx: any): void {
    state.activeRuns = 0;
    state.sessionQueries = 0;
    state.sessionHits = 0;
    state.sessionErrors = 0;
    state.lastRunAt = null;
    state.lastStatus = null;

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
    }
  }

  function syncStatus(ctx: any): void {
    if (!ctx?.hasUI) return;

    const theme = ctx.ui.theme;
    const icon = state.activeRuns > 0 ? theme.fg("accent", "🌧") : theme.fg("success", "🌧");
    const counts = [
      theme.fg("dim", ` q:${state.sessionQueries}`),
      theme.fg("dim", ` h:${state.sessionHits}`),
      state.sessionErrors > 0 ? theme.fg("error", ` e:${state.sessionErrors}`) : theme.fg("dim", " e:0"),
    ].join("");
    const suffix = state.activeRuns > 0 ? theme.fg("dim", " looking up") : "";

    ctx.ui.setStatus("rainman", `${icon} ${counts}${suffix}`);
  }

  function recordQuery(entry: RainmanQueryEntry): void {
    state.sessionQueries += 1;
    if (entry.hit) state.sessionHits += 1;
    if (entry.isError) state.sessionErrors += 1;
    state.lastRunAt = entry.ranAt;
    state.lastStatus = entry.isError ? "error" : entry.status ?? state.lastStatus;
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
    ctx.ui.setStatus("rainman", undefined);
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
    async execute(_toolCallId, params: Static<typeof LOOKUP_TOOL_PARAMS>, signal, _onUpdate, ctx) {
      state.activeRuns += 1;
      syncStatus(ctx);

      try {
        const result = await executeLookupQuestion(params.question, signal, ctx);
        recordQuery({
          ranAt: Date.now(),
          status: result.status,
          hit: result.status === "answered",
          isError: false,
        });
        syncStatus(ctx);

        return {
          content: [{ type: "text", text: formatVerificationResult(result) }],
          details: result,
        };
      } catch (error) {
        recordQuery({
          ranAt: Date.now(),
          hit: false,
          isError: true,
        });
        syncStatus(ctx);
        throw error;
      } finally {
        state.activeRuns = Math.max(0, state.activeRuns - 1);
        syncStatus(ctx);
      }
    },
  });

  pi.registerCommand("rainman", {
    description: "Show Rainman lookup status or run a smoke test",
    handler: async (args, ctx) => {
      const input = (args || "").trim();
      const [subcommandRaw] = input.split(/\s+/).filter(Boolean);
      const subcommand = (subcommandRaw ?? "").toLowerCase();

      if (!ctx.hasUI) return;

      if (subcommand === "test") {
        state.activeRuns += 1;
        syncStatus(ctx);
        ctx.ui.notify("Rainman self-test started.", "info");

        try {
          const result = await executeLookupQuestion(
            RAINMAN_SELF_TEST_QUESTION,
            ctx.signal,
            ctx,
          );

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

          ctx.ui.notify(
            [
              "Rainman self-test passed.",
              `Lookup status: ${result.status}`,
              ...result.warnings.map((warning) => `Warning: ${warning}`),
            ].join("\n"),
            "info",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Rainman self-test failed: ${message}`, "warning");
        } finally {
          state.activeRuns = Math.max(0, state.activeRuns - 1);
          syncStatus(ctx);
        }
        return;
      }

      if (subcommand) {
        ctx.ui.notify(`Unknown rainman subcommand: ${subcommand}. Supported: test`, "warning");
        return;
      }

      const kbRoot = getKbRoot();
      const exists = fs.existsSync(kbRoot);
      const fileIndex = exists ? buildFactFileIndex(kbRoot) : null;
      const fileCount = exists ? listMarkdownFiles(kbRoot).length : 0;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(uses first available model)";
      const lastRun = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : "never";

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
          `KB root override env: ${KB_ROOT_ENV_VAR}`,
          ...(fileIndex?.warnings ?? []).map((warning) => `Warning: ${warning}`),
        ].join("\n"),
        exists ? "info" : "warning",
      );
    },
  });
}
