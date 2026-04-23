import fs from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withQueuedFileMutation } from "./fileMutationQueue.ts";
import {
  extractBulletText,
  lintKnowledgeBase,
  parseFactFileContent,
  parseStructuredFactBulletText,
  renderMarkdown,
  renderStructuredFactBullet,
  resolveMarkdownFiles,
  scanDuplicateCandidateGroups,
  type DuplicateCandidateGroup,
} from "../../rain-core/src/index.ts";
import {
  resolveSemanticCleanupForFiles,
  type SemanticCleanupActionAudit,
  type SemanticCleanupFileResult,
  type SemanticCleanupProposal,
  type SemanticCleanupProposalRequest,
  type SemanticCleanupRunResult,
} from "./semanticCleanup.ts";

export type DistillRequest = {
  kbRoot: string;
  files?: string[];
  directories?: string[];
  recursive?: boolean;
};

export type DuplicateGroup = DuplicateCandidateGroup;
export type DuplicatePass = "initial" | "post_semantic_cleanup";

export type DuplicateGroupDecision = {
  action: "dedupe" | "keep_all";
  keepOccurrenceId?: string;
  reason?: string;
};

export type DistillProgressStage = "initial_dedupe" | "semantic_cleanup" | "post_semantic_dedupe";

export type DistillProgress = {
  stage: DistillProgressStage;
  processed: number;
  total: number;
};

export type DistillOptions = {
  adjudicateGroup?: (group: DuplicateGroup) => Promise<DuplicateGroupDecision | null | undefined>;
  proposeSemanticCleanup?: (
    request: SemanticCleanupProposalRequest,
  ) => Promise<SemanticCleanupProposal>;
  onProgress?: (progress: DistillProgress) => void;
};

export type RemovedFactGroup = {
  pass: DuplicatePass;
  fact: string;
  kind: DuplicateGroup["kind"];
  keptIn: string;
  keptOccurrenceId: string;
  removedFrom: string[];
  reason?: string;
};

export type DuplicatePassResult = {
  pass: DuplicatePass;
  comparedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  candidateGroupsReviewed: number;
  duplicateGroups: number;
  duplicatesRemoved: number;
  removedFactGroups: RemovedFactGroup[];
  warnings: string[];
};

export type DistillResult = {
  kbRoot: string;
  scannedFiles: string[];
  comparedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  candidateGroupsReviewed: number;
  duplicatesRemoved: number;
  duplicateGroups: number;
  removedFactGroups: RemovedFactGroup[];
  duplicatePasses: DuplicatePassResult[];
  semanticFilesReviewed: number;
  semanticFilesModified: string[];
  semanticIssuesFound: number;
  semanticIssuesResolved: number;
  semanticIssuesSkipped: number;
  semanticCleanupResults: SemanticCleanupFileResult[];
  semanticActionAudit: SemanticCleanupActionAudit[];
  semanticBackupRoot?: string;
  warnings: string[];
};

type ApplyFileResult = {
  modified: boolean;
  deleted: boolean;
  removedCount: number;
};

