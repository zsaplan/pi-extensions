import fs from "node:fs";
import { completeSimple, type AssistantMessage, type ThinkingLevel } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { KB_ROOT_ENV_VAR, getKbRoot } from "../../rain-core/src/index.ts";
import {
  type DistillRequest,
  type DistillResult,
  type DuplicateGroup,
  type DuplicateGroupDecision,
  distillKnowledgeFiles,
} from "./distill.ts";

type RaincatcherFilesWrittenEvent = {
  kbRoot?: string;
  filesWritten?: string[];
};

type DistillRunEntry = {
  ranAt: number;
  source: "auto" | "manual";
  scannedFiles: number;
  modifiedFiles: string[];
  duplicatesRemoved: number;
  duplicateGroups: number;
  warnings: number;
  modelName?: string | null;
  thinkingLevel?: ThinkingLevel | null;
};

type RuntimeState = {
  autoEnabled: boolean;
  busy: boolean;
  pendingFiles: string[];
  sessionRuns: number;
  sessionDuplicatesRemoved: number;
  sessionModifiedFiles: string[];
  lastRunAt: number | null;
  lastDuplicatesRemoved: number;
  lastModifiedFiles: string[];
  lastDuplicateGroups: number;
  lastWarnings: number;
  lastSource: "auto" | "manual" | null;
  lastModelName: string | null;
  lastThinkingLevel: ThinkingLevel | null;
};

type ResolvedModel = {
  model: any;
  apiKey?: string;
  headers?: Record<string, string>;
  modelName: string;
};

