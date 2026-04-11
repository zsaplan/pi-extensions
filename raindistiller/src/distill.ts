import fs from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import {
  extractBulletText,
  parseFactFileContent,
  renderMarkdown,
  resolveMarkdownFiles,
  scanDuplicateCandidateGroups,
  type DuplicateCandidateGroup,
} from "../../rain-core/src/index.ts";

export type DistillRequest = {
  kbRoot: string;
  files?: string[];
  directories?: string[];
  recursive?: boolean;
};

export type DuplicateGroup = DuplicateCandidateGroup;

export type DuplicateGroupDecision = {
  action: "dedupe" | "keep_all";
  keepOccurrenceId?: string;
  reason?: string;
};

export type DistillOptions = {
  adjudicateGroup?: (group: DuplicateGroup) => Promise<DuplicateGroupDecision | null | undefined>;
};

export type RemovedFactGroup = {
  fact: string;
  kind: DuplicateGroup["kind"];
  keptIn: string;
  keptOccurrenceId: string;
  removedFrom: string[];
  reason?: string;
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
  warnings: string[];
};

type ApplyFileResult = {
  modified: boolean;
  deleted: boolean;
  removedCount: number;
};

function buildDefaultDecision(group: DuplicateGroup): DuplicateGroupDecision {
  return {
    action: "dedupe",
    keepOccurrenceId: group.occurrences[0]?.id,
    reason: group.kind === "exact" ? "default exact-match dedupe" : "default near-duplicate dedupe",
  };
}

function validateDecision(group: DuplicateGroup, decision: DuplicateGroupDecision): DuplicateGroupDecision | null {
  if (decision.action === "keep_all") return decision;
  if (!decision.keepOccurrenceId) return null;
  if (!group.occurrences.some((occurrence) => occurrence.id === decision.keepOccurrenceId)) return null;
  return decision;
}

async function applyRemovals(absolutePath: string, lineIndexesToRemove: Set<number>): Promise<ApplyFileResult> {
  return withFileMutationQueue(absolutePath, async () => {
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

export async function distillKnowledgeFiles(
  request: DistillRequest,
  options: DistillOptions = {},
): Promise<DistillResult> {
  const selection = resolveMarkdownFiles(request.kbRoot, {
    files: request.files,
    directories: request.directories,
    recursive: request.recursive,
  });
  const scannedFiles = selection.files;
  const warnings = [...selection.warnings];

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
      warnings,
    };
  }

  const scan = scanDuplicateCandidateGroups(request.kbRoot, scannedFiles);
  warnings.push(...scan.warnings);

  const selectedFiles = new Set(scannedFiles);
  const removalsByFile = new Map<string, Set<number>>();
  const removedFactGroups: RemovedFactGroup[] = [];
  let duplicateGroups = 0;

  for (const group of scan.candidateGroups) {
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
      fact: group.representativeFact,
      kind: group.kind,
      keptIn: keptOccurrence.filePath,
      keptOccurrenceId: keptOccurrence.id,
      removedFrom: [...new Set(removedFrom)].sort(),
      reason: decision.reason,
    });
  }

  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];
  let duplicatesRemoved = 0;

  for (const filePath of scannedFiles) {
    const lineIndexesToRemove = removalsByFile.get(filePath);
    if (!lineIndexesToRemove || lineIndexesToRemove.size === 0) continue;

    const absolutePath = path.join(request.kbRoot, filePath);
    const result = await applyRemovals(absolutePath, lineIndexesToRemove);
    if (!result.modified) continue;

    duplicatesRemoved += result.removedCount;
    modifiedFiles.push(filePath);
    if (result.deleted) deletedFiles.push(filePath);
  }

  return {
    kbRoot: request.kbRoot,
    scannedFiles,
    comparedFiles: scan.comparedFiles,
    modifiedFiles,
    deletedFiles,
    candidateGroupsReviewed: scan.candidateGroups.length,
    duplicatesRemoved,
    duplicateGroups,
    removedFactGroups,
    warnings,
  };
}
