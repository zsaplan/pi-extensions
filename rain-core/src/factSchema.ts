import { splitIntoLines } from "./markdown.ts";

const FACT_IDENTITY_TOKEN_PATTERN = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const FACT_HEADING_PATTERN = /^# ([A-Z0-9]+(?:_[A-Z0-9]+)*) \/ ([A-Z0-9]+(?:_[A-Z0-9]+)*)$/;
const FACT_RELATION_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FACT_QUALIFIER_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export type StructuredFactParseIssueCode =
  | "INVALID_BULLET_FORMAT"
  | "MISSING_RELATION"
  | "INVALID_RELATION"
  | "UNKNOWN_RELATION"
  | "MISSING_OBJECT"
  | "INVALID_QUALIFIER"
  | "DUPLICATE_QUALIFIER_KEY";

export type FactQualifier = {
  key: string;
  value: string;
};

export type StructuredFactBullet = {
  relation: string;
  object: string;
  qualifiers: FactQualifier[];
};

export type ParsedStructuredFactFile = {
  lines: string[];
  heading: string | null;
  subjectFromHeading: string | null;
  topicFromHeading: string | null;
  bullets: Array<{
    lineIndex: number;
    lineNumber: number;
    rawText: string;
    parsed: StructuredFactBullet;
  }>;
};

export type StructuredFactParseOptions = {
  allowedRelations?: readonly string[];
};

export class StructuredFactParseError extends Error {
  readonly code: StructuredFactParseIssueCode;

  constructor(code: StructuredFactParseIssueCode, message: string) {
    super(message);
    this.name = "StructuredFactParseError";
    this.code = code;
  }
}

export const DEFAULT_FACT_RELATIONS = Object.freeze([
  "DEFINES",
  "USES",
  "REQUIRES",
  "PREFERS",
  "AVOIDS",
  "LOCATED_AT",
  "FIXES",
  "CAUSES",
]) as readonly string[];

export const STRUCTURED_FACT_SYNTAX_GUIDANCE = [
  "Canonical Rain fact files use '# SUBJECT / TOPIC' followed by structured bullets only.",
  "Each fact bullet must use 'RELATION | OBJECT | key=value | key=value'.",
  `Allowed relations: ${DEFAULT_FACT_RELATIONS.join(", ")}.`,
  "subject/topic tokens must be uppercase with underscores.",
  "qualifier keys must be lowercase snake_case.",
  "Do not write prose bullets or freeform sentences.",
  "Example: PREFERS | pi install . | when=installing from source | scope=repo root",
].join("\n");

function createParseError(code: StructuredFactParseIssueCode, message: string): StructuredFactParseError {
  return new StructuredFactParseError(code, message);
}

function getAllowedRelations(options: StructuredFactParseOptions): Set<string> {
  return new Set(options.allowedRelations ?? DEFAULT_FACT_RELATIONS);
}

function parseHeading(line: string): { heading: string; subject: string; topic: string } | null {
  const match = line.match(FACT_HEADING_PATTERN);
  if (!match) return null;

  const subject = match[1] ?? "";
  const topic = match[2] ?? "";
  return {
    heading: `${subject} / ${topic}`,
    subject,
    topic,
  };
}

