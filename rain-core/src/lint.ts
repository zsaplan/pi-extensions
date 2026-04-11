import fs from "node:fs";
import { ensureWithinRoot } from "./paths.ts";
import {
  isStructuredFactIdentityToken,
  parseStructuredFactHeadingLine,
  parseStructuredFactLine,
  StructuredFactParseError,
  type StructuredFactParseOptions,
} from "./factSchema.ts";
import {
  listMarkdownFiles,
  resolveMarkdownFiles,
  splitIntoLines,
  type ResolveMarkdownFilesInput,
} from "./markdown.ts";

const FACT_FILENAME_PATTERN = /^([A-Z0-9]+(?:_[A-Z0-9]+)*)__([A-Z0-9]+(?:_[A-Z0-9]+)*)\.md$/;

export type LintSeverity = "error" | "warning";

export type FactLintIssue = {
  code: string;
  severity: LintSeverity;
  file: string;
  line?: number;
  message: string;
};

export type FactLintOptions = StructuredFactParseOptions;

export type FactFileLintResult = {
  file: string;
  issues: FactLintIssue[];
};

export type KnowledgeBaseLintResult = {
  files: string[];
  issues: FactLintIssue[];
  warnings: string[];
};

function createIssue(file: string, code: string, message: string, line?: number): FactLintIssue {
  return {
    code,
    severity: "error",
    file,
    line,
    message,
  };
}

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

function hasExplicitSelection(input?: ResolveMarkdownFilesInput): boolean {
  return (input?.files?.length ?? 0) > 0 || (input?.directories?.length ?? 0) > 0;
}

function lintFilename(filePath: string): { subjectFromFilename: string | null; topicFromFilename: string | null; issues: FactLintIssue[] } {
  const file = filePath.split(/[\\/]/).pop() ?? filePath;
  const issues: FactLintIssue[] = [];

  const exactMatch = file.match(FACT_FILENAME_PATTERN);
  if (!exactMatch) {
    issues.push(
      createIssue(
        filePath,
        "INVALID_FILENAME",
        "Filename must match SUBJECT__TOPIC.md.",
      ),
    );
  }

  const basename = file.endsWith(".md") ? file.slice(0, -3) : file;
  const parts = basename.split("__");
  const rawSubject = parts.length === 2 ? parts[0] ?? "" : "";
  const rawTopic = parts.length === 2 ? parts[1] ?? "" : "";

  const subjectIsValid = rawSubject.length > 0 && isStructuredFactIdentityToken(rawSubject);
  const topicIsValid = rawTopic.length > 0 && isStructuredFactIdentityToken(rawTopic);

  if (parts.length === 2 && !subjectIsValid) {
    issues.push(
      createIssue(
        filePath,
        "INVALID_SUBJECT_TOKEN",
        "Filename subject token must match ^[A-Z0-9]+(?:_[A-Z0-9]+)*$.",
      ),
    );
  }

  if (parts.length === 2 && !topicIsValid) {
    issues.push(
      createIssue(
        filePath,
        "INVALID_TOPIC_TOKEN",
        "Filename topic token must match ^[A-Z0-9]+(?:_[A-Z0-9]+)*$.",
      ),
    );
  }

  return {
    subjectFromFilename: subjectIsValid ? rawSubject : null,
    topicFromFilename: topicIsValid ? rawTopic : null,
    issues,
  };
}

export function lintFactFileContent(
  filePath: string,
  content: string,
  options: FactLintOptions = {},
): FactFileLintResult {
  const issues: FactLintIssue[] = [];
  const { subjectFromFilename, topicFromFilename, issues: filenameIssues } = lintFilename(filePath);
  issues.push(...filenameIssues);

  const lines = splitIntoLines(content);
  const firstNonBlankLineIndex = lines.findIndex((line) => line.trim().length > 0);

  let headingLineIndex: number | null = null;
  let subjectFromHeading: string | null = null;
  let topicFromHeading: string | null = null;

  if (firstNonBlankLineIndex < 0) {
    issues.push(
      createIssue(
        filePath,
        "MISSING_HEADING",
        "First non-blank line must be exactly '# SUBJECT / TOPIC'.",
        1,
      ),
    );
  } else {
    headingLineIndex = firstNonBlankLineIndex;
    const firstNonBlankLine = lines[firstNonBlankLineIndex] ?? "";
    const parsedHeading = parseStructuredFactHeadingLine(firstNonBlankLine);

    if (parsedHeading) {
      subjectFromHeading = parsedHeading.subject;
      topicFromHeading = parsedHeading.topic;
    } else if (firstNonBlankLine.trim().startsWith("#")) {
      issues.push(
        createIssue(
          filePath,
          "INVALID_HEADING_FORMAT",
          "Heading must be exactly '# SUBJECT / TOPIC' using canonical uppercase subject/topic tokens.",
          firstNonBlankLineIndex + 1,
        ),
      );
    } else {
      issues.push(
        createIssue(
          filePath,
          "MISSING_HEADING",
          "First non-blank line must be exactly '# SUBJECT / TOPIC'.",
          firstNonBlankLineIndex + 1,
        ),
      );
    }
  }

  if (
    headingLineIndex !== null
    && subjectFromFilename
    && topicFromFilename
    && subjectFromHeading
    && topicFromHeading
    && (subjectFromFilename !== subjectFromHeading || topicFromFilename !== topicFromHeading)
  ) {
    issues.push(
      createIssue(
        filePath,
        "HEADING_FILENAME_MISMATCH",
        "Heading subject/topic does not match the filename subject/topic.",
        headingLineIndex + 1,
      ),
    );
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    if (line.trim().length === 0) continue;

    const isHeadingLine = lineIndex === firstNonBlankLineIndex && line.trim().startsWith("#");
    if (isHeadingLine) continue;

    try {
      const parsed = parseStructuredFactLine(line, options);
      if (parsed !== null) continue;

      issues.push(
        createIssue(
          filePath,
          "UNEXPECTED_CONTENT",
          "Only blank lines and structured fact bullets are allowed outside the heading line.",
          lineIndex + 1,
        ),
      );
    } catch (error) {
      if (error instanceof StructuredFactParseError) {
        issues.push(createIssue(filePath, error.code, error.message, lineIndex + 1));
        continue;
      }

      throw error;
    }
  }

  return {
    file: filePath,
    issues: sortIssues(issues),
  };
}

export function lintKnowledgeBase(
  kbRoot: string,
  input?: ResolveMarkdownFilesInput,
  options: FactLintOptions = {},
): KnowledgeBaseLintResult {
  const resolved = hasExplicitSelection(input)
    ? resolveMarkdownFiles(kbRoot, input ?? {})
    : { files: listMarkdownFiles(kbRoot), warnings: [] };

  const issues: FactLintIssue[] = [];
  const warnings = [...resolved.warnings];

  for (const file of resolved.files) {
    try {
      const absolutePath = ensureWithinRoot(kbRoot, file);
      if (!fs.existsSync(absolutePath)) {
        warnings.push(`Skipped missing file during lint: ${file}`);
        continue;
      }

      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        warnings.push(`Skipped non-file path during lint: ${file}`);
        continue;
      }

      const content = fs.readFileSync(absolutePath, "utf8");
      issues.push(...lintFactFileContent(file, content, options).issues);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped unreadable file during lint: ${file} (${message})`);
    }
  }

  return {
    files: [...resolved.files],
    issues: sortIssues(issues),
    warnings,
  };
}
