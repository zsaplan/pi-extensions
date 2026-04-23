import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  ExtensionCommandContext,
  SessionEntry,
} from '@mariozechner/pi-coding-agent';
import {
  collectAssistantResponses,
  loadResponseReviewSession,
  resolveSessionPath,
} from '../src/session.ts';

function messageEntry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  content: unknown,
  timestamp: number,
  provider?: string,
  model?: string,
) {
  return {
    type: 'message' as const,
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role,
      content,
      timestamp,
      provider,
      model,
    },
  };
}

test('collectAssistantResponses extracts visible assistant text and preceding user context', () => {
  const timestamp = Date.UTC(2026, 3, 23, 12, 0, 0);
  const manager = {
    getCwd: () => '/repo',
    getSessionFile: () => undefined,
    getSessionId: () => 'session-current',
    getSessionName: () => 'Current Session',
    getBranch: () =>
      [
        messageEntry(
          'user-1',
          null,
          'user',
          [{type: 'text', text: 'Can you review this?'}, {type: 'image'}],
          timestamp,
        ),
        messageEntry(
          'assistant-1',
          'user-1',
          'assistant',
          [
            {type: 'text', text: 'Here’s line one.'},
            {type: 'text', text: 'Here’s line two.'},
          ],
          timestamp + 1000,
          'provider-a',
          'model-a',
        ),
        messageEntry(
          'assistant-empty',
          'assistant-1',
          'assistant',
          [{type: 'image'}],
          timestamp + 2000,
        ),
      ] as unknown as SessionEntry[],
  };

  const responses = collectAssistantResponses(manager);

  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], {
    id: 'assistant-1',
    index: 1,
    timestamp: timestamp + 1000,
    provider: 'provider-a',
    model: 'model-a',
    preview: "Here's line one. Here's line two.",
    precedingUserPreview: 'Can you review this? [image]',
    lineCount: 3,
    charCount: 34,
    text: "Here's line one.\n\nHere's line two.",
    precedingUserText: 'Can you review this?\n\n[image]',
  });
});

test('loadResponseReviewSession parses a retroactive session JSONL file', async t => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'response-review-'));
  t.after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));

  const sessionPath = path.join(tmpRoot, 'session.jsonl');
  const timestamp = Date.UTC(2026, 3, 23, 13, 0, 0);
  const entries = [
    {
      type: 'session',
      version: 3,
      id: 'retro-session',
      timestamp: new Date(timestamp).toISOString(),
      cwd: tmpRoot,
    },
    {
      type: 'session_info',
      id: 'info-1',
      parentId: null,
      timestamp: new Date(timestamp + 1).toISOString(),
      name: 'Retro Review',
    },
    messageEntry(
      'user-1',
      'info-1',
      'user',
      'Please summarize.',
      timestamp + 2,
    ),
    messageEntry(
      'assistant-1',
      'user-1',
      'assistant',
      'Summary\r\nsecond line',
      timestamp + 3,
      'provider-b',
      'model-b',
    ),
  ];
  fs.writeFileSync(
    sessionPath,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );

  const ctx = {
    cwd: tmpRoot,
    sessionManager: {
      getCwd: () => tmpRoot,
      getSessionFile: () => undefined,
      getSessionId: () => 'current-session',
      getSessionName: () => null,
      getBranch: () => [],
    },
  } as unknown as ExtensionCommandContext;

  const loaded = await loadResponseReviewSession(sessionPath, ctx);

  assert.equal(loaded.session.kind, 'session-file');
  assert.equal(loaded.session.sessionId, 'retro-session');
  assert.equal(loaded.session.sessionPath, sessionPath);
  assert.equal(loaded.session.cwd, tmpRoot);
  assert.equal(loaded.session.name, 'Retro Review');
  assert.equal(loaded.responses.length, 1);
  assert.equal(loaded.responses[0]?.text, 'Summary\nsecond line');
  assert.equal(loaded.responses[0]?.precedingUserText, 'Please summarize.');
});

test('resolveSessionPath supports current, direct path, and session lookup matches', async () => {
  const cwd = '/workspace';
  const directPath = path.join(cwd, 'session.jsonl');

  assert.equal(await resolveSessionPath('current', {cwd}), null);
  assert.equal(
    await resolveSessionPath(
      "'session.jsonl'",
      {cwd},
      {pathExists: async () => true},
    ),
    directPath,
  );
  assert.equal(
    await resolveSessionPath(
      'retro',
      {cwd},
      {
        pathExists: async () => false,
        listSessions: async () => [
          {
            id: 'newer-session',
            path: '/sessions/newer.jsonl',
            name: 'Retro flow',
            firstMessage: 'latest',
            modified: new Date('2026-04-23T13:00:00Z'),
          },
        ],
      },
    ),
    '/sessions/newer.jsonl',
  );

  await assert.rejects(
    () =>
      resolveSessionPath(
        'missing',
        {cwd},
        {
          pathExists: async () => false,
          listSessions: async () => [],
        },
      ),
    /No session matched: missing/,
  );
});
