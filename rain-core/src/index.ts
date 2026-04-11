export {
  KB_ROOT_ENV_VAR,
  ensureMarkdownRelativePath,
  ensureWithinRoot,
  getDefaultKbRoot,
  getKbRoot,
  toRootRelativePath,
} from "./paths.ts";
export {
  listMarkdownFiles,
  normalizeNewlines,
  resolveMarkdownFiles,
  splitIntoLines,
  type ResolveMarkdownFilesInput,
  type ResolveMarkdownFilesResult,
} from "./markdown.ts";
export {
  extractBulletText,
  factHeading,
  normalizeFact,
  normalizeWhitespace,
  parseFactFileContent,
  renderMarkdown,
  sanitizeKeyPart,
  sanitizeSubject,
  sanitizeTopic,
  toFactFilename,
  type FactBullet,
  type ParsedFactFile,
} from "./facts.ts";
export {
  scanDuplicateCandidateGroups,
  type CandidatePair,
  type DedupeSimilarity,
  type DuplicateCandidateGroup,
  type FactRecord,
  type ScanDuplicateCandidateGroupsResult,
} from "./dedupe.ts";
