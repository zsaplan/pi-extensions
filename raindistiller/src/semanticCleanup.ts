import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { withQueuedFileMutation } from "./fileMutationQueue.ts";
import {
  lintFactFileContent,
  lintFactFileSemanticCleanup,
  parseFactFileContent,
  parseStructuredFactLine,
  renderMarkdown,
  renderStructuredFactLine,
  type FactLintIssue,
} from "@zsaplan/rain-core";

export type SemanticCleanupFileAction = {
  lineNumber: number;
  action: "rewrite" | "skip";
  replacement?: string;
  reason: string;
};

export type SemanticCleanupProposalRequest = {
  file: string;
  content: string;
  issues: FactLintIssue[];
};

export type SemanticCleanupProposal = {
  file: string;
  actions: SemanticCleanupFileAction[];
};

export type SemanticCleanupActionAudit = {
  file: string;
  lineNumber: number;
  issue: FactLintIssue;
  originalLine: string;
  proposedReplacement?: string;
  appliedReplacement?: string;
  outcome: "accepted" | "skipped" | "rejected";
  reason: string;
};

export type SemanticCleanupFileResult = {
  file: string;
  issuesFound: FactLintIssue[];
  issuesResolved: FactLintIssue[];
  issuesSkipped: Array<{
    issue: FactLintIssue;
    reason: string;
  }>;
  acceptedActions: SemanticCleanupActionAudit[];
  skippedActions: SemanticCleanupActionAudit[];
  backupPath?: string;
  modified: boolean;
  warnings: string[];
};

export type SemanticCleanupRunResult = {
  filesReviewed: string[];
  modifiedFiles: string[];
  issuesFound: FactLintIssue[];
  issuesResolved: FactLintIssue[];
  issuesSkipped: Array<{
    file: string;
    issue: FactLintIssue;
    reason: string;
  }>;
  actionAudit: SemanticCleanupActionAudit[];
  backupRoot?: string;
  fileResults: SemanticCleanupFileResult[];
  warnings: string[];
};

export const SEMANTIC_CLEANUP_SYSTEM_PROMPT = `You are Raindistiller, a conservative semantic cleanup reviewer for Rain fact files.

You will be given one structurally valid markdown fact file and a list of semantic cleanup warnings for specific bullet lines.
Return JSON only. No markdown. No code fences.
Use exactly this shape:
{"file":"RELATIVE_PATH.md","actions":[{"lineNumber":3,"action":"rewrite","replacement":"- USES | object text","reason":"one short sentence"},{"lineNumber":5,"action":"skip","reason":"one short sentence"}]}

Rules:
- Modify only warned bullet lines.
- Preserve heading and unwarned lines exactly.
- Output a full replacement bullet line including the '- ' prefix for rewrite actions.
- Never invent unsupported facts.
- If a warning includes suggestedRelation, the replacement relation must match it exactly.
- Keep supported qualifiers and detail when they still fit.
- Prefer skip over risky paraphrase.
- Do not try to repair structurally invalid files in this stage.`;

type PendingRewrite = {
  issue: FactLintIssue;
  originalLine: string;
  lineIndex: number;
  lineNumber: number;
  proposedReplacement: string;
  appliedReplacement: string;
  reason: string;
};

type IssueResolution = {
  issue: FactLintIssue;
  originalLine: string;
  resolved: boolean;
  reason: string;
  audit?: SemanticCleanupActionAudit;
};

function compareIssues(left: FactLintIssue, right: FactLintIssue): number {
  const fileCompare = left.file.localeCompare(right.file);
  if (fileCompare !== 0) return fileCompare;

  const lineCompare = (left.line ?? 0) - (right.line ?? 0);
  if (lineCompare !== 0) return lineCompare;

  return left.code.localeCompare(right.code);
}

function sortIssues(issues: FactLintIssue[]): FactLintIssue[] {
  return [...issues].sort(compareIssues);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function trimReason(reason: string | undefined, fallback: string): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed || fallback;
}

function trimReplacement(replacement: string | undefined): string {
  return typeof replacement === "string" ? replacement.trim() : "";
}

function issueKey(issue: FactLintIssue): string {
  return `${issue.line ?? 0}:${issue.code}`;
}

function createAudit(
  file: string,
  issue: FactLintIssue,
  originalLine: string,
  outcome: SemanticCleanupActionAudit["outcome"],
  reason: string,
  proposedReplacement?: string,
  appliedReplacement?: string,
): SemanticCleanupActionAudit {
  return {
    file,
    lineNumber: issue.line ?? 0,
    issue,
    originalLine,
    proposedReplacement,
    appliedReplacement,
    outcome,
    reason,
  };
}