export function parseStructuredFactBulletText(
  text: string,
  options: StructuredFactParseOptions = {},
): StructuredFactBullet {
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw createParseError("MISSING_RELATION", "Bullet relation is required.");
  }

  const segments = text.split("|").map((segment) => segment.trim());
  if (segments.length < 2) {
    throw createParseError(
      "INVALID_BULLET_FORMAT",
      "Bullet must match '- RELATION | OBJECT | key=value | key=value'.",
    );
  }

  const relation = segments[0] ?? "";
  if (!relation) {
    throw createParseError("MISSING_RELATION", "Bullet relation is required.");
  }

  if (!FACT_RELATION_PATTERN.test(relation)) {
    throw createParseError(
      "INVALID_RELATION",
      "Relation must match ^[A-Z][A-Z0-9_]*$.",
    );
  }

  const allowedRelations = getAllowedRelations(options);
  if (!allowedRelations.has(relation)) {
    throw createParseError(
      "UNKNOWN_RELATION",
      `Relation '${relation}' is not in the allowed relation set.`,
    );
  }

  const object = segments[1] ?? "";
  if (!object) {
    throw createParseError("MISSING_OBJECT", "Bullet object is required.");
  }

  const qualifiers: FactQualifier[] = [];
  const qualifierKeys = new Set<string>();

  for (const qualifierText of segments.slice(2)) {
    if (!qualifierText) {
      throw createParseError(
        "INVALID_QUALIFIER",
        "Qualifier must match key=value with a lowercase key and non-empty value.",
      );
    }

    const separatorIndex = qualifierText.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === qualifierText.length - 1) {
      throw createParseError(
        "INVALID_QUALIFIER",
        "Qualifier must match key=value with a lowercase key and non-empty value.",
      );
    }

    const key = qualifierText.slice(0, separatorIndex).trim();
    const value = qualifierText.slice(separatorIndex + 1).trim();
    if (!FACT_QUALIFIER_KEY_PATTERN.test(key) || !value) {
      throw createParseError(
        "INVALID_QUALIFIER",
        "Qualifier must match key=value with a lowercase key and non-empty value.",
      );
    }

    if (qualifierKeys.has(key)) {
      throw createParseError(
        "DUPLICATE_QUALIFIER_KEY",
        `Qualifier key '${key}' is duplicated within the bullet.`,
      );
    }

    qualifierKeys.add(key);
    qualifiers.push({ key, value });
  }

  return {
    relation,
    object,
    qualifiers,
  };
}

export function parseStructuredFactLine(
  line: string,
  options: StructuredFactParseOptions = {},
): StructuredFactBullet | null {
  if (line.trim().length === 0) return null;

  const dashMatch = line.match(/^(\s*)-(\s*)(.*)$/);
  if (!dashMatch) return null;

  const whitespaceAfterDash = dashMatch[2] ?? "";
  const bulletText = dashMatch[3] ?? "";
  if (whitespaceAfterDash.length === 0 && bulletText.length > 0) {
    throw createParseError(
      "INVALID_BULLET_FORMAT",
      "Bullet must match '- RELATION | OBJECT | key=value | key=value'.",
    );
  }

  return parseStructuredFactBulletText(bulletText, options);
}

export function parseStructuredFactFileContent(
  content: string,
  options: StructuredFactParseOptions = {},
): ParsedStructuredFactFile {
  const lines = splitIntoLines(content);
  const firstNonBlankLineIndex = lines.findIndex((line) => line.trim().length > 0);

  let heading: string | null = null;
  let subjectFromHeading: string | null = null;
  let topicFromHeading: string | null = null;

  if (firstNonBlankLineIndex >= 0) {
    const firstNonBlankLine = lines[firstNonBlankLineIndex] ?? "";
    const parsedHeading = parseHeading(firstNonBlankLine);
    if (parsedHeading) {
      heading = parsedHeading.heading;
      subjectFromHeading = parsedHeading.subject;
      topicFromHeading = parsedHeading.topic;
    } else {
      const genericHeading = firstNonBlankLine.match(/^#\s+(.*)$/)?.[1]?.trim() ?? "";
      heading = genericHeading || null;
    }
  }

  const bullets: ParsedStructuredFactFile["bullets"] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawText = lines[lineIndex] ?? "";
    const parsed = parseStructuredFactLine(rawText, options);
    if (!parsed) continue;

    bullets.push({
      lineIndex,
      lineNumber: lineIndex + 1,
      rawText,
      parsed,
    });
  }

  return {
    lines,
    heading,
    subjectFromHeading,
    topicFromHeading,
    bullets,
  };
}

export function renderStructuredFactBullet(bullet: StructuredFactBullet): string {
  return [
    bullet.relation.trim(),
    bullet.object.trim(),
    ...bullet.qualifiers.map((qualifier) => `${qualifier.key.trim()}=${qualifier.value.trim()}`),
  ].join(" | ");
}

export function renderStructuredFactLine(bullet: StructuredFactBullet): string {
  return `- ${renderStructuredFactBullet(bullet)}`;
}

export function isStructuredFactIdentityToken(value: string): boolean {
  return FACT_IDENTITY_TOKEN_PATTERN.test(value);
}

export function parseStructuredFactHeadingLine(line: string): { heading: string; subject: string; topic: string } | null {
  return parseHeading(line);
}
