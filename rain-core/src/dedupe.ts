import fs from "node:fs";
import path from "node:path";
import { listMarkdownFiles } from "./markdown.ts";
import { normalizeFact, normalizeWhitespace, parseFactFileContent } from "./facts.ts";

const BLOCKING_TOKEN_LIMIT = 4;
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "use",
  "uses",
  "using",
  "was",
  "when",
  "with",
]);

export type FactRecord = {
  id: string;
  filePath: string;
  heading: string | null;
  selected: boolean;
  lineIndex: number;
  lineNumber: number;
  text: string;
  normalized: string;
  headingNormalized: string;
  tokens: string[];
  tokenSet: string[];
  trigrams: string[];
};

export type DedupeSimilarity = {
  exactNormalized: boolean;
  sharedTokenCount: number;
  tokenJaccard: number;
  trigramJaccard: number;
  levenshteinSimilarity: number;
  headingJaccard: number;
  composite: number;
};

export type CandidatePair = {
  leftId: string;
  rightId: string;
  similarity: DedupeSimilarity;
};

export type DuplicateCandidateGroup = {
  id: string;
  kind: "exact" | "near";
  representativeFact: string;
  occurrences: FactRecord[];
  strongestPairs: CandidatePair[];
  maxComposite: number;
};

export type ScanDuplicateCandidateGroupsResult = {
  comparedFiles: string[];
  records: FactRecord[];
  candidateGroups: DuplicateCandidateGroup[];
  warnings: string[];
};

class UnionFind {
  private readonly parents = new Map<string, string>();

  add(id: string): void {
    if (!this.parents.has(id)) this.parents.set(id, id);
  }

  find(id: string): string {
    const parent = this.parents.get(id);
    if (!parent) {
      this.parents.set(id, id);
      return id;
    }
    if (parent === id) return id;
    const root = this.find(parent);
    this.parents.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    this.parents.set(rightRoot, leftRoot);
  }
}

function tokenize(text: string): string[] {
  const matches = normalizeWhitespace(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  return matches ?? [];
}

function stemToken(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function buildHeadingTokens(heading: string | null): string[] {
  if (!heading) return [];
  return unique(tokenize(heading).filter((token) => !STOPWORDS.has(token)));
}

function buildContentTokens(text: string): string[] {
  const tokens = tokenize(text).map((token) => stemToken(token));
  const informative = tokens.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return unique(informative.length > 0 ? informative : tokens.filter((token) => token.length >= 2));
}

function buildTrigrams(text: string): string[] {
  const cleaned = normalizeFact(text)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0) return [];
  if (cleaned.length <= 3) return [cleaned];

  const grams = new Set<string>();
  for (let index = 0; index <= cleaned.length - 3; index += 1) {
    grams.add(cleaned.slice(index, index + 3));
  }
  return [...grams];
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;

  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }

  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function sharedTokenCount(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  return unique(left).filter((token) => rightSet.has(token)).length;
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const current = new Array<number>(right.length + 1).fill(0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }

    for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
      previous[rightIndex] = current[rightIndex] ?? 0;
    }
  }

  return previous[right.length] ?? 0;
}

function levenshteinSimilarity(left: string, right: string): number {
  const longestLength = Math.max(left.length, right.length);
  if (longestLength === 0) return 1;
  return 1 - (levenshteinDistance(left, right) / longestLength);
}

function buildSimilarity(left: FactRecord, right: FactRecord): DedupeSimilarity {
  const tokenJaccard = jaccard(left.tokenSet, right.tokenSet);
  const trigramJaccard = jaccard(left.trigrams, right.trigrams);
  const headingJaccard = jaccard(buildHeadingTokens(left.heading), buildHeadingTokens(right.heading));
  const editSimilarity = levenshteinSimilarity(left.normalized, right.normalized);
  const exactNormalized = left.normalized === right.normalized;
  const sharedTokens = sharedTokenCount(left.tokenSet, right.tokenSet);
  const composite = Math.min(
    1,
    (tokenJaccard * 0.42)
      + (trigramJaccard * 0.28)
      + (editSimilarity * 0.22)
      + (headingJaccard * 0.08)
      + (sharedTokens >= 3 ? 0.05 : 0)
      + (exactNormalized ? 0.35 : 0),
  );

  return {
    exactNormalized,
    sharedTokenCount: sharedTokens,
    tokenJaccard,
    trigramJaccard,
    levenshteinSimilarity: editSimilarity,
    headingJaccard,
    composite,
  };
}

