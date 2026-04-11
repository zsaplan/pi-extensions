import fs from "node:fs";
import path from "node:path";
import { ensureWithinRoot, toRootRelativePath } from "./paths.ts";

export type ResolveMarkdownFilesInput = {
  files?: string[];
  directories?: string[];
  recursive?: boolean;
};

export type ResolveMarkdownFilesResult = {
  files: string[];
  warnings: string[];
};

function stripLeadingAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function splitIntoLines(value: string): string[] {
  const normalized = normalizeNewlines(value);
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export function listMarkdownFiles(root: string): string[] {
  const entries: string[] = [];

  function walk(currentDir: string): void {
    const directoryEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of directoryEntries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      entries.push(toRootRelativePath(root, fullPath));
    }
  }

  walk(root);
  return entries.sort();
}

function addMarkdownFilesFromDirectory(
  kbRoot: string,
  absoluteDirPath: string,
  recursive: boolean,
  files: Set<string>,
): void {
  const directoryEntries = fs.readdirSync(absoluteDirPath, { withFileTypes: true });
  for (const entry of directoryEntries) {
    const fullPath = path.join(absoluteDirPath, entry.name);
    if (entry.isDirectory()) {
      if (recursive) addMarkdownFilesFromDirectory(kbRoot, fullPath, recursive, files);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    files.add(toRootRelativePath(kbRoot, fullPath));
  }
}

export function resolveMarkdownFiles(kbRoot: string, input: ResolveMarkdownFilesInput): ResolveMarkdownFilesResult {
  const resolvedFiles = new Set<string>();
  const warnings: string[] = [];
  const recursive = input.recursive ?? true;

  for (const rawFilePath of input.files ?? []) {
    const filePath = stripLeadingAt(rawFilePath.trim());
    if (!filePath) continue;

    try {
      const absolutePath = ensureWithinRoot(kbRoot, filePath);
      if (!fs.existsSync(absolutePath)) {
        warnings.push(`Skipped missing file: ${filePath}`);
        continue;
      }

      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        warnings.push(`Skipped non-file path: ${filePath}`);
        continue;
      }

      if (!absolutePath.endsWith(".md")) {
        warnings.push(`Skipped non-markdown file: ${filePath}`);
        continue;
      }

      resolvedFiles.add(toRootRelativePath(kbRoot, absolutePath));
    } catch {
      warnings.push(`Skipped file outside KB root: ${filePath}`);
    }
  }

  for (const rawDirectoryPath of input.directories ?? []) {
    const directoryPath = stripLeadingAt(rawDirectoryPath.trim());
    if (!directoryPath) continue;

    try {
      const absolutePath = ensureWithinRoot(kbRoot, directoryPath);
      if (!fs.existsSync(absolutePath)) {
        warnings.push(`Skipped missing directory: ${directoryPath}`);
        continue;
      }

      const stat = fs.statSync(absolutePath);
      if (!stat.isDirectory()) {
        warnings.push(`Skipped non-directory path: ${directoryPath}`);
        continue;
      }

      addMarkdownFilesFromDirectory(kbRoot, absolutePath, recursive, resolvedFiles);
    } catch {
      warnings.push(`Skipped directory outside KB root: ${directoryPath}`);
    }
  }

  return {
    files: [...resolvedFiles].sort(),
    warnings,
  };
}
