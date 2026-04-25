import fs from "node:fs";
import { completeSimple, type AssistantMessage, type ThinkingLevel } from "@mariozechner/pi-ai";
import { keyText, getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Spacer, Text } from "@mariozechner/pi-tui";
import {
  KB_ROOT_ENV_VAR,
  getKbRoot,
  lintKnowledgeBase,
  lintKnowledgeBaseSemanticCleanup,
  parseStructuredFactBulletText,
  renderStructuredFactBullet,
} from "@zsaplan/rain-core";
import {
  type DistillProgress,
  type DistillProgressStage,
  type DistillRequest,
  type DistillResult,
  type DuplicateGroup,
  type DuplicateGroupDecision,
  distillKnowledgeFiles,
} from "./distill.ts";
import {
  SEMANTIC_CLEANUP_SYSTEM_PROMPT,
  buildSemanticCleanupPrompt,
  parseSemanticCleanupProposal,
  type SemanticCleanupProposal,
  type SemanticCleanupProposalRequest,
} from "./semanticCleanup.ts";

type RaincatcherFilesWrittenEvent = {
  kbRoot?: string;
  filesWritten?: string[];
};

export type SemanticCleanupMode = "off" | "manual_only" | "all";

type DistillRunEntry = {
  ranAt: number;
  source: "auto" | "manual";
  scannedFiles: number;
  modifiedFiles: string[];
  duplicatesRemoved: number;
  duplicateGroups: number;
  semanticIssuesResolved: number;
  semanticFilesModified: string[];
  warnings: number;
  modelName?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  semanticCleanupMode: SemanticCleanupMode;
  semanticCleanupEnabled: boolean;
};

type RuntimeState = {
  autoEnabled: boolean;
  busy: boolean;
  progressStage: DistillProgressStage | null;
  progressProcessed: number;
  progressTotal: number;
  pendingFiles: string[];
  sessionRuns: number;
  sessionDuplicatesRemoved: number;
  sessionSemanticIssuesResolved: number;
  sessionModifiedFiles: string[];
  currentLintWarnings: number | null;
  currentStructuralIssues: number | null;
  currentSemanticWarnings: number | null;
  lastRunAt: number | null;
  lastDuplicatesRemoved: number;
  lastSemanticIssuesResolved: number;
  lastModifiedFiles: string[];
  lastSemanticFilesModified: string[];
  lastDuplicateGroups: number;
  lastWarnings: number;
  lastSource: "auto" | "manual" | null;
  lastModelName: string | null;
  lastThinkingLevel: ThinkingLevel | null;
  lastSemanticCleanupMode: SemanticCleanupMode | null;
  lastSemanticCleanupEnabled: boolean | null;
};

type ResolvedModel = {
  model: any;
  apiKey?: string;
  headers?: Record<string, string>;
  modelName: string;
};

type DistillSummaryMessageDetails = {
  summaryText: string;
};

const RUN_ENTRY_TYPE = "raindistiller-run";
const RUN_MESSAGE_TYPE = "raindistiller-summary";
const MANUAL_THINKING_LEVEL = "xhigh" as const;
const AUTO_THINKING_LEVEL = "medium" as const;
const DEFAULT_SEMANTIC_CLEANUP_MODE = "manual_only" as const;
const SEMANTIC_CLEANUP_MODE_ENV_VAR = "RAINDISTILLER_SEMANTIC_CLEANUP_MODE";
const MAX_ADJUDICATION_ATTEMPTS = 2;

const ADJUDICATION_SYSTEM_PROMPT = `You are Raindistiller, a conservative knowledge-base dedupe reviewer.

You will be given one candidate duplicate group found across markdown KB files.
Some groups are exact matches and some are near-duplicate lexical matches.
Decide whether the entries are truly duplicate durable facts in context.

Return JSON only. No markdown. No code fences.
Use exactly one of these shapes:
{"action":"dedupe","keepOccurrenceId":"OCCURRENCE_ID","reason":"one short sentence"}
{"action":"keep_all","reason":"one short sentence"}

Rules:
- Be conservative.
- Use keep_all if the occurrences might carry materially different meaning or scope.
- Use dedupe only when the occurrences clearly express the same durable fact.
- keepOccurrenceId must exactly match one provided occurrenceId.
- Prefer keeping a non-selected existing KB occurrence over a selected occurrence when equally canonical.
- Prefer valid structured occurrences over malformed or legacy occurrences when the fact is otherwise the same.
- Prefer more specific and authoritative-looking file context over generic context.
- Never invent an occurrenceId.`;

const ADJUDICATION_REPAIR_SYSTEM_PROMPT = `You repair malformed Raindistiller duplicate-group adjudication outputs.

Return JSON only. No markdown. No code fences.
Use exactly one of these shapes:
{"action":"dedupe","keepOccurrenceId":"OCCURRENCE_ID","reason":"one short sentence"}
{"action":"keep_all","reason":"one short sentence"}

Rules:
- Preserve the prior answer when it is recoverable.
- If the prior answer is empty, truncated, or unusable, make a fresh conservative decision from the supplied group context.
- keepOccurrenceId must exactly match one provided occurrenceId.
- Prefer keep_all over guessing.
- Never invent an occurrenceId.`;