function shouldLinkBySimilarity(similarity: DedupeSimilarity): boolean {
  if (similarity.exactNormalized) return true;
  if (similarity.sharedTokenCount >= 4 && similarity.composite >= 0.72) return true;
  if (similarity.sharedTokenCount >= 3 && similarity.tokenJaccard >= 0.55 && similarity.trigramJaccard >= 0.42) return true;
  if (similarity.sharedTokenCount >= 2 && similarity.levenshteinSimilarity >= 0.86 && similarity.trigramJaccard >= 0.45) return true;
  return similarity.composite >= 0.82;
}

function sortOccurrences(left: FactRecord, right: FactRecord): number {
  if (left.selected !== right.selected) return left.selected ? 1 : -1;

  const fileCompare = left.filePath.localeCompare(right.filePath);
  if (fileCompare !== 0) return fileCompare;

  return left.lineIndex - right.lineIndex;
}

function buildBlockingKeys(record: FactRecord, tokenFrequency: Map<string, number>): string[] {
  const rankedTokens = [...record.tokenSet]
    .filter((token) => token.length >= 4)
    .sort((left, right) => {
      const frequencyCompare = (tokenFrequency.get(left) ?? 0) - (tokenFrequency.get(right) ?? 0);
      if (frequencyCompare !== 0) return frequencyCompare;
      return right.length - left.length;
    })
    .slice(0, BLOCKING_TOKEN_LIMIT)
    .map((token) => `t:${token}`);

  if (rankedTokens.length > 0) return rankedTokens;

  const headingTokens = buildHeadingTokens(record.heading)
    .slice(0, 2)
    .map((token) => `h:${token}`);
  if (headingTokens.length > 0) return headingTokens;

  return [`p:${record.normalized.slice(0, 12)}`];
}

function collectRecords(kbRoot: string, comparedFiles: string[], selectedFiles: Set<string>): { records: FactRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const records: FactRecord[] = [];

  for (const filePath of comparedFiles) {
    const absolutePath = path.join(kbRoot, filePath);
    if (!fs.existsSync(absolutePath)) {
      if (selectedFiles.has(filePath)) warnings.push(`Skipped missing file during scan: ${filePath}`);
      continue;
    }

    const parsed = parseFactFileContent(fs.readFileSync(absolutePath, "utf8"));
    for (const bullet of parsed.bullets) {
      const headingNormalized = normalizeFact(parsed.heading ?? "");
      const tokenSet = buildContentTokens(bullet.text);
      records.push({
        id: `${filePath}:${bullet.lineIndex}`,
        filePath,
        heading: parsed.heading,
        selected: selectedFiles.has(filePath),
        lineIndex: bullet.lineIndex,
        lineNumber: bullet.lineNumber,
        text: bullet.text,
        normalized: bullet.normalized,
        headingNormalized,
        tokens: tokenize(bullet.text),
        tokenSet,
        trigrams: buildTrigrams(bullet.text),
      });
    }
  }

  return { records, warnings };
}

