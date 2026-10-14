import {constants} from 'node:fs';
import {open, opendir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {
  buildSessionProjection,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import {digest, record, StoreError} from './store.ts';

export function referenceText(value: string): string {
  for (const [name, secret] of Object.entries(process.env))
    if (
      /(?:TOKEN|SECRET|PASSWORD|API_KEY|SERVICE_ACCOUNT_KEY)$/.test(name) &&
      secret &&
      secret.length >= 8
    )
      value = value.replaceAll(secret, '[REDACTED]');
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[REDACTED_KEY]',
    )
    .replace(
      /((?:authorization|password|secret|token|api[_-]?key)["']?\s*[:=]\s*)[^\r\n]*/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:Bearer|Basic)\s+[\w.+/=-]+/gi, '[REDACTED_AUTH]')
    .replace(
      /\b(?:xox[baprs]-|sk-(?:proj-)?)[A-Za-z0-9_-]+/g,
      '[REDACTED_TOKEN]',
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, '[REDACTED_SSN]');
}

// Filename-only lookup under one operator-selected library (root plus one directory level).
// Never open unrelated transcript bodies, follow symlinks, migrate or resume a session.
export async function readReferencedSession(
  library: string,
  id: string,
  signal: AbortSignal,
) {
  const root = await realpath(library);
  let visited = 0;
  const matches: string[] = [];
  const scan = async (directory: string, depth: number) => {
    signal.throwIfAborted();
    if ((await realpath(directory)) !== directory)
      throw new StoreError('reference_symlink');
    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted();
      if (++visited > 20000) throw new StoreError('session_lookup_limit');
      const file = path.join(directory, entry.name);
      if (
        entry.name.endsWith(`_${id}.jsonl`) &&
        (entry.isFile() || entry.isSymbolicLink())
      ) {
        if (entry.isSymbolicLink()) throw new StoreError('reference_symlink');
        matches.push(file);
      } else if (depth === 0 && entry.isDirectory()) await scan(file, 1);
    }
  };
  await scan(root, 0);
  if (matches.length !== 1)
    throw new StoreError(
      matches.length
        ? 'ambiguous_session_reference'
        : 'session_reference_not_found',
    );
  const file = matches[0];
  if ((await realpath(file)) !== file)
    throw new StoreError('reference_symlink');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 8 * 1024 * 1024)
      throw new StoreError('session_reference_too_large');
    bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      signal.throwIfAborted();
      const {bytesRead} = await handle.read(
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (!bytesRead) throw new StoreError('session_reference_changed');
      position += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new StoreError('session_reference_changed');
  } finally {
    await handle.close();
  }
  signal.throwIfAborted();
  let entries: Record<string, unknown>[];
  try {
    entries = bytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map(line => record(JSON.parse(line)));
  } catch {
    throw new StoreError('invalid_session_reference');
  }
  const [header, ...body] = entries;
  if (
    header.type !== 'session' ||
    header.id !== id ||
    ![2, 3].includes(Number(header.version)) ||
    body.length > 20000
  )
    throw new StoreError('invalid_session_reference');
  // Reject cycles, duplicate IDs and missing parents before the SDK's pure tree traversal.
  const ids = new Set<string>();
  for (const entry of body) {
    if (
      typeof entry.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) ||
      typeof entry.timestamp !== 'string' ||
      entry.timestamp.length > 40 ||
      !Number.isFinite(Date.parse(entry.timestamp)) ||
      ids.has(entry.id) ||
      (entry.parentId !== null &&
        (typeof entry.parentId !== 'string' || !ids.has(entry.parentId)))
    )
      throw new StoreError('invalid_session_tree');
    ids.add(entry.id);
  }
  let projection;
  try {
    projection = buildSessionProjection(body as unknown as SessionEntry[]);
  } catch {
    throw new StoreError('invalid_session_reference');
  }
  const messages = projection.entries
    .flatMap(({sourceEntry, messages}) =>
      messages.flatMap(message => {
        if (
          !['user', 'assistant', 'compactionSummary', 'branchSummary'].includes(
            message.role,
          )
        )
          return [];
        const content =
          'content' in message
            ? message.content
            : 'summary' in message
              ? message.summary
              : '';
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter(block => block.type === 'text')
                  .map(block => block.text)
                  .join('\n')
              : '';
        if (!text.trim()) return [];
        const clean = referenceText(text);
        return [
          {
            entry_id: sourceEntry.id,
            at: sourceEntry.timestamp,
            role: message.role,
            text: clean.slice(0, 2000),
            text_truncated: clean.length > 2000,
          },
        ];
      }),
    )
    .reverse();
  return {
    session_id: id,
    snapshot_sha256: digest(bytes.toString('utf8')),
    messages,
    coverage:
      'Last persisted branch, with SDK compaction and context edits applied; newest text first. User/assistant text and summaries only. System prompts, thinking, tool calls/results, images and custom state are withheld. Reported work is not independent execution/recovery proof. The live in-memory branch may differ. No linked paths or sessions are followed.',
  };
}
