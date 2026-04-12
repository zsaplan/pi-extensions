import { splitIntoLines } from "./markdown.ts";

export type FactBullet = {
  lineIndex: number;
  lineNumber: number;
  text: string;
  normalized: string;
};

export type ParsedFactFile = {
  lines: string[];
  bullets: FactBullet[];
  heading: string | null;
  isRaincatcherFactFile: boolean;
};

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeFact(text: string): string {
  return normalizeWhitespace(text)
    .replace(/[.]+$/g, "")
    .toLowerCase();
}

export function sanitizeKeyPart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 80);
  return cleaned || fallback;
}

export function sanitizeSubject(subject: string): string {
  return sanitizeKeyPart(subject, "GENERAL");
}

export function sanitizeTopic(topic: string): string {
  return sanitizeKeyPart(topic, "NOTES");
}

export function toFactFilename(subject: string, topic: string): string {
  return `${sanitizeSubject(subject)}__${sanitizeTopic(topic)}.md`;
}

export function factHeading(subject: string, topic: string): string {
  return `${sanitizeSubject(subject)} / ${sanitizeTopic(topic)}`;
}

export function extractBulletText(line: string): string | null {
  const match = line.match(/^\s*-\s+(.*)$/);
  if (!match) return null;
  const text = normalizeWhitespace(match[1] ?? "");
  return text || null;
}

export function parseFactFileContent(content: string): ParsedFactFile {
  const lines = splitIntoLines(content);
  const bullets: FactBullet[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const text = extractBulletText(line);
    if (!text) continue;
    bullets.push({
      lineIndex: index,
      lineNumber: index + 1,
      text,
      normalized: normalizeFact(text),
    });
  }

  const heading = lines
    .map((line) => line.match(/^#\s+(.*)$/)?.[1]?.trim() ?? "")
    .find(Boolean) ?? null;

  const nonBlankLines = lines.filter((line) => line.trim().length > 0);
  const isRaincatcherFactFile = nonBlankLines.length > 0 && nonBlankLines.every((line) => {
    return /^#\s+/.test(line) || extractBulletText(line) !== null;
  });

  return {
    lines,
    bullets,
    heading,
    isRaincatcherFactFile,
  };
}

export function renderMarkdown(lines: string[]): string {
  const nextLines = [...lines];
  while (nextLines.length > 0 && (nextLines[nextLines.length - 1] ?? "").trim() === "") {
    nextLines.pop();
  }

  if (nextLines.length === 0) return "";
  return `${nextLines.join("\n")}\n`;
}