export function scanDuplicateCandidateGroups(kbRoot: string, scannedFiles: string[]): ScanDuplicateCandidateGroupsResult {
  const comparedFileSet = new Set<string>([...listMarkdownFiles(kbRoot), ...scannedFiles]);
  const comparedFiles = [...comparedFileSet].sort();
  const selectedFiles = new Set(scannedFiles);
  const { records, warnings } = collectRecords(kbRoot, comparedFiles, selectedFiles);

  const recordById = new Map(records.map((record) => [record.id, record]));
  const tokenFrequency = new Map<string, number>();
  for (const record of records) {
    for (const token of record.tokenSet) {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    }
  }

  const unionFind = new UnionFind();
  const pairMap = new Map<string, CandidatePair>();
  const blockingIndex = new Map<string, string[]>();

  for (const record of records) unionFind.add(record.id);

  for (const record of records) {
    const keys = buildBlockingKeys(record, tokenFrequency);
    for (const key of keys) {
      const list = blockingIndex.get(key) ?? [];
      list.push(record.id);
      blockingIndex.set(key, list);
    }
  }

  const exactGroups = new Map<string, FactRecord[]>();
  for (const record of records) {
    const list = exactGroups.get(record.normalized) ?? [];
    list.push(record);
    exactGroups.set(record.normalized, list);
  }

  for (const occurrences of exactGroups.values()) {
    if (occurrences.length < 2) continue;
    if (!occurrences.some((occurrence) => occurrence.selected)) continue;

    const sorted = [...occurrences].sort(sortOccurrences);
    const seed = sorted[0]!;
    for (let index = 1; index < sorted.length; index += 1) {
      const other = sorted[index]!;
      const similarity = buildSimilarity(seed, other);
      const key = [seed.id, other.id].sort().join("::");
      pairMap.set(key, { leftId: seed.id, rightId: other.id, similarity });
      unionFind.union(seed.id, other.id);
    }
  }

  const recordsToExplore = records.filter((record) => record.selected);
  for (const record of recordsToExplore) {
    const candidateIds = new Set<string>();
    for (const key of buildBlockingKeys(record, tokenFrequency)) {
      for (const candidateId of blockingIndex.get(key) ?? []) {
        candidateIds.add(candidateId);
      }
    }

    for (const candidateId of candidateIds) {
      if (candidateId === record.id) continue;
      const candidate = recordById.get(candidateId);
      if (!candidate) continue;

      const pairKey = [record.id, candidate.id].sort().join("::");
      if (pairMap.has(pairKey)) continue;

      const similarity = buildSimilarity(record, candidate);
      if (!shouldLinkBySimilarity(similarity)) continue;

      pairMap.set(pairKey, { leftId: record.id, rightId: candidate.id, similarity });
      unionFind.union(record.id, candidate.id);
    }
  }

  const componentMembers = new Map<string, FactRecord[]>();
  for (const record of records) {
    const root = unionFind.find(record.id);
    const list = componentMembers.get(root) ?? [];
    list.push(record);
    componentMembers.set(root, list);
  }

  const candidateGroups: DuplicateCandidateGroup[] = [];
  let groupIndex = 0;

  for (const members of componentMembers.values()) {
    if (members.length < 2) continue;
    if (!members.some((member) => member.selected)) continue;

    const memberIds = new Set(members.map((member) => member.id));
    const strongestPairs = [...pairMap.values()]
      .filter((pair) => memberIds.has(pair.leftId) && memberIds.has(pair.rightId))
      .sort((left, right) => right.similarity.composite - left.similarity.composite)
      .slice(0, 12);

    if (strongestPairs.length === 0) continue;

    const sortedMembers = [...members].sort(sortOccurrences);
    const distinctNormalized = new Set(sortedMembers.map((member) => member.normalized));
    candidateGroups.push({
      id: `group-${groupIndex += 1}`,
      kind: distinctNormalized.size === 1 ? "exact" : "near",
      representativeFact: sortedMembers[0]?.text ?? "",
      occurrences: sortedMembers,
      strongestPairs,
      maxComposite: strongestPairs[0]?.similarity.composite ?? 0,
    });
  }

  candidateGroups.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "exact" ? -1 : 1;
    return right.maxComposite - left.maxComposite;
  });

  return {
    comparedFiles,
    records,
    candidateGroups,
    warnings,
  };
}