const RUN_ENTRY_TYPE = "raindistiller-run";
const MANUAL_THINKING_LEVEL = "xhigh" as const;
const AUTO_THINKING_LEVEL = "medium" as const;

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
- Prefer more specific and authoritative-looking file context over generic context.
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

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;

  for (const match of input.matchAll(regex)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(value.replace(/\\(["'\\])/g, "$1"));
  }

  return tokens;
}

function parseDistillArgs(input: string): { files: string[]; directories: string[]; recursive: boolean; warnings: string[] } {
  const files: string[] = [];
  const directories: string[] = [];
  const warnings: string[] = [];
  const tokens = tokenizeArgs(input);
  let recursive = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1];

    if (token === "--file" || token === "-f") {
      if (!next) {
        warnings.push("Missing path after --file");
        continue;
      }
      files.push(next);
      index += 1;
      continue;
    }

    if (token === "--dir" || token === "--directory" || token === "-d") {
      if (!next) {
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

    if (token.endsWith(".md")) {
      files.push(token);
      continue;
    }

    directories.push(token);
  }

  if (files.length === 0 && directories.length === 0) directories.push(".");

  return { files, directories, recursive, warnings };
}

function getThinkingLevel(source: "auto" | "manual"): ThinkingLevel {
  return source === "manual" ? MANUAL_THINKING_LEVEL : AUTO_THINKING_LEVEL;
}

function extractMessageText(message: AssistantMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: string; text?: string } => !!part && typeof part === "object" && "type" in part)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function parseDecision(text: string): DuplicateGroupDecision {
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

function buildAdjudicationPrompt(group: DuplicateGroup): string {
  const renderedOccurrences = group.occurrences
    .map((occurrence, index) => {
      return [
        `Occurrence ${index + 1}`,
        `occurrenceId: ${occurrence.id}`,
        `filePath: ${occurrence.filePath}`,
        `selected: ${occurrence.selected ? "true" : "false"}`,
        `heading: ${occurrence.heading ?? "(none)"}`,
        `lineNumber: ${occurrence.lineNumber}`,
        `normalized: ${occurrence.normalized}`,
        `fact: ${occurrence.text}`,
      ].join("\n");
    })
    .join("\n\n");

  const strongestPairs = group.strongestPairs.length > 0
    ? group.strongestPairs.map((pair, index) => {
      return [
        `Pair ${index + 1}`,
        `leftId: ${pair.leftId}`,
        `rightId: ${pair.rightId}`,
        `exactNormalized: ${pair.similarity.exactNormalized ? "true" : "false"}`,
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

async function adjudicateGroup(
  group: DuplicateGroup,
  resolvedModel: ResolvedModel,
  thinkingLevel: ThinkingLevel,
  signal?: AbortSignal,
): Promise<DuplicateGroupDecision> {
  const response = await completeSimple(
    resolvedModel.model,
    {
      systemPrompt: ADJUDICATION_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: buildAdjudicationPrompt(group) }],
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

  return parseDecision(extractMessageText(response));
}

function summarizeResult(result: DistillResult, modelName: string | null, thinkingLevel: ThinkingLevel | null): string {
  const lines = [
    `KB root: ${result.kbRoot}`,
    `Model: ${modelName ?? "none"}`,
    `Thinking: ${thinkingLevel ?? "none"}`,
    `Scanned files: ${result.scannedFiles.length}`,
    `Compared files: ${result.comparedFiles.length}`,
    `Candidate groups reviewed: ${result.candidateGroupsReviewed}`,
    `Modified files: ${result.modifiedFiles.length}`,
    `Deleted files: ${result.deletedFiles.length}`,
    `Duplicate groups: ${result.duplicateGroups}`,
    `Duplicates removed: ${result.duplicatesRemoved}`,
  ];

  if (result.modifiedFiles.length > 0) {
    lines.push("Modified files:");
    for (const filePath of result.modifiedFiles) lines.push(`- ${filePath}`);
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

export default function raindistiller(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    autoEnabled: true,
    busy: false,
    pendingFiles: [],
    sessionRuns: 0,
    sessionDuplicatesRemoved: 0,
    sessionModifiedFiles: [],
    lastRunAt: null,
    lastDuplicatesRemoved: 0,
    lastModifiedFiles: [],
    lastDuplicateGroups: 0,
    lastWarnings: 0,
    lastSource: null,
    lastModelName: null,
    lastThinkingLevel: null,
  };

  let latestCtx: any = null;

  function addSessionFiles(files: string[]): void {
    state.sessionModifiedFiles = [...new Set([...state.sessionModifiedFiles, ...files])];
  }

  function syncStatus(ctx = latestCtx): void {
    if (!ctx?.hasUI) return;

    const theme = ctx.ui.theme;
    const icon = state.busy ? theme.fg("accent", "🧼") : theme.fg("success", "🧼");
    const auto = state.autoEnabled ? theme.fg("dim", " auto") : theme.fg("dim", " off");
    const counts = theme.fg(
      "dim",
      ` r:${state.sessionRuns} d:${state.sessionDuplicatesRemoved} f:${state.sessionModifiedFiles.length}`,
    );
    const delta = state.lastDuplicatesRemoved > 0 ? theme.fg("dim", ` (+${state.lastDuplicatesRemoved})`) : "";
    const suffix = state.busy ? theme.fg("dim", " distilling") : "";
    ctx.ui.setStatus("raindistiller", `${icon}${auto}${counts}${delta}${suffix}`);
  }

  function restoreSessionState(ctx: any): void {
    state.busy = false;
    state.pendingFiles = [];
    state.sessionRuns = 0;
    state.sessionDuplicatesRemoved = 0;
    state.sessionModifiedFiles = [];
    state.lastRunAt = null;
    state.lastDuplicatesRemoved = 0;
    state.lastModifiedFiles = [];
    state.lastDuplicateGroups = 0;
    state.lastWarnings = 0;
    state.lastSource = null;
    state.lastModelName = null;
    state.lastThinkingLevel = null;

    const branchEntries = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const entry of branchEntries) {
      if (entry?.type !== "custom" || entry?.customType !== RUN_ENTRY_TYPE) continue;
      const data = entry.data as DistillRunEntry | undefined;
      if (!data) continue;

      state.sessionRuns += 1;
      state.sessionDuplicatesRemoved += typeof data.duplicatesRemoved === "number" ? data.duplicatesRemoved : 0;
      addSessionFiles(Array.isArray(data.modifiedFiles) ? data.modifiedFiles : []);
      state.lastRunAt = typeof data.ranAt === "number" ? data.ranAt : state.lastRunAt;
      state.lastDuplicatesRemoved = typeof data.duplicatesRemoved === "number" ? data.duplicatesRemoved : state.lastDuplicatesRemoved;
      state.lastModifiedFiles = Array.isArray(data.modifiedFiles) ? data.modifiedFiles : state.lastModifiedFiles;
      state.lastDuplicateGroups = typeof data.duplicateGroups === "number" ? data.duplicateGroups : state.lastDuplicateGroups;
      state.lastWarnings = typeof data.warnings === "number" ? data.warnings : state.lastWarnings;
      state.lastSource = data.source ?? state.lastSource;
      state.lastModelName = typeof data.modelName === "string" ? data.modelName : state.lastModelName;
      state.lastThinkingLevel = data.thinkingLevel ?? state.lastThinkingLevel;
    }
  }

  function recordRun(source: "auto" | "manual", result: DistillResult, modelName: string, thinkingLevel: ThinkingLevel): void {
    const ranAt = Date.now();
    state.sessionRuns += 1;
    state.sessionDuplicatesRemoved += result.duplicatesRemoved;
    addSessionFiles(result.modifiedFiles);
    state.lastRunAt = ranAt;
    state.lastDuplicatesRemoved = result.duplicatesRemoved;
    state.lastModifiedFiles = result.modifiedFiles;
    state.lastDuplicateGroups = result.duplicateGroups;
    state.lastWarnings = result.warnings.length;
    state.lastSource = source;
    state.lastModelName = modelName;
    state.lastThinkingLevel = thinkingLevel;

    pi.appendEntry<DistillRunEntry>(RUN_ENTRY_TYPE, {
      ranAt,
      source,
      scannedFiles: result.scannedFiles.length,
      modifiedFiles: result.modifiedFiles,
      duplicatesRemoved: result.duplicatesRemoved,
      duplicateGroups: result.duplicateGroups,
      warnings: result.warnings.length,
      modelName,
      thinkingLevel,
    });
  }

  function queueFiles(files: string[]): void {
    state.pendingFiles = [...new Set([...state.pendingFiles, ...files])];
  }

  async function runDistill(
    request: DistillRequest,
    source: "auto" | "manual",
    ctx = latestCtx,
  ): Promise<{ result: DistillResult; modelName: string; thinkingLevel: ThinkingLevel }> {
    ensureKbReady(request.kbRoot);
    const resolvedModel = await resolveModel(ctx);
    if (!resolvedModel) {
      throw new Error("Raindistiller requires an available model with auth.");
    }

    const thinkingLevel = getThinkingLevel(source);
    state.busy = true;
    syncStatus(ctx);

    try {
      const result = await distillKnowledgeFiles(request, {
        adjudicateGroup: async (group) => adjudicateGroup(group, resolvedModel, thinkingLevel, ctx?.signal),
      });
      recordRun(source, result, resolvedModel.modelName, thinkingLevel);
      syncStatus(ctx);
      return { result, modelName: resolvedModel.modelName, thinkingLevel };
    } finally {
      state.busy = false;
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
        if (latestCtx?.hasUI && (result.duplicatesRemoved > 0 || result.warnings.length > 0)) {
          latestCtx.ui.notify(
            `Raindistiller (${thinkingLevel}) removed ${result.duplicatesRemoved} duplicates across ${result.modifiedFiles.length} files`,
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

  pi.events.on("raincatcher:files-written", (event: RaincatcherFilesWrittenEvent | undefined) => {
    if (!state.autoEnabled) return;
    const files = Array.isArray(event?.filesWritten) ? event.filesWritten.filter((file): file is string => typeof file === "string") : [];
    if (files.length === 0) return;
    queueFiles(files);
    void drainAutoQueue();
  });

  pi.on("session_start", async (_event, ctx: any) => {
    latestCtx = ctx;
    restoreSessionState(ctx);
    syncStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx: any) => {
    latestCtx = ctx;
    restoreSessionState(ctx);
    syncStatus(ctx);
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

        try {
          const kbRoot = getSessionKbRoot();
          const parsed = parseDistillArgs(remainder);
          const { result, modelName, thinkingLevel } = await runDistill(
            {
              kbRoot,
              files: parsed.files,
              directories: parsed.directories,
              recursive: parsed.recursive,
            },
            "manual",
            ctx,
          );
          const allWarnings = [...parsed.warnings, ...result.warnings];
          ctx.ui.notify(
            [
              summarizeResult({ ...result, warnings: allWarnings }, modelName, thinkingLevel),
              input.length > 0 ? `Command: /raindistiller ${input}` : "",
            ].filter(Boolean).join("\n"),
            allWarnings.length > 0 ? "warning" : "info",
          );
        } catch (error) {
          ctx.ui.notify(`Raindistiller distill failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        void drainAutoQueue();
        return;
      }

      const kbRoot = getSessionKbRoot();
      const lastRun = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : "never";
      const lastFiles = state.lastModifiedFiles.length > 0
        ? state.lastModifiedFiles.map((filePath) => `- ${filePath}`).join("\n")
        : "- none yet";

      ctx.ui.notify(
        [
          `Raindistiller auto mode: ${state.autoEnabled ? "on" : "off"}`,
          `KB root: ${kbRoot}`,
          `Exists: ${fs.existsSync(kbRoot) ? "yes" : "no"}`,
          `Session runs: ${state.sessionRuns}`,
          `Session duplicates removed: ${state.sessionDuplicatesRemoved}`,
          `Session modified files: ${state.sessionModifiedFiles.length}`,
          `Last run: ${lastRun}`,
          `Last source: ${state.lastSource ?? "none"}`,
          `Last model: ${state.lastModelName ?? "none"}`,
          `Last thinking: ${state.lastThinkingLevel ?? "none"}`,
          `Last duplicates removed: ${state.lastDuplicatesRemoved}`,
          `Last duplicate groups: ${state.lastDuplicateGroups}`,
          `Last warnings: ${state.lastWarnings}`,
          `KB root override env: ${KB_ROOT_ENV_VAR}`,
          `Auto thinking default: ${AUTO_THINKING_LEVEL}`,
          `Manual thinking default: ${MANUAL_THINKING_LEVEL}`,
          "Last modified files:",
          lastFiles,
        ].join("\n"),
        "info",
      );
    },
  });
}