function summarizeFiles(files: string[], max = 5): string {
  if (files.length <= max) return files.join(", ");
  return `${files.slice(0, max).join(", ")}, ...`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function createEmptyDuplicatePassResult(pass: DuplicatePass): DuplicatePassResult {
  return {
    pass,
    comparedFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    candidateGroupsReviewed: 0,
    duplicateGroups: 0,
    duplicatesRemoved: 0,
    removedFactGroups: [],
    warnings: [],
  };
}

function createEmptySemanticCleanupRunResult(): SemanticCleanupRunResult {
  return {
    filesReviewed: [],
    modifiedFiles: [],
    issuesFound: [],
    issuesResolved: [],
    issuesSkipped: [],
    actionAudit: [],
    fileResults: [],
    warnings: [],
  };
}

function getStructuredCanonicalFact(text: string): string | null {
  try {
    return renderStructuredFactBullet(parseStructuredFactBulletText(text));
  } catch {
    return null;
  }
}

function getStructuredKeepOccurrenceId(group: DuplicateGroup): string | undefined {
  for (const occurrence of group.occurrences) {
    if (getStructuredCanonicalFact(occurrence.text)) return occurrence.id;
  }

  return group.occurrences[0]?.id;
}

function buildDefaultDecision(group: DuplicateGroup): DuplicateGroupDecision {
  return {
    action: "dedupe",
    keepOccurrenceId: getStructuredKeepOccurrenceId(group),
    reason: group.kind === "exact" ? "default exact-match dedupe" : "default near-duplicate dedupe",
  };
}

function validateDecision(group: DuplicateGroup, decision: DuplicateGroupDecision): DuplicateGroupDecision | null {
  if (decision.action === "keep_all") return decision;
  if (!decision.keepOccurrenceId) return null;

  const keptOccurrence = group.occurrences.find((occurrence) => occurrence.id === decision.keepOccurrenceId);
  if (!keptOccurrence) return null;

  const hasStructuredOccurrence = group.occurrences.some((occurrence) => getStructuredCanonicalFact(occurrence.text) !== null);
  if (hasStructuredOccurrence && getStructuredCanonicalFact(keptOccurrence.text) === null) return null;

  return decision;
}

async function applyRemovals(absolutePath: string, lineIndexesToRemove: Set<number>): Promise<ApplyFileResult> {
  return withQueuedFileMutation(absolutePath, async () => {
    if (!fs.existsSync(absolutePath)) {
      return { modified: false, deleted: false, removedCount: 0 };
    }

    const current = await readFile(absolutePath, "utf8");
    const parsed = parseFactFileContent(current);
    if (parsed.bullets.length === 0) {
      return { modified: false, deleted: false, removedCount: 0 };
    }

    const nextLines: string[] = [];
    let removedCount = 0;

    for (let index = 0; index < parsed.lines.length; index += 1) {
      const line = parsed.lines[index] ?? "";
      if (!lineIndexesToRemove.has(index)) {
        nextLines.push(line);
        continue;
      }

      if (!extractBulletText(line)) {
        nextLines.push(line);
        continue;
      }

      removedCount += 1;
    }

    if (removedCount === 0) {
      return { modified: false, deleted: false, removedCount: 0 };
    }

    const keptBulletCount = nextLines
      .map((line) => extractBulletText(line))
      .filter((value): value is string => Boolean(value)).length;

    if (keptBulletCount === 0 && parsed.isRaincatcherFactFile) {
      await unlink(absolutePath);
      return { modified: true, deleted: true, removedCount };
    }

    const nextContent = renderMarkdown(nextLines);
    if (nextContent === current) {
      return { modified: false, deleted: false, removedCount: 0 };
    }

    await writeFile(absolutePath, nextContent, "utf8");
    return { modified: true, deleted: false, removedCount };
  });
}

function getProgressStageForDuplicatePass(pass: DuplicatePass): DistillProgressStage {
  return pass === "initial" ? "initial_dedupe" : "post_semantic_dedupe";
}

async function runDuplicatePass(
  kbRoot: string,
  scannedFiles: string[],
  pass: DuplicatePass,
  options: DistillOptions,
): Promise<DuplicatePassResult> {
  if (scannedFiles.length === 0) return createEmptyDuplicatePassResult(pass);

  const progressStage = getProgressStageForDuplicatePass(pass);
  options.onProgress?.({ stage: progressStage, processed: 0, total: 0 });

  const scan = scanDuplicateCandidateGroups(kbRoot, scannedFiles);
  const warnings = [...scan.warnings];
  const selectedFiles = new Set(scannedFiles);
  const removalsByFile = new Map<string, Set<number>>();
  const removedFactGroups: RemovedFactGroup[] = [];
  let duplicateGroups = 0;

  options.onProgress?.({ stage: progressStage, processed: 0, total: scan.candidateGroups.length });

  for (let index = 0; index < scan.candidateGroups.length; index += 1) {
    const group = scan.candidateGroups[index]!;

    try {
      const defaultDecision = buildDefaultDecision(group);
      let decision = defaultDecision;

      if (options.adjudicateGroup) {
        try {
          const adjudicated = await options.adjudicateGroup(group);
          if (adjudicated) {
            const validated = validateDecision(group, adjudicated);
            if (validated) {
              decision = validated;
            } else {
              warnings.push(`Ignored invalid dedupe decision for candidate group ${group.id}`);
              continue;
            }
          }
        } catch (error) {
          warnings.push(`Failed to adjudicate candidate group ${group.id}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }

      if (decision.action === "keep_all" || !decision.keepOccurrenceId) continue;

      const keptOccurrence = group.occurrences.find((occurrence) => occurrence.id === decision.keepOccurrenceId);
      if (!keptOccurrence) {
        warnings.push(`Could not find kept occurrence for candidate group ${group.id}`);
        continue;
      }

      const removedFrom: string[] = [];
      for (const occurrence of group.occurrences) {
        if (occurrence.id === keptOccurrence.id) continue;
        if (!selectedFiles.has(occurrence.filePath)) continue;

        const fileRemovals = removalsByFile.get(occurrence.filePath) ?? new Set<number>();
        fileRemovals.add(occurrence.lineIndex);
        removalsByFile.set(occurrence.filePath, fileRemovals);
        removedFrom.push(occurrence.filePath);
      }

      if (removedFrom.length === 0) continue;

      duplicateGroups += 1;
      removedFactGroups.push({
        pass,
        fact: group.representativeFact,
        kind: group.kind,
        keptIn: keptOccurrence.filePath,
        keptOccurrenceId: keptOccurrence.id,
        removedFrom: uniqueSorted(removedFrom),
        reason: decision.reason,
      });
    } finally {
      options.onProgress?.({ stage: progressStage, processed: index + 1, total: scan.candidateGroups.length });
    }
  }

  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];
  let duplicatesRemoved = 0;

  for (const filePath of scannedFiles) {
    const lineIndexesToRemove = removalsByFile.get(filePath);
    if (!lineIndexesToRemove || lineIndexesToRemove.size === 0) continue;

    const absolutePath = path.join(kbRoot, filePath);
    const result = await applyRemovals(absolutePath, lineIndexesToRemove);
    if (!result.modified) continue;

    duplicatesRemoved += result.removedCount;
    modifiedFiles.push(filePath);
    if (result.deleted) deletedFiles.push(filePath);
  }

  return {
    pass,
    comparedFiles: scan.comparedFiles,
    modifiedFiles: uniqueSorted(modifiedFiles),
    deletedFiles: uniqueSorted(deletedFiles),
    candidateGroupsReviewed: scan.candidateGroups.length,
    duplicateGroups,
    duplicatesRemoved,
    removedFactGroups,
    warnings,
  };
}

export async function distillKnowledgeFiles(
  request: DistillRequest,
  options: DistillOptions = {},
): Promise<DistillResult> {
  const selection = resolveMarkdownFiles(request.kbRoot, {
    files: request.files,
    directories: request.directories,
    recursive: request.recursive,
  });
  const warnings = [...selection.warnings];
  const kbLint = lintKnowledgeBase(request.kbRoot);
  warnings.push(...kbLint.warnings);

  const malformedKbFiles = [...new Set(kbLint.issues.map((issue) => issue.file))].sort();
  if (malformedKbFiles.length > 0) {
    warnings.push(
      `KB contains ${malformedKbFiles.length} malformed fact file${malformedKbFiles.length === 1 ? "" : "s"}; structured dedupe will prefer lint-clean occurrences. Examples: ${summarizeFiles(malformedKbFiles)}`,
    );
  }

  const malformedKbFileSet = new Set(malformedKbFiles);
  const skippedSelectedFiles = selection.files.filter((file) => malformedKbFileSet.has(file));
  if (skippedSelectedFiles.length > 0) {
    warnings.push(
      `Skipped ${skippedSelectedFiles.length} malformed selected fact file${skippedSelectedFiles.length === 1 ? "" : "s"} from distillation: ${summarizeFiles(skippedSelectedFiles)}`,
    );
  }

  const scannedFiles = selection.files.filter((file) => !malformedKbFileSet.has(file));
  if (scannedFiles.length === 0) {
    return {
      kbRoot: request.kbRoot,
      scannedFiles,
      comparedFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      candidateGroupsReviewed: 0,
      duplicatesRemoved: 0,
      duplicateGroups: 0,
      removedFactGroups: [],
      duplicatePasses: [],
      semanticFilesReviewed: 0,
      semanticFilesModified: [],
      semanticIssuesFound: 0,
      semanticIssuesResolved: 0,
      semanticIssuesSkipped: 0,
      semanticCleanupResults: [],
      semanticActionAudit: [],
      warnings,
    };
  }

  const duplicatePasses: DuplicatePassResult[] = [];

  const initialDuplicatePass = await runDuplicatePass(request.kbRoot, scannedFiles, "initial", options);
  duplicatePasses.push(initialDuplicatePass);
  warnings.push(...initialDuplicatePass.warnings);

  const survivingSelectedFiles = scannedFiles.filter((file) => !initialDuplicatePass.deletedFiles.includes(file));
  const semanticCleanupRun = options.proposeSemanticCleanup && survivingSelectedFiles.length > 0
    ? await resolveSemanticCleanupForFiles({
      kbRoot: request.kbRoot,
      files: survivingSelectedFiles,
      proposeSemanticCleanup: options.proposeSemanticCleanup,
      onProgress: (processed, total) => {
        options.onProgress?.({ stage: "semantic_cleanup", processed, total });
      },
    })
    : createEmptySemanticCleanupRunResult();
  warnings.push(...semanticCleanupRun.warnings);

  if (semanticCleanupRun.modifiedFiles.length > 0) {
    const postSemanticDuplicatePass = await runDuplicatePass(
      request.kbRoot,
      semanticCleanupRun.modifiedFiles,
      "post_semantic_cleanup",
      options,
    );
    duplicatePasses.push(postSemanticDuplicatePass);
    warnings.push(...postSemanticDuplicatePass.warnings);
  }

  const comparedFiles = uniqueSorted(duplicatePasses.flatMap((pass) => pass.comparedFiles));
  const modifiedFiles = uniqueSorted([
    ...duplicatePasses.flatMap((pass) => pass.modifiedFiles),
    ...semanticCleanupRun.modifiedFiles,
  ]);
  const deletedFiles = uniqueSorted(duplicatePasses.flatMap((pass) => pass.deletedFiles));
  const removedFactGroups = duplicatePasses.flatMap((pass) => pass.removedFactGroups);
  const candidateGroupsReviewed = duplicatePasses.reduce((sum, pass) => sum + pass.candidateGroupsReviewed, 0);
  const duplicateGroups = duplicatePasses.reduce((sum, pass) => sum + pass.duplicateGroups, 0);
  const duplicatesRemoved = duplicatePasses.reduce((sum, pass) => sum + pass.duplicatesRemoved, 0);

  return {
    kbRoot: request.kbRoot,
    scannedFiles,
    comparedFiles,
    modifiedFiles,
    deletedFiles,
    candidateGroupsReviewed,
    duplicatesRemoved,
    duplicateGroups,
    removedFactGroups,
    duplicatePasses,
    semanticFilesReviewed: semanticCleanupRun.filesReviewed.length,
    semanticFilesModified: uniqueSorted(semanticCleanupRun.modifiedFiles),
    semanticIssuesFound: semanticCleanupRun.issuesFound.length,
    semanticIssuesResolved: semanticCleanupRun.issuesResolved.length,
    semanticIssuesSkipped: semanticCleanupRun.issuesSkipped.length,
    semanticCleanupResults: semanticCleanupRun.fileResults,
    semanticActionAudit: semanticCleanupRun.actionAudit,
    semanticBackupRoot: semanticCleanupRun.backupRoot,
    warnings,
  };
}
