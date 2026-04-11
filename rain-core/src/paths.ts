import fs from "node:fs";
import path from "node:path";

export const KB_ROOT_ENV_VAR = "PI_RAINMAN_KB_ROOT";
const DEFAULT_KB_DIRNAME = "raincatcher";

export function getDefaultKbRoot(agentDir: string): string {
  return path.join(agentDir, "data", DEFAULT_KB_DIRNAME);
}

export function getKbRoot(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[KB_ROOT_ENV_VAR]?.trim();
  return fromEnv ? path.resolve(fromEnv) : getDefaultKbRoot(agentDir);
}

function getRealRoot(root: string): string {
  return fs.existsSync(root) ? fs.realpathSync.native(root) : path.resolve(root);
}

export function ensureMarkdownRelativePath(filePath: string): void {
  if (!filePath.endsWith(".md")) {
    throw new Error(`Only markdown files are allowed: ${filePath}`);
  }

  if (path.isAbsolute(filePath)) {
    throw new Error(`Absolute paths are not allowed: ${filePath}`);
  }
}

export function ensureWithinRoot(root: string, targetPath: string): string {
  const realRoot = getRealRoot(root);
  const candidatePath = path.isAbsolute(targetPath) ? targetPath : path.resolve(realRoot, targetPath);
  const actualPath = fs.existsSync(candidatePath) ? fs.realpathSync.native(candidatePath) : path.resolve(candidatePath);
  const relative = path.relative(realRoot, actualPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${targetPath}`);
  }

  return actualPath;
}

export function toRootRelativePath(root: string, absolutePath: string): string {
  const realRoot = getRealRoot(root);
  const actualPath = fs.existsSync(absolutePath) ? fs.realpathSync.native(absolutePath) : path.resolve(absolutePath);
  const relative = path.relative(realRoot, actualPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Resolved path escapes root: ${absolutePath}`);
  }

  return relative.split(path.sep).join("/");
}
