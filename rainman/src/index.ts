import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type ExtensionAPI,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

type Citation = {
  path: string;
  file: string;
  startLine: number;
  endLine: number;
  quote: string;
};

type VerificationResult = {
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

type ReadOutput = {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
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

type ToolErrorDetails = Record<string, unknown> | undefined;

type ToolCallError = Error & {
  code?: string;
  details?: ToolErrorDetails;
};

const VERIFY_TOOL_PARAMS = Type.Object({
  question: Type.String({
    description: "Question or claim to verify against Raincatcher knowledge files.",
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

const DEFAULT_KB_ROOT = path.join(getAgentDir(), "data", "raincatcher");
const KB_ROOT_ENV_VAR = "PI_RAINMAN_KB_ROOT";
const QUERY_ENTRY_TYPE = "rainman-query";
const DEFAULT_READ_LIMIT = 200;
const DEFAULT_FIND_LIMIT = 20;
const DEFAULT_GREP_LIMIT = 20;
const RAINMAN_THINKING_LEVEL = "low" as const;
const MAX_REPAIR_ATTEMPTS = 1;
const MAX_AGENT_EXECUTION_MS = 20_000;

const SYSTEM_PROMPT = `You are a correctness-first verification agent.
You answer only from markdown files inside the configured knowledge root.
Use find and grep only for navigation.
Only read output counts as evidence.
Every populated field in data must have one or more exact citations.
If the knowledge base cannot safely answer, return status insufficient_evidence.
If relevant knowledge files conflict, return status conflict.
The only valid completion path is submit_result.
If submit_result succeeds, stop immediately and do not add extra text.
Prefer the smallest valid payload.
Use these response shapes:
- answered: data = {"answer":"..."}, citations = [{"path":"/data/answer", ...}], missingInformation = [], warnings = []
- insufficient_evidence: data = {}, citations = [], missingInformation = ["..."] if helpful, warnings = []
- conflict: data = {"conflicts":["...","..."]}, citations = [{"path":"/data/conflicts/0", ...}], missingInformation = [], warnings = []
For citations, quote must exactly match the cited file lines.`;

class ToolInputError extends Error {
  readonly code: string;
  readonly details?: ToolErrorDetails;

  constructor(code: string, message: string, details?: ToolErrorDetails) {
    super(message);
    this.name = "ToolInputError";
    this.code = code;
    this.details = details;
  }
}

class ResultValidationError extends Error {
  readonly code: string;
  readonly details?: ToolErrorDetails;

  constructor(code: string, message: string, details?: ToolErrorDetails) {
    super(message);
    this.name = "ResultValidationError";
    this.code = code;
    this.details = details;
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function splitIntoLines(value: string): string[] {
  const normalized = normalizeNewlines(value);
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
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
  const fromEnv = process.env[KB_ROOT_ENV_VAR]?.trim();
  return fromEnv ? path.resolve(fromEnv) : DEFAULT_KB_ROOT;
}

function ensureKbReady(kbRoot: string): void {
  if (!fs.existsSync(kbRoot)) {
    throw new Error(`Knowledge root does not exist: ${kbRoot}`);
  }

  if (!fs.statSync(kbRoot).isDirectory()) {
    throw new Error(`Knowledge root is not a directory: ${kbRoot}`);
  }
}

function ensureMarkdownRelativePath(filePath: string): void {
  if (!filePath.endsWith(".md")) {
    throw new ToolInputError("NON_MARKDOWN_FILE", "Only markdown files are allowed", { filePath });
  }

  if (path.isAbsolute(filePath)) {
    throw new ToolInputError("PATH_ESCAPE", "Absolute paths are not allowed", { filePath });
  }
}

function ensureWithinKbRoot(kbRoot: string, relativePath: string): string {
  const realKbRoot = fs.realpathSync.native(kbRoot);
  const candidatePath = path.resolve(realKbRoot, relativePath);
  const actualPath = fs.existsSync(candidatePath) ? fs.realpathSync.native(candidatePath) : candidatePath;
  const relative = path.relative(realKbRoot, actualPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolInputError("PATH_ESCAPE", "Path escapes knowledge root", {
      kbRoot: realKbRoot,
      relativePath,
    });
  }

  return actualPath;
}

function toKbRelativePath(kbRoot: string, absolutePath: string): string {
  const realKbRoot = fs.realpathSync.native(kbRoot);
  const actualPath = fs.existsSync(absolutePath) ? fs.realpathSync.native(absolutePath) : absolutePath;
  const relative = path.relative(realKbRoot, actualPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolInputError("PATH_ESCAPE", "Resolved path escapes knowledge root", { absolutePath });
  }

  return relative.split(path.sep).join("/");
}

function listMarkdownFiles(kbRoot: string): string[] {
  const entries: string[] = [];

  function walk(currentDir: string): void {
    const directoryEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of directoryEntries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      entries.push(toKbRelativePath(kbRoot, fullPath));
    }
  }

  walk(kbRoot);
  return entries.sort();
}

function readTool(kbRoot: string, input: Static<typeof readParameters>): ReadOutput {
  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_READ_LIMIT;

  if (!Number.isInteger(offset) || offset < 1) {
    throw new ToolInputError("INVALID_OFFSET", "offset must be a positive integer", { offset });
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new ToolInputError("INVALID_LIMIT", "limit must be a positive integer", { limit });
  }

  ensureMarkdownRelativePath(input.filePath);
  const absolutePath = ensureWithinKbRoot(kbRoot, input.filePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  const lines = splitIntoLines(content);
  const startIndex = Math.min(offset - 1, lines.length);
  const selectedLines = lines.slice(startIndex, startIndex + limit);
  const startLine = selectedLines.length > 0 ? startIndex + 1 : offset;
  const endLine = selectedLines.length > 0 ? startIndex + selectedLines.length : startIndex;

  return {
    filePath: toKbRelativePath(kbRoot, absolutePath),
    startLine,
    endLine,
    totalLines: lines.length,
    content: selectedLines.map((line, index) => `${startIndex + index + 1} | ${line}`).join("\n"),
  };
}

function findTool(kbRoot: string, input: Static<typeof findParameters>): string[] {
  const query = input.query.trim().toLowerCase();
  const limit = input.limit ?? DEFAULT_FIND_LIMIT;

  return listMarkdownFiles(kbRoot)
    .filter((file) => file.toLowerCase().includes(query))
    .slice(0, limit);
}

function grepTool(kbRoot: string, input: Static<typeof grepParameters>): GrepHit[] {
  const pattern = input.pattern.trim().toLowerCase();
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  if (!pattern) return [];

  const hits: GrepHit[] = [];
  for (const file of listMarkdownFiles(kbRoot)) {
    const content = fs.readFileSync(path.join(kbRoot, file), "utf8");
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

function readCitationLines(kbRoot: string, relativeFilePath: string, startLine: number, endLine: number): string {
  ensureMarkdownRelativePath(relativeFilePath);
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

function validateCitations(kbRoot: string, citations: Citation[]): void {
  for (const citation of citations) {
    if (!citation.path.startsWith("/data")) {
      throw new ResultValidationError("INVALID_CITATION_PATH", "Citation path must target /data", {
        path: citation.path,
      });
    }

    ensureMarkdownRelativePath(citation.file);
    ensureWithinKbRoot(kbRoot, citation.file);

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

function validateFieldCoverage(data: Record<string, unknown>, citations: Citation[]): void {
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

function validateResult(input: SubmitResultInput, context: ValidationContext): VerificationResult {
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

  validateCitations(context.kbRoot, input.citations);
  validateFieldCoverage(input.data, input.citations);

  if (status === "answered" && typeof input.data.answer !== "string") {
    throw new ResultValidationError("INVALID_SCHEMA", "answered results must populate data.answer", {
      status,
    });
  }

  if (status === "conflict") {
    if (!Array.isArray(input.data.conflicts) || input.data.conflicts.length === 0) {
      throw new ResultValidationError("INVALID_SCHEMA", "conflict results must populate data.conflicts", {
        status,
      });
    }

    for (const conflict of input.data.conflicts) {
      if (typeof conflict !== "string") {
        throw new ResultValidationError("INVALID_SCHEMA", "conflict entries must be strings", {
          status,
        });
      }
    }
  }

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

function formatReadResult(result: ReadOutput): string {
  const linesSection = result.content || "(no content in requested range)";
  return [
    `file: ${result.filePath}`,
    `startLine: ${result.startLine}`,
    `endLine: ${result.endLine}`,
    `totalLines: ${result.totalLines}`,
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

function buildPrompt(question: string): string {
  return [
    "Answer the question using only markdown evidence from the knowledge root.",
    "Use grep and find only for navigation.",
    "Use read to gather exact evidence.",
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

function summarizeCitations(citations: Citation[]): string[] {
  return citations.map((citation) => {
    const quote = citation.quote.replace(/\s+/g, " ").trim();
    const preview = quote.length > 120 ? `${quote.slice(0, 119).trimEnd()}…` : quote;
    return `- ${citation.path} -> ${citation.file}:${citation.startLine}-${citation.endLine} — ${preview}`;
  });
}

function formatVerificationResult(result: VerificationResult): string {
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
  submittedResult: { value?: VerificationResult },
): ToolDefinition[] {
  return [
    {
      name: "read",
      label: "Read",
      description: "Read a markdown file under the knowledge root and return stable line-numbered content.",
      promptSnippet: "read(filePath, offset?, limit?) - read markdown evidence with stable line numbers",
      promptGuidelines: [
        "Use read to gather evidence.",
        "Only read output counts as evidence.",
        "Citations must quote exact lines returned by read.",
      ],
      parameters: readParameters,
      execute: async (_toolCallId, params: Static<typeof readParameters>) => {
        try {
          const result = readTool(kbRoot, params);
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
          const result = findTool(kbRoot, params);
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
          const result = grepTool(kbRoot, params);
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
          const validated = validateResult(params as SubmitResultInput, { kbRoot, model: modelName });
          submittedResult.value = validated;
          return {
            content: [{ type: "text", text: "submit_result accepted. Stop now." }],
            details: validated,
          };
        } catch (error) {
          throw new Error(toToolErrorMessage(error));
        }
      },
    },
  ];
}

async function promptWithTimeout(
  operation: Promise<void>,
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  timeoutMs: number,
): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(async () => {
      try {
        await session.abort();
      } catch {
        // ignore abort failure
      }
      reject(new Error(`Verification timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function runVerification(question: string, kbRoot: string, model: any, modelRegistry: any, thinkingLevel: any) {
  const submittedResult: { value?: VerificationResult } = {};
  const modelName = `${model.provider}/${model.id}`;
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

  const { session } = await createAgentSession({
    cwd: kbRoot,
    agentDir: getAgentDir(),
    model,
    thinkingLevel,
    modelRegistry,
    tools: [],
    customTools: createCustomTools(kbRoot, modelName, submittedResult),
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: MAX_REPAIR_ATTEMPTS },
    }),
  });

  try {
    const maxAttempts = MAX_REPAIR_ATTEMPTS + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt = attempt === 1 ? buildPrompt(question) : buildRepairPrompt(question, attempt - 1);
      await promptWithTimeout(session.prompt(prompt), session, MAX_AGENT_EXECUTION_MS);
      if (submittedResult.value) return submittedResult.value;
    }
  } finally {
    session.dispose();
  }

  return {
    status: "insufficient_evidence",
    data: {},
    citations: [],
    missingInformation: ["The verifier did not produce a validated evidence-backed result."],
    warnings: ["The verification session ended without submit_result."],
    meta: {
      model: modelName,
      kbRoot,
    },
  } satisfies VerificationResult;
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
    const suffix = state.activeRuns > 0 ? theme.fg("dim", " verifying") : "";

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

  pi.registerTool({
    name: "rainman_verify",
    label: "Rainman Verify",
    description:
      "Verify a question or claim against Raincatcher knowledge files and return only evidence-backed results with citations.",
    promptSnippet: "Verify a claim or answer a narrow question using Raincatcher knowledge files.",
    promptGuidelines: [
      "Use this tool when you need to verify durable project, environment, workflow, or user-preference facts against Raincatcher knowledge.",
      "Prefer this tool over guessing when the answer might already be captured in Raincatcher markdown knowledge files.",
      "Treat answered results as verified only when the returned citations support the claim.",
    ],
    parameters: VERIFY_TOOL_PARAMS,
    async execute(_toolCallId, params: Static<typeof VERIFY_TOOL_PARAMS>, _signal, _onUpdate, ctx) {
      state.activeRuns += 1;
      syncStatus(ctx);

      try {
        const question = params.question.trim();
        if (!question) {
          throw new Error("question must not be empty");
        }

        const kbRoot = getKbRoot();
        ensureKbReady(kbRoot);

        const availableModels = ctx.modelRegistry.getAvailable();
        const model = ctx.model ?? availableModels[0];
        if (!model) {
          throw new Error("No configured model is available for rainman_verify.");
        }

        const result = await runVerification(question, kbRoot, model, ctx.modelRegistry, RAINMAN_THINKING_LEVEL);
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
    description: "Show Rainman verifier status",
    handler: async (_args, ctx) => {
      const kbRoot = getKbRoot();
      const exists = fs.existsSync(kbRoot);
      const fileCount = exists ? listMarkdownFiles(kbRoot).length : 0;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(uses first available model)";
      const lastRun = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : "never";

      if (!ctx.hasUI) return;
      ctx.ui.notify(
        [
          `KB root: ${kbRoot}`,
          `Exists: ${exists ? "yes" : "no"}`,
          `Markdown files: ${fileCount}`,
          `Model: ${model}`,
          `Thinking level: ${RAINMAN_THINKING_LEVEL}`,
          `Session queries: ${state.sessionQueries}`,
          `Session hits: ${state.sessionHits}`,
          `Session errors: ${state.sessionErrors}`,
          `Last run: ${lastRun}`,
          `Last status: ${state.lastStatus ?? "none"}`,
          `KB root override env: ${KB_ROOT_ENV_VAR}`,
        ].join("\n"),
        exists ? "info" : "warning",
      );
    },
  });
}
