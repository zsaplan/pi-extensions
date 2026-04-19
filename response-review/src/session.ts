import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, resolve} from 'node:path';
import {
  SessionManager,
  type ExtensionCommandContext,
  type SessionEntry,
} from '@mariozechner/pi-coding-agent';
import type {
  LoadedResponseReviewSession,
  ResponseReviewEntryData,
  ResponseReviewSessionSource,
} from './types.js';

type ResponseReviewSessionManager = Pick<
  SessionManager,
  'getCwd' | 'getSessionFile' | 'getSessionId' | 'getSessionName' | 'getBranch'
>;

const SESSION_PICK_LIMIT = 200;
const RESPONSE_PREVIEW_LIMIT = 160;
const USER_PREVIEW_LIMIT = 120;

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

function normalizeSingleQuotes(value: string): string {
  return value.replace(/[\u2018\u2019\u02bc]/g, "'");
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function toPreview(value: string, maxLength: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  return value.replace(/\r\n?/g, '\n').split('\n').length;
}

function extractVisibleText(
  content: unknown,
  options?: {includeImages?: boolean},
): string {
  if (typeof content === 'string') {
    return normalizeSingleQuotes(content).trim();
  }
  if (!Array.isArray(content)) return '';

  const blocks: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const candidate = block as {type?: string; text?: string};
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      blocks.push(candidate.text);
      continue;
    }
    if (candidate.type === 'image' && options?.includeImages) {
      blocks.push('[image]');
    }
  }

  return normalizeSingleQuotes(blocks.join('\n\n')).trim();
}

function getAssistantResponseText(entry: SessionEntry): string {
  if (entry.type !== 'message') return '';
  if (entry.message.role !== 'assistant') return '';
  return extractVisibleText(entry.message.content);
}

function getUserMessageText(entry: SessionEntry): string {
  if (entry.type !== 'message') return '';
  if (entry.message.role !== 'user') return '';
  return extractVisibleText(entry.message.content, {includeImages: true});
}

function entryTimestampMs(entry: SessionEntry): number {
  if (entry.type === 'message' && typeof entry.message.timestamp === 'number') {
    return entry.message.timestamp;
  }
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function buildSessionSource(
  manager: ResponseReviewSessionManager,
  kind: ResponseReviewSessionSource['kind'],
): ResponseReviewSessionSource {
  const sessionPath = manager.getSessionFile() ?? null;
  const sessionName = manager.getSessionName() ?? null;
  const displayTitle =
    sessionName ??
    (sessionPath !== null ? basename(sessionPath) : 'Current live session');

  return {
    kind,
    sessionId: manager.getSessionId(),
    sessionPath,
    cwd: manager.getCwd(),
    name: sessionName,
    displayTitle,
  };
}

function collectAssistantResponses(
  manager: ResponseReviewSessionManager,
): ResponseReviewEntryData[] {
  const branch = manager.getBranch();
  const responses: ResponseReviewEntryData[] = [];
  let lastUserText = '';

  for (const entry of branch) {
    const userText = getUserMessageText(entry);
    if (userText.length > 0) {
      lastUserText = userText;
      continue;
    }

    const responseText = getAssistantResponseText(entry);
    if (responseText.length === 0) continue;

    responses.push({
      id: entry.id,
      index: responses.length + 1,
      timestamp: entryTimestampMs(entry),
      provider:
        entry.type === 'message' && entry.message.role === 'assistant'
          ? (entry.message.provider ?? null)
          : null,
      model:
        entry.type === 'message' && entry.message.role === 'assistant'
          ? (entry.message.model ?? null)
          : null,
      preview: toPreview(responseText, RESPONSE_PREVIEW_LIMIT),
      precedingUserPreview: toPreview(lastUserText, USER_PREVIEW_LIMIT),
      lineCount: countLines(responseText),
      charCount: responseText.length,
      text: responseText.replace(/\r\n?/g, '\n'),
      precedingUserText: lastUserText.replace(/\r\n?/g, '\n'),
    });
  }

  return responses;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveSessionPath(
  rawArg: string,
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  const arg = stripWrappingQuotes(rawArg);
  if (arg.length === 0 || arg === 'current') {
    return null;
  }

  const candidatePath = resolve(ctx.cwd, expandHome(arg));
  if (await pathExists(candidatePath)) {
    return candidatePath;
  }

  const sessions = (await SessionManager.listAll()).sort(
    (a, b) => b.modified.getTime() - a.modified.getTime(),
  );
  const lowered = arg.toLowerCase();
  const matches = sessions.filter(session => {
    if (session.id.startsWith(arg)) return true;
    if (session.path.toLowerCase().includes(lowered)) return true;
    if (session.name?.toLowerCase().includes(lowered)) return true;
    return false;
  });

  if (matches.length === 0) {
    throw new Error(`No session matched: ${arg}`);
  }
  if (matches.length === 1) {
    return matches[0]!.path;
  }

  const limitedMatches = matches
    .slice(0, SESSION_PICK_LIMIT)
    .map(session => {
      const modified = Number.isFinite(session.modified.getTime())
        ? session.modified
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d{3}Z$/, 'Z')
        : 'unknown';
      const label =
        session.name?.trim() ||
        toPreview(session.firstMessage || '(empty session)', 72);
      return `- ${session.id.slice(0, 8)} • ${modified} • ${label} • ${session.path}`;
    })
    .join('\n');

  throw new Error(
    [
      `Multiple sessions matched: ${arg}`,
      'Use /resume or /tree for interactive context selection, or pass a more specific session id/path.',
      limitedMatches,
    ].join('\n'),
  );
}

export async function loadResponseReviewSession(
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<LoadedResponseReviewSession> {
  const resolvedPath = await resolveSessionPath(rawArgs.trim(), ctx);

  if (resolvedPath === null) {
    const responses = collectAssistantResponses(ctx.sessionManager);
    return {
      session: buildSessionSource(ctx.sessionManager, 'current'),
      responses,
    };
  }

  const manager = SessionManager.open(resolvedPath);
  const responses = collectAssistantResponses(manager);
  return {
    session: buildSessionSource(manager, 'session-file'),
    responses,
  };
}