function getSuggestedRelation(issue: FactLintIssue): string | undefined {
  const value = issue.details?.suggestedRelation;
  return typeof value === "string" ? value : undefined;
}

function getMatchedPattern(issue: FactLintIssue): string | undefined {
  const value = issue.details?.matchedPattern;
  return typeof value === "string" ? value : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function getSafeBackupRelativePath(file: string): string {
  const parts = file.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
  return parts.join(path.sep) || path.basename(file);
}

function buildEmptyFileResult(file: string, warnings: string[] = []): SemanticCleanupFileResult {
  return {
    file,
    issuesFound: [],
    issuesResolved: [],
    issuesSkipped: [],
    acceptedActions: [],
    skippedActions: [],
    modified: false,
    warnings,
  };
}

function buildFileResult(
  file: string,
  issuesFound: FactLintIssue[],
  resolutions: Map<string, IssueResolution>,
  warnings: string[],
  modified: boolean,
  backupPath?: string,
): SemanticCleanupFileResult {
  for (const resolution of resolutions.values()) {
    if (resolution.audit) continue;

    resolution.audit = createAudit(
      file,
      resolution.issue,
      resolution.originalLine,
      "skipped",
      resolution.reason,
    );
  }

  const orderedResolutions = [...resolutions.values()].sort((left, right) => compareIssues(left.issue, right.issue));
  const acceptedActions = orderedResolutions
    .map((resolution) => resolution.audit)
    .filter((audit): audit is SemanticCleanupActionAudit => audit?.outcome === "accepted");
  const skippedActions = orderedResolutions
    .map((resolution) => resolution.audit)
    .filter(
      (audit): audit is SemanticCleanupActionAudit =>
        audit !== undefined && audit.outcome !== "accepted",
    );

  return {
    file,
    issuesFound: sortIssues(issuesFound),
    issuesResolved: orderedResolutions.filter((resolution) => resolution.resolved).map((resolution) => resolution.issue),
    issuesSkipped: orderedResolutions
      .filter((resolution) => !resolution.resolved)
      .map((resolution) => ({ issue: resolution.issue, reason: resolution.audit?.reason ?? resolution.reason })),
    acceptedActions,
    skippedActions,
    backupPath,
    modified,
    warnings,
  };
}

async function applySemanticRewrite(
  absolutePath: string,
  currentContent: string,
  nextContent: string,
  backupPath: string,
): Promise<{ applied: boolean; reason?: string }> {
  return withQueuedFileMutation(absolutePath, async () => {
    if (!fs.existsSync(absolutePath)) {
      return { applied: false, reason: "File no longer exists." };
    }

    const latestContent = await readFile(absolutePath, "utf8");
    if (latestContent !== currentContent) {
      return { applied: false, reason: "File changed after validation." };
    }

    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, latestContent, "utf8");
    await writeFile(absolutePath, nextContent, "utf8");
    return { applied: true };
  });
}