function getSessionKbRoot(): string {
  return getKbRoot(getAgentDir());
}

function ensureKbReady(kbRoot: string): void {
  if (!fs.existsSync(kbRoot)) {
    throw new Error(`Knowledge root does not exist: ${kbRoot}`);
  }

  if (!fs.statSync(kbRoot).isDirectory()) {
    throw new Error(`Knowledge root is not a directory: ${kbRoot}`);
  }
}

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;

  for (const match of input.matchAll(regex)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(value.replace(/\\(["'\\])/g, "$1"));
  }

  return tokens;
}

function isDistillOptionToken(token: string | undefined): boolean {
  return token === "--file"
    || token === "-f"
    || token === "--dir"
    || token === "--directory"
    || token === "-d"
    || token === "--no-recursive"
    || token === "--recursive"
    || token === "--semantic-cleanup"
    || token === "--no-semantic-cleanup";
}

export function parseDistillArgs(input: string): {
  files: string[];
  directories: string[];
  recursive: boolean;
  semanticCleanupOverride: boolean | null;
  warnings: string[];
} {
  const files: string[] = [];
  const directories: string[] = [];
  const warnings: string[] = [];
  const tokens = tokenizeArgs(input);
  let recursive = true;
  let semanticCleanupOverride: boolean | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1];

    if (token === "--file" || token === "-f") {
      if (!next || isDistillOptionToken(next)) {
        warnings.push("Missing path after --file");
        continue;
      }
      files.push(next);
      index += 1;
      continue;
    }

    if (token === "--dir" || token === "--directory" || token === "-d") {
      if (!next || isDistillOptionToken(next)) {
        warnings.push("Missing path after --dir");
        continue;
      }
      directories.push(next);
      index += 1;
      continue;
    }

    if (token === "--no-recursive") {
      recursive = false;
      continue;
    }

    if (token === "--recursive") {
      recursive = true;
      continue;
    }

    if (token === "--semantic-cleanup") {
      semanticCleanupOverride = true;
      continue;
    }

    if (token === "--no-semantic-cleanup") {
      semanticCleanupOverride = false;
      continue;
    }

    if (token.endsWith(".md")) {
      files.push(token);
      continue;
    }

    directories.push(token);
  }

  if (files.length === 0 && directories.length === 0) directories.push(".");

  return { files, directories, recursive, semanticCleanupOverride, warnings };
}

function getThinkingLevel(source: "auto" | "manual"): ThinkingLevel {
  return source === "manual" ? MANUAL_THINKING_LEVEL : AUTO_THINKING_LEVEL;
}

function extractMessageText(message: AssistantMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((part): string[] => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as { type?: string; text?: string };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("\n")
    .trim();
}

export function parseDuplicateGroupDecision(text: string): DuplicateGroupDecision {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  const jsonText = objectMatch ? objectMatch[0] : cleaned;
  const parsed = JSON.parse(jsonText) as DuplicateGroupDecision;

  if (!parsed || typeof parsed !== "object") throw new Error("Model returned a non-object decision");
  if (parsed.action !== "dedupe" && parsed.action !== "keep_all") throw new Error("Model returned an invalid action");
  if (parsed.action === "dedupe" && typeof parsed.keepOccurrenceId !== "string") {
    throw new Error("Model returned dedupe without keepOccurrenceId");
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== "string") {
    throw new Error("Model returned a non-string reason");
  }

  return parsed;
}

type DuplicateDecisionRequest =
  | {
    kind: "adjudicate";
    group: DuplicateGroup;
  }
  | {
    kind: "repair";
    group: DuplicateGroup;
    invalidResponse: string;
    parseError: string;
  };

type DuplicateDecisionResponder = (request: DuplicateDecisionRequest) => Promise<string>;

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildAdjudicationRepairPrompt(request: Extract<DuplicateDecisionRequest, { kind: "repair" }>): string {
  const invalidResponse = request.invalidResponse.trim();
  const occurrenceIds = request.group.occurrences.map((occurrence) => occurrence.id);

  return [
    "Repair or regenerate a valid duplicate-group decision.",
    `Previous parse error: ${request.parseError}`,
    `Allowed occurrenceIds: ${occurrenceIds.length > 0 ? occurrenceIds.join(", ") : "(none)"}`,
    "",
    "Malformed response:",
    "<response>",
    invalidResponse.length > 0 ? invalidResponse : "(empty)",
    "</response>",
    "",
    "Candidate group context:",
    buildAdjudicationPrompt(request.group),
  ].join("\n");
}

export async function resolveDuplicateGroupDecision(
  group: DuplicateGroup,
  responder: DuplicateDecisionResponder,
): Promise<DuplicateGroupDecision> {
  let lastError: unknown = new Error("No duplicate-group adjudication response received.");

  for (let attempt = 0; attempt < MAX_ADJUDICATION_ATTEMPTS; attempt += 1) {
    const responseText = await responder({ kind: "adjudicate", group });
    try {
      return parseDuplicateGroupDecision(responseText);
    } catch (error) {
      lastError = error;
    }

    try {
      const repairedText = await responder({
        kind: "repair",
        group,
        invalidResponse: responseText,
        parseError: formatErrorMessage(lastError),
      });
      return parseDuplicateGroupDecision(repairedText);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(formatErrorMessage(lastError));
}

function describeStructuredOccurrence(text: string): {
  canonical: string;
  relation: string;
  object: string;
  qualifiers: string[];
} | null {
  try {
    const parsed = parseStructuredFactBulletText(text);
    return {
      canonical: renderStructuredFactBullet(parsed),
      relation: parsed.relation,
      object: parsed.object,
      qualifiers: parsed.qualifiers.map((qualifier) => `${qualifier.key}=${qualifier.value}`),
    };
  } catch {
    return null;
  }
}

function buildAdjudicationPrompt(group: DuplicateGroup): string {
  const structuredById = new Map(group.occurrences.map((occurrence) => [occurrence.id, describeStructuredOccurrence(occurrence.text)]));

  const renderedOccurrences = group.occurrences
    .map((occurrence, index) => {
      const structured = structuredById.get(occurrence.id) ?? null;
      return [
        `Occurrence ${index + 1}`,
        `occurrenceId: ${occurrence.id}`,
        `filePath: ${occurrence.filePath}`,
        `selected: ${occurrence.selected ? "true" : "false"}`,
        `heading: ${occurrence.heading ?? "(none)"}`,
        `lineNumber: ${occurrence.lineNumber}`,
        `normalized: ${occurrence.normalized}`,
        `fact: ${occurrence.text}`,
        `structured: ${structured ? "valid" : "invalid_or_legacy"}`,
        ...(structured
          ? [
            `canonicalStructured: ${structured.canonical}`,
            `relation: ${structured.relation}`,
            `object: ${structured.object}`,
            `qualifiers: ${structured.qualifiers.length > 0 ? structured.qualifiers.join(", ") : "(none)"}`,
          ]
          : []),
      ].join("\n");
    })
    .join("\n\n");

  const strongestPairs = group.strongestPairs.length > 0
    ? group.strongestPairs.map((pair, index) => {
      const leftStructured = structuredById.get(pair.leftId) ?? null;
      const rightStructured = structuredById.get(pair.rightId) ?? null;
      const structuredExact = leftStructured && rightStructured
        ? leftStructured.canonical === rightStructured.canonical
        : null;

      return [
        `Pair ${index + 1}`,
        `leftId: ${pair.leftId}`,
        `rightId: ${pair.rightId}`,
        `exactNormalized: ${pair.similarity.exactNormalized ? "true" : "false"}`,
        `structuredExact: ${structuredExact === null ? "unknown" : structuredExact ? "true" : "false"}`,
        `sharedTokenCount: ${pair.similarity.sharedTokenCount}`,
        `tokenJaccard: ${pair.similarity.tokenJaccard.toFixed(2)}`,
        `trigramJaccard: ${pair.similarity.trigramJaccard.toFixed(2)}`,
        `levenshteinSimilarity: ${pair.similarity.levenshteinSimilarity.toFixed(2)}`,
        `headingJaccard: ${pair.similarity.headingJaccard.toFixed(2)}`,
        `composite: ${pair.similarity.composite.toFixed(2)}`,
      ].join("\n");
    }).join("\n\n")
    : "(none)";

  return [
    "Review this candidate duplicate fact group.",
    "If these occurrences are the same durable fact in context, choose one keepOccurrenceId.",
    "If the occurrences differ materially in scope, meaning, or ownership, keep_all.",
    "Prefer keeping non-selected existing KB occurrences over selected occurrences when equally canonical.",
    "Prefer valid structured occurrences over malformed or legacy occurrences when the fact is otherwise the same.",
    "",
    `Group id: ${group.id}`,
    `Group kind: ${group.kind}`,
    `Representative fact text: ${group.representativeFact}`,
    `Max similarity composite: ${group.maxComposite.toFixed(2)}`,
    "",
    "Occurrences:",
    renderedOccurrences,
    "",
    "Strongest supporting pairs:",
    strongestPairs,
  ].join("\n");
}

function isSemanticCleanupMode(value: unknown): value is SemanticCleanupMode {
  return value === "off" || value === "manual_only" || value === "all";
}

export function getConfiguredSemanticCleanupMode(): { mode: SemanticCleanupMode; warning?: string } {
  const raw = (process.env[SEMANTIC_CLEANUP_MODE_ENV_VAR] ?? DEFAULT_SEMANTIC_CLEANUP_MODE).trim().toLowerCase();
  if (raw.length === 0) {
    return { mode: DEFAULT_SEMANTIC_CLEANUP_MODE };
  }

  if (isSemanticCleanupMode(raw)) {
    return { mode: raw };
  }

  return {
    mode: DEFAULT_SEMANTIC_CLEANUP_MODE,
    warning: `Invalid ${SEMANTIC_CLEANUP_MODE_ENV_VAR}='${raw}'; using ${DEFAULT_SEMANTIC_CLEANUP_MODE}.`,
  };
}

export function isSemanticCleanupEnabled(
  mode: SemanticCleanupMode,
  source: "auto" | "manual",
  override: boolean | null | undefined,
): boolean {
  if (override === true) return true;
  if (override === false) return false;
  if (mode === "off") return false;
  if (mode === "all") return true;
  return source === "manual";
}

export function extractRaincatcherFilesWritten(event: unknown): string[] {
  const raincatcherEvent = event as RaincatcherFilesWrittenEvent | undefined;
  return Array.isArray(raincatcherEvent?.filesWritten)
    ? raincatcherEvent.filesWritten.filter((file): file is string => typeof file === "string")
    : [];
}

function formatSemanticCleanupMode(mode: SemanticCleanupMode): string {
  if (mode === "manual_only") return "manual_only";
  return mode;
}

function formatProgressStage(stage: DistillProgressStage): string {
  switch (stage) {
    case "initial_dedupe":
      return "dedupe";
    case "semantic_cleanup":
      return "semantic";
    case "post_semantic_dedupe":
      return "dedupe2";
  }
}

async function resolveModel(ctx: any): Promise<ResolvedModel | null> {
  const availableModels = ctx?.modelRegistry?.getAvailable?.() ?? [];
  const model = ctx?.model ?? availableModels[0];
  if (!model) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return null;

  return {
    model,
    apiKey: auth.apiKey,
    headers: auth.headers,
    modelName: `${model.provider}/${model.id}`,
  };
}

async function completeDuplicateDecisionRequest(
  request: DuplicateDecisionRequest,
  resolvedModel: ResolvedModel,
  thinkingLevel: ThinkingLevel,
  signal?: AbortSignal,
): Promise<string> {
  const systemPrompt = request.kind === "repair"
    ? ADJUDICATION_REPAIR_SYSTEM_PROMPT
    : ADJUDICATION_SYSTEM_PROMPT;
  const promptText = request.kind === "repair"
    ? buildAdjudicationRepairPrompt(request)
    : buildAdjudicationPrompt(request.group);

  const response = await completeSimple(
    resolvedModel.model,
    {
      systemPrompt,
      messages: [{
        role: "user",
        content: [{ type: "text", text: promptText }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: resolvedModel.apiKey,
      headers: resolvedModel.headers,
      signal,
      reasoning: thinkingLevel,
    },
  );

  return extractMessageText(response);
}

async function adjudicateGroup(
  group: DuplicateGroup,
  resolvedModel: ResolvedModel,
  thinkingLevel: ThinkingLevel,
  signal?: AbortSignal,
): Promise<DuplicateGroupDecision> {
  return resolveDuplicateGroupDecision(
    group,
    async (request) => completeDuplicateDecisionRequest(request, resolvedModel, thinkingLevel, signal),
  );
}

async function proposeSemanticCleanupForFile(
  request: SemanticCleanupProposalRequest,
  resolvedModel: ResolvedModel,
  thinkingLevel: ThinkingLevel,
  signal?: AbortSignal,
): Promise<SemanticCleanupProposal> {
  const response = await completeSimple(
    resolvedModel.model,
    {
      systemPrompt: SEMANTIC_CLEANUP_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: buildSemanticCleanupPrompt(request) }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: resolvedModel.apiKey,
      headers: resolvedModel.headers,
      signal,
      reasoning: thinkingLevel,
    },
  );

  return parseSemanticCleanupProposal(extractMessageText(response));
}

function summarizeResult(
  result: DistillResult,
  modelName: string | null,
  thinkingLevel: ThinkingLevel | null,
  semanticCleanupMode: SemanticCleanupMode,
  semanticCleanupEnabled: boolean,
): string {
  const lines = [
    `KB root: ${result.kbRoot}`,
    `Model: ${modelName ?? "none"}`,
    `Thinking: ${thinkingLevel ?? "none"}`,
    `Semantic cleanup mode: ${formatSemanticCleanupMode(semanticCleanupMode)}`,
    `Semantic cleanup enabled: ${semanticCleanupEnabled ? "yes" : "no"}`,
    `Scanned files: ${result.scannedFiles.length}`,
    `Compared files: ${result.comparedFiles.length}`,
    `Candidate groups reviewed: ${result.candidateGroupsReviewed}`,
    `Modified files: ${result.modifiedFiles.length}`,
    `Deleted files: ${result.deletedFiles.length}`,
    `Duplicate groups: ${result.duplicateGroups}`,
    `Duplicates removed: ${result.duplicatesRemoved}`,
    `Semantic files reviewed: ${result.semanticFilesReviewed}`,
    `Semantic files modified: ${result.semanticFilesModified.length}`,
    `Semantic issues found: ${result.semanticIssuesFound}`,
    `Semantic issues resolved: ${result.semanticIssuesResolved}`,
    `Semantic issues skipped: ${result.semanticIssuesSkipped}`,
    `Semantic backup root: ${result.semanticBackupRoot ?? "none"}`,
  ];

  if (result.duplicatePasses.length > 0) {
    lines.push("Duplicate passes:");
    for (const pass of result.duplicatePasses) {
      lines.push(`- ${pass.pass}: ${pass.duplicatesRemoved} removed across ${pass.modifiedFiles.length} files`);
    }
  }

  if (result.modifiedFiles.length > 0) {
    lines.push("Modified files:");
    for (const filePath of result.modifiedFiles) lines.push(`- ${filePath}`);
  }

  if (result.semanticFilesModified.length > 0) {
    lines.push("Semantic files modified:");
    for (const filePath of result.semanticFilesModified) lines.push(`- ${filePath}`);
  }

  if (result.deletedFiles.length > 0) {
    lines.push("Deleted files:");
    for (const filePath of result.deletedFiles) lines.push(`- ${filePath}`);
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}

function summarizeHeadline(result: DistillResult): string {
  const parts = [`removed ${result.duplicatesRemoved} duplicates`];

  if (result.semanticIssuesResolved > 0) {
    parts.push(`resolved ${result.semanticIssuesResolved} semantic issues`);
  }

  parts.push(`modified ${result.modifiedFiles.length} files`);

  if (result.deletedFiles.length > 0) {
    parts.push(`deleted ${result.deletedFiles.length} files`);
  }

  if (result.warnings.length > 0) {
    parts.push(`${result.warnings.length} warnings`);
  }

  return `Manual distill ${parts.join(", ")}.`;
}

export default function raindistiller(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(RUN_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as DistillSummaryMessageDetails | undefined;
    const label = theme.fg("customMessageLabel", "\x1b[1m[raindistiller]\x1b[22m");
    const body = expanded && details?.summaryText
      ? details.summaryText
      : `${typeof message.content === "string" ? message.content : "Raindistiller run completed."} (${keyText("app.tools.expand")} to expand)`;

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(label, 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Text(theme.fg("customMessageText", body), 0, 0));
    return box;
  });

  const state: RuntimeState = {
    autoEnabled: true,
    busy: false,
    progressStage: null,
    progressProcessed: 0,
    progressTotal: 0,
    pendingFiles: [],
    sessionRuns: 0,
    sessionDuplicatesRemoved: 0,
    sessionSemanticIssuesResolved: 0,
    sessionModifiedFiles: [],
    currentLintWarnings: null,
    currentStructuralIssues: null,
    currentSemanticWarnings: null,
    lastRunAt: null,
    lastDuplicatesRemoved: 0,
    lastSemanticIssuesResolved: 0,
    lastModifiedFiles: [],
    lastSemanticFilesModified: [],
    lastDuplicateGroups: 0,
    lastWarnings: 0,
    lastSource: null,
    lastModelName: null,
    lastThinkingLevel: null,
    lastSemanticCleanupMode: null,
    lastSemanticCleanupEnabled: null,
  };

  let latestCtx: any = null;

  function addSessionFiles(files: string[]): void {
    state.sessionModifiedFiles = [...new Set([...state.sessionModifiedFiles, ...files])];
  }

  function updateLintStatus(kbRoot: string): void {
    try {
      if (!fs.existsSync(kbRoot) || !fs.statSync(kbRoot).isDirectory()) {
        state.currentLintWarnings = null;
        state.currentStructuralIssues = null;
        state.currentSemanticWarnings = null;
        syncStatus();
        return;
      }

      const structural = lintKnowledgeBase(kbRoot);
      const semantic = lintKnowledgeBaseSemanticCleanup(kbRoot);
      state.currentStructuralIssues = structural.issues.length;
      state.currentSemanticWarnings = semantic.issues.length;
      state.currentLintWarnings = structural.issues.length + semantic.issues.length;
    } catch {
      state.currentLintWarnings = null;
      state.currentStructuralIssues = null;
      state.currentSemanticWarnings = null;
    }

    syncStatus();
  }

  function updateProgress(progress: DistillProgress): void {
    state.progressStage = progress.stage;
    state.progressProcessed = progress.processed;
    state.progressTotal = progress.total;
    syncStatus();
  }

  function clearProgress(): void {
    state.progressStage = null;
    state.progressProcessed = 0;
    state.progressTotal = 0;
  }

  function syncStatus(ctx = latestCtx): void {
    if (!ctx?.hasUI) return;

    const { mode } = getConfiguredSemanticCleanupMode();
    const theme = ctx.ui.theme;
    const icon = state.busy ? theme.fg("accent", "🧼") : theme.fg("success", "🧼");
    const auto = state.autoEnabled ? theme.fg("dim", " auto") : theme.fg("dim", " off");
    const semanticMode = theme.fg("dim", ` sem:${mode === "manual_only" ? "manual" : mode}`);
    const counts = theme.fg(
      "dim",
      ` r:${state.sessionRuns} d:${state.sessionDuplicatesRemoved} s:${state.sessionSemanticIssuesResolved} f:${state.sessionModifiedFiles.length} w:${state.currentLintWarnings ?? "?"}`,
    );
    const deltaParts: string[] = [];
    if (state.lastDuplicatesRemoved > 0) deltaParts.push(`+${state.lastDuplicatesRemoved}d`);
    if (state.lastSemanticIssuesResolved > 0) deltaParts.push(`+${state.lastSemanticIssuesResolved}s`);
    const delta = deltaParts.length > 0 ? theme.fg("dim", ` (${deltaParts.join(" ")})`) : "";
    const progress = state.busy && state.progressStage
      ? theme.fg(
        "dim",
        state.progressTotal > 0
          ? ` p:${formatProgressStage(state.progressStage)} ${Math.min(state.progressProcessed, state.progressTotal)}/${state.progressTotal}`
          : ` p:${formatProgressStage(state.progressStage)} scan`,
      )
      : "";
    const suffix = state.busy ? theme.fg("dim", " distilling") : "";
    ctx.ui.setStatus("raindistiller", `${icon}${auto}${semanticMode}${counts}${delta}${progress}${suffix}`);
  }

  function restoreSessionState(ctx: any): void {
    state.busy = false;
    clearProgress();
    state.pendingFiles = [];
    state.sessionRuns = 0;
    state.sessionDuplicatesRemoved = 0;
    state.sessionSemanticIssuesResolved = 0;
    state.sessionModifiedFiles = [];
    state.currentLintWarnings = null;
    state.currentStructuralIssues = null;
    state.currentSemanticWarnings = null;
    state.lastRunAt = null;
    state.lastDuplicatesRemoved = 0;
    state.lastSemanticIssuesResolved = 0;
    state.lastModifiedFiles = [];
    state.lastSemanticFilesModified = [];
    state.lastDuplicateGroups = 0;
    state.lastWarnings = 0;
    state.lastSource = null;
    state.lastModelName = null;
    state.lastThinkingLevel = null;
    state.lastSemanticCleanupMode = null;
    state.lastSemanticCleanupEnabled = null;

    const branchEntries = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const entry of branchEntries) {
      if (entry?.type !== "custom" || entry?.customType !== RUN_ENTRY_TYPE) continue;
      const data = entry.data as DistillRunEntry | undefined;
      if (!data) continue;

      state.sessionRuns += 1;
      state.sessionDuplicatesRemoved += typeof data.duplicatesRemoved === "number" ? data.duplicatesRemoved : 0;
      state.sessionSemanticIssuesResolved += typeof data.semanticIssuesResolved === "number" ? data.semanticIssuesResolved : 0;
      addSessionFiles(Array.isArray(data.modifiedFiles) ? data.modifiedFiles : []);
      state.lastRunAt = typeof data.ranAt === "number" ? data.ranAt : state.lastRunAt;
      state.lastDuplicatesRemoved = typeof data.duplicatesRemoved === "number" ? data.duplicatesRemoved : state.lastDuplicatesRemoved;
      state.lastSemanticIssuesResolved = typeof data.semanticIssuesResolved === "number"
        ? data.semanticIssuesResolved
        : state.lastSemanticIssuesResolved;
      state.lastModifiedFiles = Array.isArray(data.modifiedFiles) ? data.modifiedFiles : state.lastModifiedFiles;
      state.lastSemanticFilesModified = Array.isArray(data.semanticFilesModified)
        ? data.semanticFilesModified
        : state.lastSemanticFilesModified;
      state.lastDuplicateGroups = typeof data.duplicateGroups === "number" ? data.duplicateGroups : state.lastDuplicateGroups;
      state.lastWarnings = typeof data.warnings === "number" ? data.warnings : state.lastWarnings;
      state.lastSource = data.source ?? state.lastSource;
      state.lastModelName = typeof data.modelName === "string" ? data.modelName : state.lastModelName;
      state.lastThinkingLevel = data.thinkingLevel ?? state.lastThinkingLevel;
      state.lastSemanticCleanupMode = isSemanticCleanupMode(data.semanticCleanupMode)
        ? data.semanticCleanupMode
        : state.lastSemanticCleanupMode;
      state.lastSemanticCleanupEnabled = typeof data.semanticCleanupEnabled === "boolean"
        ? data.semanticCleanupEnabled
        : state.lastSemanticCleanupEnabled;
    }
  }

  function recordRun(
    source: "auto" | "manual",
    result: DistillResult,
    modelName: string,
    thinkingLevel: ThinkingLevel,
    semanticCleanupMode: SemanticCleanupMode,
    semanticCleanupEnabled: boolean,
  ): void {
    const ranAt = Date.now();
    state.sessionRuns += 1;
    state.sessionDuplicatesRemoved += result.duplicatesRemoved;
    state.sessionSemanticIssuesResolved += result.semanticIssuesResolved;
    addSessionFiles(result.modifiedFiles);
    state.lastRunAt = ranAt;
    state.lastDuplicatesRemoved = result.duplicatesRemoved;
    state.lastSemanticIssuesResolved = result.semanticIssuesResolved;
    state.lastModifiedFiles = result.modifiedFiles;
    state.lastSemanticFilesModified = result.semanticFilesModified;
    state.lastDuplicateGroups = result.duplicateGroups;
    state.lastWarnings = result.warnings.length;
    state.lastSource = source;
    state.lastModelName = modelName;
    state.lastThinkingLevel = thinkingLevel;
    state.lastSemanticCleanupMode = semanticCleanupMode;
    state.lastSemanticCleanupEnabled = semanticCleanupEnabled;

    pi.appendEntry<DistillRunEntry>(RUN_ENTRY_TYPE, {
      ranAt,
      source,
      scannedFiles: result.scannedFiles.length,
      modifiedFiles: result.modifiedFiles,
      duplicatesRemoved: result.duplicatesRemoved,
      duplicateGroups: result.duplicateGroups,
      semanticIssuesResolved: result.semanticIssuesResolved,
      semanticFilesModified: result.semanticFilesModified,
      warnings: result.warnings.length,
      modelName,
      thinkingLevel,
      semanticCleanupMode,
      semanticCleanupEnabled,
    });
  }

  function queueFiles(files: string[]): void {
    state.pendingFiles = [...new Set([...state.pendingFiles, ...files])];
  }

  async function runDistill(
    request: DistillRequest,
    source: "auto" | "manual",
    semanticCleanupOverride: boolean | null = null,
    ctx = latestCtx,
  ): Promise<{
    result: DistillResult;
    modelName: string;
    thinkingLevel: ThinkingLevel;
    semanticCleanupMode: SemanticCleanupMode;
    semanticCleanupEnabled: boolean;
  }> {
    ensureKbReady(request.kbRoot);
    const resolvedModel = await resolveModel(ctx);
    if (!resolvedModel) {
      throw new Error("Raindistiller requires an available model with auth.");
    }

    const { mode: semanticCleanupMode, warning: semanticModeWarning } = getConfiguredSemanticCleanupMode();
    const semanticCleanupEnabled = isSemanticCleanupEnabled(semanticCleanupMode, source, semanticCleanupOverride);
    const thinkingLevel = getThinkingLevel(source);
    state.busy = true;
    clearProgress();
    syncStatus(ctx);

    try {
      const result = await distillKnowledgeFiles(request, {
        adjudicateGroup: async (group) => adjudicateGroup(group, resolvedModel, thinkingLevel, ctx?.signal),
        proposeSemanticCleanup: semanticCleanupEnabled
          ? async (semanticRequest) => proposeSemanticCleanupForFile(semanticRequest, resolvedModel, thinkingLevel, ctx?.signal)
          : undefined,
        onProgress: updateProgress,
      });
      if (semanticModeWarning) {
        result.warnings.unshift(semanticModeWarning);
      }
      updateLintStatus(request.kbRoot);
      recordRun(source, result, resolvedModel.modelName, thinkingLevel, semanticCleanupMode, semanticCleanupEnabled);
      syncStatus(ctx);
      return {
        result,
        modelName: resolvedModel.modelName,
        thinkingLevel,
        semanticCleanupMode,
        semanticCleanupEnabled,
      };
    } finally {
      state.busy = false;
      clearProgress();
      syncStatus(ctx);
    }
  }

  async function drainAutoQueue(): Promise<void> {
    if (!state.autoEnabled || state.busy) return;

    while (state.autoEnabled && state.pendingFiles.length > 0) {
      const files = [...state.pendingFiles];
      state.pendingFiles = [];
      const kbRoot = getSessionKbRoot();

      try {
        const { result, thinkingLevel } = await runDistill({ kbRoot, files }, "auto");
        const semanticHasWarnings = result.semanticCleanupResults.some((fileResult) => fileResult.warnings.length > 0);
        if (latestCtx?.hasUI && (result.duplicatesRemoved > 0 || result.semanticIssuesResolved > 0 || result.warnings.length > 0)) {
          const semanticSummary = result.semanticIssuesResolved > 0
            ? ` and resolved ${result.semanticIssuesResolved} semantic issues`
            : semanticHasWarnings
              ? " and checked semantic cleanup with warnings"
              : "";

          latestCtx.ui.notify(
            `Raindistiller (${thinkingLevel}) removed ${result.duplicatesRemoved} duplicates${semanticSummary} across ${result.modifiedFiles.length} files`,
            result.warnings.length > 0 ? "warning" : "info",
          );
        }
      } catch (error) {
        if (latestCtx?.hasUI) {
          latestCtx.ui.notify(`Raindistiller auto-distill failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
    }
  }

  pi.events.on("raincatcher:files-written", (event) => {
    if (!state.autoEnabled) return;
    const files = extractRaincatcherFilesWritten(event);
    if (files.length === 0) return;
    queueFiles(files);
    void drainAutoQueue();
  });

  pi.on("session_start", async (_event, ctx: any) => {
    latestCtx = ctx;
    restoreSessionState(ctx);
    syncStatus(ctx);
    updateLintStatus(getSessionKbRoot());
  });

  pi.on("session_tree", async (_event, ctx: any) => {
    latestCtx = ctx;
    restoreSessionState(ctx);
    syncStatus(ctx);
    updateLintStatus(getSessionKbRoot());
  });

  pi.on("session_shutdown", async (_event, ctx: any) => {
    latestCtx = null;
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus("raindistiller", undefined);
  });

  pi.registerCommand("raindistiller", {
    description: "Show or control Raindistiller",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const input = (args || "").trim();
      const [subcommandRaw, ...rest] = input.split(/\s+/).filter(Boolean);
      const subcommand = (subcommandRaw ?? "").toLowerCase();
      const remainder = rest.join(" ");

      if (subcommand === "on") {
        state.autoEnabled = true;
        syncStatus(ctx);
        ctx.ui.notify("Raindistiller auto mode on", "info");
        void drainAutoQueue();
        return;
      }

      if (subcommand === "off") {
        state.autoEnabled = false;
        syncStatus(ctx);
        ctx.ui.notify("Raindistiller auto mode off", "info");
        return;
      }

      if (subcommand === "distill") {
        if (state.busy) {
          ctx.ui.notify("Raindistiller is already distilling", "warning");
          return;
        }

        const kbRoot = getSessionKbRoot();
        const parsed = parseDistillArgs(remainder);
        ctx.ui.notify("Raindistiller distill started. Watch the status bar for progress.", "info");

        void (async () => {
          try {
            const { result, modelName, thinkingLevel, semanticCleanupMode, semanticCleanupEnabled } = await runDistill(
              {
                kbRoot,
                files: parsed.files,
                directories: parsed.directories,
                recursive: parsed.recursive,
              },
              "manual",
              parsed.semanticCleanupOverride,
              ctx,
            );
            const allWarnings = [...parsed.warnings, ...result.warnings];
            const resultWithWarnings = { ...result, warnings: allWarnings };
            const headline = summarizeHeadline(resultWithWarnings);
            const summaryText = [
              summarizeResult(
                resultWithWarnings,
                modelName,
                thinkingLevel,
                semanticCleanupMode,
                semanticCleanupEnabled,
              ),
              input.length > 0 ? `Command: /raindistiller ${input}` : "",
            ].filter(Boolean).join("\n");

            ctx.ui.notify(headline, allWarnings.length > 0 ? "warning" : "info");

            try {
              await ctx.waitForIdle();
            } catch {
              // Best-effort only; if the session is no longer idle-waitable, still try to post the summary.
            }

            try {
              await pi.sendMessage({
                customType: RUN_MESSAGE_TYPE,
                content: headline,
                display: true,
                details: { summaryText },
              });
            } catch (error) {
              ctx.ui.notify(
                `Raindistiller finished, but failed to post the summary message: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              );
            }
          } catch (error) {
            ctx.ui.notify(`Raindistiller distill failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
          } finally {
            void drainAutoQueue();
          }
        })();
        return;
      }

      const kbRoot = getSessionKbRoot();
      const lastRun = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : "never";
      const lastFiles = state.lastModifiedFiles.length > 0
        ? state.lastModifiedFiles.map((filePath) => `- ${filePath}`).join("\n")
        : "- none yet";
      const { mode: configuredSemanticCleanupMode, warning: semanticModeWarning } = getConfiguredSemanticCleanupMode();

      ctx.ui.notify(
        [
          `Raindistiller auto mode: ${state.autoEnabled ? "on" : "off"}`,
          `Semantic cleanup mode: ${formatSemanticCleanupMode(configuredSemanticCleanupMode)}`,
          `KB root: ${kbRoot}`,
          `Exists: ${fs.existsSync(kbRoot) ? "yes" : "no"}`,
          `Session runs: ${state.sessionRuns}`,
          `Session duplicates removed: ${state.sessionDuplicatesRemoved}`,
          `Session semantic issues resolved: ${state.sessionSemanticIssuesResolved}`,
          `Session modified files: ${state.sessionModifiedFiles.length}`,
          `Current lint findings: ${state.currentLintWarnings ?? "unknown"}`,
          `Current structural issues: ${state.currentStructuralIssues ?? "unknown"}`,
          `Current semantic warnings: ${state.currentSemanticWarnings ?? "unknown"}`,
          ...(state.busy && state.progressStage
            ? [state.progressTotal > 0
              ? `Current progress: ${formatProgressStage(state.progressStage)} ${Math.min(state.progressProcessed, state.progressTotal)}/${state.progressTotal}`
              : `Current progress: ${formatProgressStage(state.progressStage)} scan`]
            : []),
          `Last run: ${lastRun}`,
          `Last source: ${state.lastSource ?? "none"}`,
          `Last model: ${state.lastModelName ?? "none"}`,
          `Last thinking: ${state.lastThinkingLevel ?? "none"}`,
          `Last duplicates removed: ${state.lastDuplicatesRemoved}`,
          `Last semantic issues resolved: ${state.lastSemanticIssuesResolved}`,
          `Last duplicate groups: ${state.lastDuplicateGroups}`,
          `Last warnings: ${state.lastWarnings}`,
          `Last semantic files modified: ${state.lastSemanticFilesModified.length}`,
          `Last semantic cleanup mode: ${state.lastSemanticCleanupMode ?? "none"}`,
          `Last semantic cleanup enabled: ${state.lastSemanticCleanupEnabled === null ? "none" : state.lastSemanticCleanupEnabled ? "yes" : "no"}`,
          `KB root override env: ${KB_ROOT_ENV_VAR}`,
          `Semantic cleanup mode env: ${SEMANTIC_CLEANUP_MODE_ENV_VAR}`,
          `Auto thinking default: ${AUTO_THINKING_LEVEL}`,
          `Manual thinking default: ${MANUAL_THINKING_LEVEL}`,
          ...(semanticModeWarning ? [`Warning: ${semanticModeWarning}`] : []),
          "Last modified files:",
          lastFiles,
        ].join("\n"),
        "info",
      );
    },
  });
}
