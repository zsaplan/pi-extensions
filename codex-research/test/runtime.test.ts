import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import codexResearchExtension from '../src/index.ts';

const THREAD_ID = '01a0e98f-bdc9-7179-bb41-2934efef6558';

type RegisteredTool = {
  execute: (
    id: string,
    params: {question: string; depth?: string; threadId?: string},
    signal: AbortSignal,
  ) => Promise<{
    content: Array<{type: string; text: string}>;
    details: {threadId: string; artifactPath: string; continued: boolean};
  }>;
};

interface ExecCall {
  command: string;
  args: string[];
  options: {signal?: AbortSignal; timeout?: number; cwd?: string};
}

function createRuntime(options?: {fail?: boolean; killed?: boolean}) {
  let tool: RegisteredTool | undefined;
  const calls: ExecCall[] = [];
  const pi = {
    registerTool(value: RegisteredTool) {
      tool = value;
    },
    async exec(
      command: string,
      args: string[],
      execOptions: ExecCall['options'],
    ) {
      calls.push({command, args, options: execOptions});
      if (options?.fail || options?.killed) {
        return {
          code: options.killed ? 0 : 1,
          killed: Boolean(options.killed),
          stdout: options.killed
            ? ''
            : '{"type":"error","message":"access_token=secret-value"}\n',
          stderr: options.killed ? '' : 'simulated codex failure',
        };
      }

      const outputIndex = args.indexOf('-o');
      assert.notEqual(outputIndex, -1);
      await fs.writeFile(
        args[outputIndex + 1],
        JSON.stringify({
          report: 'A cited result from [OpenAI](https://openai.com).',
          sources: [{title: 'OpenAI', url: 'https://openai.com'}],
          uncertainties: ['Release timing may change.'],
        }),
      );
      return {
        code: 0,
        killed: false,
        stdout: `${JSON.stringify({
          type: 'thread.started',
          thread_id: THREAD_ID,
        })}\n`,
        stderr: '',
      };
    },
  } as unknown as ExtensionAPI;
  codexResearchExtension(pi);
  assert.ok(tool);
  return {tool, calls};
}

test('registered tool runs isolated Codex search and persists its result', async () => {
  const artifactRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'codex-research-test-'),
  );
  const previousArtifactRoot = process.env.PI_CODEX_RESEARCH_DIR;
  const previousBin = process.env.PI_CODEX_RESEARCH_BIN;
  process.env.PI_CODEX_RESEARCH_DIR = artifactRoot;
  process.env.PI_CODEX_RESEARCH_BIN = '/test/bin/codex';

  try {
    const {tool, calls} = createRuntime();
    const result = await tool.execute(
      'call-1',
      {question: 'What changed?', depth: 'quick'},
      new AbortController().signal,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/test/bin/codex');
    assert.deepEqual(calls[0].args.slice(0, 8), [
      '--search',
      '-s',
      'read-only',
      '-a',
      'never',
      '-C',
      calls[0].options.cwd,
      'exec',
    ]);
    assert.ok(calls[0].args.includes('--ignore-user-config'));
    assert.ok(calls[0].args.includes('--ignore-rules'));
    assert.match(calls[0].args.at(-1) ?? '', /native live web_search/);
    assert.equal(result.details.threadId, THREAD_ID);
    assert.equal(result.details.continued, false);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /A cited result/);
    assert.match(result.content[0].text, new RegExp(THREAD_ID));

    const artifact = JSON.parse(
      await fs.readFile(result.details.artifactPath, 'utf8'),
    ) as {question: string; threadId: string};
    assert.equal(artifact.question, 'What changed?');
    assert.equal(artifact.threadId, THREAD_ID);
    await assert.rejects(fs.access(calls[0].options.cwd ?? ''));
  } finally {
    if (previousArtifactRoot === undefined)
      delete process.env.PI_CODEX_RESEARCH_DIR;
    else process.env.PI_CODEX_RESEARCH_DIR = previousArtifactRoot;
    if (previousBin === undefined) delete process.env.PI_CODEX_RESEARCH_BIN;
    else process.env.PI_CODEX_RESEARCH_BIN = previousBin;
    await fs.rm(artifactRoot, {recursive: true, force: true});
  }
});

test('thread ID resumes the exact Codex research conversation', async () => {
  const artifactRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'codex-research-test-'),
  );
  const previousArtifactRoot = process.env.PI_CODEX_RESEARCH_DIR;
  process.env.PI_CODEX_RESEARCH_DIR = artifactRoot;

  try {
    const {tool, calls} = createRuntime();
    const result = await tool.execute(
      'call-2',
      {question: 'Compare the alternatives.', threadId: THREAD_ID},
      new AbortController().signal,
    );

    assert.equal(calls[0].args[8], 'resume');
    assert.equal(calls[0].args.at(-2), THREAD_ID);
    assert.equal(result.details.continued, true);
  } finally {
    if (previousArtifactRoot === undefined)
      delete process.env.PI_CODEX_RESEARCH_DIR;
    else process.env.PI_CODEX_RESEARCH_DIR = previousArtifactRoot;
    await fs.rm(artifactRoot, {recursive: true, force: true});
  }
});

test('Codex failures are surfaced with sensitive diagnostics redacted', async () => {
  const {tool} = createRuntime({fail: true});
  await assert.rejects(
    tool.execute(
      'call-3',
      {question: 'Research this failure.'},
      new AbortController().signal,
    ),
    error => {
      assert.match(String(error), /simulated codex failure/);
      assert.doesNotMatch(String(error), /secret-value/);
      assert.match(String(error), /\[REDACTED\]/);
      return true;
    },
  );
});

test('a killed Codex process fails even when its exit code is zero', async () => {
  const {tool} = createRuntime({killed: true});
  await assert.rejects(
    tool.execute(
      'call-4',
      {question: 'Research until canceled.'},
      new AbortController().signal,
    ),
    /canceled or timed out/,
  );
});