async function resolveSemanticCleanupForFile(args: {
  kbRoot: string;
  file: string;
  proposeSemanticCleanup: (request: SemanticCleanupProposalRequest) => Promise<SemanticCleanupProposal>;
  ensureBackupRoot: () => Promise<string>;
}): Promise<SemanticCleanupFileResult> {
  const warnings: string[] = [];
  const absolutePath = path.join(args.kbRoot, args.file);

  if (!fs.existsSync(absolutePath)) {
    warnings.push(`Skipped missing file during semantic cleanup: ${args.file}`);
    return buildEmptyFileResult(args.file, warnings);
  }

  if (!fs.statSync(absolutePath).isFile()) {
    warnings.push(`Skipped non-file path during semantic cleanup: ${args.file}`);
    return buildEmptyFileResult(args.file, warnings);
  }

  let currentContent = "";
  try {
    currentContent = await readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Skipped unreadable file during semantic cleanup: ${args.file} (${message})`);
    return buildEmptyFileResult(args.file, warnings);
  }

  const semanticBefore = lintFactFileSemanticCleanup(args.file, currentContent);
  if (semanticBefore.analysisStatus !== "analyzed") {
    warnings.push(`Skipped structurally invalid file during semantic cleanup: ${args.file}`);
    return buildEmptyFileResult(args.file, warnings);
  }

  const issuesFound = semanticBefore.issues;
  const parsedFile = parseFactFileContent(currentContent);
  const resolutions = new Map<string, IssueResolution>(
    issuesFound.map((issue) => {
      const originalLine = typeof issue.line === "number" && issue.line > 0
        ? (parsedFile.lines[issue.line - 1] ?? "")
        : "";
      return [
        issueKey(issue),
        {
          issue,
          originalLine,
          resolved: false,
          reason: "No action proposed.",
        },
      ];
    }),
  );

  if (issuesFound.length === 0) {
    return buildFileResult(args.file, issuesFound, resolutions, warnings, false);
  }

  let proposal: SemanticCleanupProposal;
  try {
    proposal = await args.proposeSemanticCleanup({
      file: args.file,
      content: currentContent,
      issues: issuesFound,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `Semantic cleanup proposal failed: ${message}`;
    warnings.push(`Failed to propose semantic cleanup for ${args.file}: ${message}`);

    for (const resolution of resolutions.values()) {
      resolution.reason = reason;
      resolution.audit = createAudit(args.file, resolution.issue, resolution.originalLine, "skipped", reason);
    }

    return buildFileResult(args.file, issuesFound, resolutions, warnings, false);
  }

  if (proposal.file !== args.file) {
    const reason = `Semantic cleanup proposal targeted '${proposal.file}' instead of '${args.file}'.`;
    warnings.push(`Ignored semantic cleanup proposal for ${args.file}: model responded for ${proposal.file}`);

    for (const resolution of resolutions.values()) {
      resolution.reason = reason;
      resolution.audit = createAudit(args.file, resolution.issue, resolution.originalLine, "skipped", reason);
    }

    return buildFileResult(args.file, issuesFound, resolutions, warnings, false);
  }

  const issueByLine = new Map<number, FactLintIssue>();
  for (const issue of issuesFound) {
    if (typeof issue.line === "number") issueByLine.set(issue.line, issue);
  }

  const seenActionLines = new Set<number>();
  const pendingRewrites = new Map<string, PendingRewrite>();

  for (const action of proposal.actions) {
    if (!isPositiveInteger(action.lineNumber)) {
      warnings.push(`Ignored semantic cleanup action for ${args.file}: invalid line number '${String(action.lineNumber)}'`);
      continue;
    }

    const issue = issueByLine.get(action.lineNumber);
    if (!issue) {
      warnings.push(`Ignored semantic cleanup action for ${args.file}:${action.lineNumber}: no matching semantic issue`);
      continue;
    }

    if (seenActionLines.has(action.lineNumber)) {
      warnings.push(`Ignored duplicate semantic cleanup action for ${args.file}:${action.lineNumber}`);
      continue;
    }
    seenActionLines.add(action.lineNumber);

    const key = issueKey(issue);
    const resolution = resolutions.get(key);
    if (!resolution) continue;

    if (action.action === "skip") {
      const reason = trimReason(action.reason, "Model skipped the rewrite.");
      resolution.reason = reason;
      resolution.audit = createAudit(args.file, issue, resolution.originalLine, "skipped", reason);
      continue;
    }

    const proposedReplacement = trimReplacement(action.replacement);
    let appliedReplacement = "";

    try {
      const parsedReplacement = parseStructuredFactLine(proposedReplacement);
      if (!parsedReplacement) {
        throw new Error("Replacement is not a structured bullet line.");
      }

      const suggestedRelation = getSuggestedRelation(issue);
      if (issue.code === "RELATION_REFINEMENT_CANDIDATE" && suggestedRelation && parsedReplacement.relation !== suggestedRelation) {
        throw new Error(`Replacement relation '${parsedReplacement.relation}' must match suggested relation '${suggestedRelation}'.`);
      }

      appliedReplacement = renderStructuredFactLine(parsedReplacement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `Rejected rewrite proposal: ${message}`;
      resolution.reason = reason;
      resolution.audit = createAudit(
        args.file,
        issue,
        resolution.originalLine,
        "skipped",
        reason,
        proposedReplacement || undefined,
      );
      continue;
    }

    pendingRewrites.set(key, {
      issue,
      originalLine: resolution.originalLine,
      lineIndex: (issue.line ?? 1) - 1,
      lineNumber: issue.line ?? 0,
      proposedReplacement,
      appliedReplacement,
      reason: trimReason(action.reason, "Accepted semantic cleanup rewrite."),
    });
  }

  if (pendingRewrites.size === 0) {
    return buildFileResult(args.file, issuesFound, resolutions, warnings, false);
  }

  const nextLines = [...parsedFile.lines];
  for (const pending of pendingRewrites.values()) {
    nextLines[pending.lineIndex] = pending.appliedReplacement;
  }
  const nextContent = renderMarkdown(nextLines);

  let rejectionReason: string | null = null;
  const structuralErrors = lintFactFileContent(args.file, nextContent).issues.filter((issue) => issue.severity === "error");
  if (structuralErrors.length > 0) {
    rejectionReason = `Rejected semantic cleanup for ${args.file}: candidate rewrite introduced ${structuralErrors.length} structural error${structuralErrors.length === 1 ? "" : "s"}.`;
  }

  const semanticAfter = rejectionReason ? null : lintFactFileSemanticCleanup(args.file, nextContent);
  if (!rejectionReason && semanticAfter?.analysisStatus !== "analyzed") {
    rejectionReason = `Rejected semantic cleanup for ${args.file}: rewritten file could not be re-analyzed semantically.`;
  }

  if (!rejectionReason && semanticAfter && semanticAfter.issues.length >= issuesFound.length) {
    rejectionReason = `Rejected semantic cleanup for ${args.file}: candidate rewrite did not reduce semantic warnings.`;
  }

  if (!rejectionReason && semanticAfter) {
    const unresolvedCandidates = [...pendingRewrites.values()].filter((pending) => {
      return semanticAfter.issues.some((issue) => issue.line === pending.lineNumber && issue.code === pending.issue.code);
    });

    if (unresolvedCandidates.length > 0) {
      const sample = unresolvedCandidates[0]!;
      rejectionReason = `Rejected semantic cleanup for ${args.file}: rewritten line ${sample.lineNumber} still triggered ${sample.issue.code}.`;
    }
  }

  if (rejectionReason) {
    warnings.push(rejectionReason);

    for (const pending of pendingRewrites.values()) {
      const resolution = resolutions.get(issueKey(pending.issue));
      if (!resolution) continue;
      resolution.reason = rejectionReason;
      resolution.audit = createAudit(
        args.file,
        pending.issue,
        pending.originalLine,
        "rejected",
        rejectionReason,
        pending.proposedReplacement,
        pending.appliedReplacement,
      );
    }

    return buildFileResult(args.file, issuesFound, resolutions, warnings, false);
  }

  let backupPath: string | undefined;
  try {
    const backupRoot = await args.ensureBackupRoot();
    backupPath = path.join(backupRoot, getSafeBackupRelativePath(args.file));
    const writeResult = await applySemanticRewrite(absolutePath, currentContent, nextContent, backupPath);
    if (!writeResult.applied) {
      const reason = `Skipped applying semantic cleanup for ${args.file}: ${writeResult.reason ?? "write failed."}`;
      warnings.push(reason);

      for (const pending of pendingRewrites.values()) {
        const resolution = resolutions.get(issueKey(pending.issue));
        if (!resolution) continue;
        resolution.reason = reason;
        resolution.audit = createAudit(
          args.file,
          pending.issue,
          pending.originalLine,
          "rejected",
          reason,
          pending.proposedReplacement,
          pending.appliedReplacement,
        );
      }

      return buildFileResult(args.file, issuesFound, resolutions, warnings, false);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `Skipped applying semantic cleanup for ${args.file}: ${message}`;
    warnings.push(reason);

    for (const pending of pendingRewrites.values()) {
      const resolution = resolutions.get(issueKey(pending.issue));
      if (!resolution) continue;
      resolution.reason = reason;
      resolution.audit = createAudit(
        args.file,
        pending.issue,
        pending.originalLine,
        "rejected",
        reason,
        pending.proposedReplacement,
        pending.appliedReplacement,
      );
    }

    return buildFileResult(args.file, issuesFound, resolutions, warnings, false);
  }

  for (const pending of pendingRewrites.values()) {
    const resolution = resolutions.get(issueKey(pending.issue));
    if (!resolution) continue;
    resolution.resolved = true;
    resolution.reason = pending.reason;
    resolution.audit = createAudit(
      args.file,
      pending.issue,
      pending.originalLine,
      "accepted",
      pending.reason,
      pending.proposedReplacement,
      pending.appliedReplacement,
    );
  }

  return buildFileResult(args.file, issuesFound, resolutions, warnings, true, backupPath);
}

export function buildSemanticCleanupPrompt(request: SemanticCleanupProposalRequest): string {
  const parsed = parseFactFileContent(request.content);
  const warningsPayload = request.issues.map((issue) => ({
    lineNumber: issue.line ?? null,
    code: issue.code,
    message: issue.message,
    suggestedRelation: getSuggestedRelation(issue),
    matchedPattern: getMatchedPattern(issue),
  }));

  return [
    "Review semantic cleanup warnings for one Rain fact file.",
    `File: ${request.file}`,
    `Heading: ${parsed.heading ?? "(none)"}`,
    "Warnings:",
    JSON.stringify(warningsPayload, null, 2),
    "",
    "Current file content:",
    "<file>",
    request.content.trimEnd(),
    "</file>",
    "",
    "Return JSON only with this shape:",
    JSON.stringify({
      file: request.file,
      actions: [{
        lineNumber: request.issues[0]?.line ?? 0,
        action: "rewrite",
        replacement: "- USES | replacement object",
        reason: "one short sentence",
      }],
    }, null, 2),
  ].join("\n");
}

export function parseSemanticCleanupProposal(text: string): SemanticCleanupProposal {
  const cleaned = stripCodeFences(text);
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  const jsonText = objectMatch ? objectMatch[0] : cleaned;
  const parsed = JSON.parse(jsonText) as SemanticCleanupProposal;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Model returned a non-object semantic cleanup proposal");
  }

  if (typeof parsed.file !== "string" || parsed.file.trim().length === 0) {
    throw new Error("Model returned semantic cleanup proposal without file");
  }

  if (!Array.isArray(parsed.actions)) {
    throw new Error("Model returned semantic cleanup proposal without actions[]");
  }

  const actions = parsed.actions.map((action, index) => {
    if (!action || typeof action !== "object") {
      throw new Error(`Model returned a non-object action at index ${index}`);
    }

    const lineNumber = (action as { lineNumber?: unknown }).lineNumber;
    const actionName = (action as { action?: unknown }).action;
    const replacement = (action as { replacement?: unknown }).replacement;
    const reason = (action as { reason?: unknown }).reason;

    if (!isPositiveInteger(lineNumber)) {
      throw new Error(`Model returned invalid lineNumber for action ${index}`);
    }

    if (actionName !== "rewrite" && actionName !== "skip") {
      throw new Error(`Model returned invalid action '${String(actionName)}' at index ${index}`);
    }

    if (typeof reason !== "string") {
      throw new Error(`Model returned non-string reason for action ${index}`);
    }

    if (actionName === "rewrite" && typeof replacement !== "string") {
      throw new Error(`Model returned rewrite without replacement for action ${index}`);
    }

    return {
      lineNumber,
      action: actionName,
      ...(typeof replacement === "string" ? { replacement } : {}),
      reason,
    } satisfies SemanticCleanupFileAction;
  });

  return {
    file: parsed.file.trim(),
    actions,
  };
}

export async function resolveSemanticCleanupForFiles(args: {
  kbRoot: string;
  files: string[];
  proposeSemanticCleanup: (request: SemanticCleanupProposalRequest) => Promise<SemanticCleanupProposal>;
  onProgress?: (processed: number, total: number) => void;
}): Promise<SemanticCleanupRunResult> {
  const filesReviewed = uniqueSorted(args.files);
  const fileResults: SemanticCleanupFileResult[] = [];
  const issuesFound: FactLintIssue[] = [];
  const issuesResolved: FactLintIssue[] = [];
  const issuesSkipped: SemanticCleanupRunResult["issuesSkipped"] = [];
  const actionAudit: SemanticCleanupActionAudit[] = [];
  const warnings: string[] = [];

  let backupRoot: string | undefined;
  args.onProgress?.(0, filesReviewed.length);

  async function ensureBackupRoot(): Promise<string> {
    if (!backupRoot) {
      backupRoot = await mkdtemp(path.join(os.tmpdir(), "raindistiller-semantic-"));
    }
    return backupRoot;
  }

  for (let index = 0; index < filesReviewed.length; index += 1) {
    const file = filesReviewed[index]!;
    try {
      const fileResult = await resolveSemanticCleanupForFile({
        kbRoot: args.kbRoot,
        file,
        proposeSemanticCleanup: args.proposeSemanticCleanup,
        ensureBackupRoot,
      });

      fileResults.push(fileResult);
      issuesFound.push(...fileResult.issuesFound);
      issuesResolved.push(...fileResult.issuesResolved);
      issuesSkipped.push(...fileResult.issuesSkipped.map(({ issue, reason }) => ({ file, issue, reason })));
      actionAudit.push(...fileResult.acceptedActions, ...fileResult.skippedActions);
      warnings.push(...fileResult.warnings);
    } finally {
      args.onProgress?.(index + 1, filesReviewed.length);
    }
  }

  return {
    filesReviewed,
    modifiedFiles: uniqueSorted(fileResults.filter((result) => result.modified).map((result) => result.file)),
    issuesFound: sortIssues(issuesFound),
    issuesResolved: sortIssues(issuesResolved),
    issuesSkipped,
    actionAudit,
    backupRoot,
    fileResults,
    warnings,
  };
}
