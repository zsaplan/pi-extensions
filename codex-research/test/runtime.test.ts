import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import codexResearchExtension, {parseCodexVersion} from '../src/index.ts';

const THREAD_ID = '01a0e98f-bdc9-7179-bb41-2934efef6558';
const SECOND_THREAD_ID = '01a0e9a1-d7d6-7232-941d-1bd8e5885f1f';
const DEFAULT_REPORT = 'A cited result from [OpenAI](https://openai.com).';

type RegisteredTool = {
  execute: (
    id: string,
    params: {
      question: string;
      depth?: string;
      reasoningEffort?: string;
      threadId?: string;
    },
    signal: AbortSignal,
  ) => Promise<{
    content: Array<{type: string; text: string}>;
    details: {
      threadId: string;
      artifactPath: string;
      codexVersion: string;
      depth: string;
      reasoningEffort: string;
      continued: boolean;
      report: string;
    };
  }>;
};

interface ExecCall {
  command: string;
  args: string[];
  options: {signal?: AbortSignal; timeout?: number; cwd?: string};
}

interface RuntimeOptions {
  version?: string;
  failResearch?: boolean;
  killedResearch?: boolean;
  waitForAbort?: boolean;
  reports?: string[];
  threadIds?: string[];
  researchDelayMs?: number;
}

function createRuntime(options: RuntimeOptions = {}) {
  let tool: RegisteredTool | undefined;
  let researchIndex = 0;
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
      if (args.length === 1 && args[0] === '--version') {
        return {
          code: 0,
          killed: false,
          stdout: `${options.version ?? 'codex-cli 0.158.0'}\n`,
          stderr: '',
        };
      }

      const currentResearchIndex = researchIndex++;
      if (options.waitForAbort) {
        await new Promise<void>(resolve => {
          if (execOptions.signal?.aborted) resolve();
          else
            execOptions.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
        return {code: 0, killed: true, stdout: '', stderr: ''};
      }
      if (options.researchDelayMs) {
        await new Promise(resolve =>
          setTimeout(resolve, options.researchDelayMs),
        );
      }
      if (options.failResearch || options.killedResearch) {
        return {
          code: options.killedResearch ? 0 : 1,
          killed: Boolean(options.killedResearch),
          stdout: options.killedResearch
            ? ''
            : '{"type":"error","message":"access_token=secret-value"}\n',
          stderr: options.killedResearch ? '' : 'simulated codex failure',
        };
      }

      const outputIndex = args.indexOf('-o');
      assert.notEqual(outputIndex, -1);
      await fs.writeFile(
        args[outputIndex + 1],
        JSON.stringify({
          report: options.reports?.[currentResearchIndex] ?? DEFAULT_REPORT,
          sources: [{title: 'OpenAI', url: 'https://openai.com'}],
          uncertainties: ['Release timing may change.'],
        }),
      );
      return {
        code: 0,
        killed: false,
        stdout: `${JSON.stringify({
          type: 'thread.started',
          thread_id: options.threadIds?.[currentResearchIndex] ?? THREAD_ID,
        })}\n`,
        stderr: '',
      };
    },
  } as unknown as ExtensionAPI;
  codexResearchExtension(pi);
  assert.ok(tool);
  return {tool, calls};
}

function researchCalls(calls: ExecCall[]): ExecCall[] {
  return calls.filter(call => call.args[0] !== '--version');
}

async function withArtifactRoot(
  run: (artifactRoot: string) => Promise<void>,
): Promise<void> {
  const artifactRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'codex-research-test-'),
  );
  const previousArtifactRoot = process.env.PI_CODEX_RESEARCH_DIR;
  try {
    process.env.PI_CODEX_RESEARCH_DIR = artifactRoot;
    await run(artifactRoot);
  } finally {
    if (previousArtifactRoot === undefined)
      delete process.env.PI_CODEX_RESEARCH_DIR;
    else process.env.PI_CODEX_RESEARCH_DIR = previousArtifactRoot;
    await fs.rm(artifactRoot, {recursive: true, force: true});
  }
}

async function waitFor(
  predicate: () => boolean,
  failureMessage: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(failureMessage);
}

test('registered tool checks compatibility, runs isolated search, and persists its result', async () => {
  await withArtifactRoot(async () => {
    const previousBin = process.env.PI_CODEX_RESEARCH_BIN;
    process.env.PI_CODEX_RESEARCH_BIN = '/test/bin/codex';
    try {
      const {tool, calls} = createRuntime();
      const result = await tool.execute(
        'call-1',
        {question: 'What changed?', depth: 'quick'},
        new AbortController().signal,
      );

      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].args, ['--version']);
      const researchCall = researchCalls(calls)[0];
      assert.equal(researchCall.command, '/test/bin/codex');
      assert.deepEqual(researchCall.args.slice(0, 10), [
        '--search',
        '-s',
        'read-only',
        '-a',
        'never',
        '-c',
        'model_reasoning_effort="medium"',
        '-C',
        researchCall.options.cwd,
        'exec',
      ]);
      assert.ok(researchCall.args.includes('--ignore-user-config'));
      assert.ok(researchCall.args.includes('--ignore-rules'));
      assert.match(researchCall.args.at(-1) ?? '', /native live web_search/);
      assert.equal(result.details.threadId, THREAD_ID);
      assert.equal(result.details.codexVersion, 'codex-cli 0.158.0');
      assert.equal(result.details.depth, 'quick');
      assert.equal(result.details.reasoningEffort, 'medium');
      assert.equal(result.details.continued, false);
      assert.match(result.content[0].text, /A cited result/);
      assert.match(result.content[0].text, new RegExp(THREAD_ID));

      const artifact = JSON.parse(
        await fs.readFile(result.details.artifactPath, 'utf8'),
      ) as {question: string; threadId: string; codexVersion: string};
      assert.equal(artifact.question, 'What changed?');
      assert.equal(artifact.threadId, THREAD_ID);
      assert.equal(artifact.codexVersion, 'codex-cli 0.158.0');
      await assert.rejects(fs.access(researchCall.options.cwd ?? ''));
    } finally {
      if (previousBin === undefined) delete process.env.PI_CODEX_RESEARCH_BIN;
      else process.env.PI_CODEX_RESEARCH_BIN = previousBin;
    }
  });
});

test('thread ID resumes the exact Codex research conversation', async () => {
  await withArtifactRoot(async () => {
    const {tool, calls} = createRuntime();
    const result = await tool.execute(
      'call-2',
      {
        question: 'Compare the alternatives.',
        reasoningEffort: 'high',
        threadId: THREAD_ID,
      },
      new AbortController().signal,
    );

    const researchCall = researchCalls(calls)[0];
    assert.equal(researchCall.args[6], 'model_reasoning_effort="high"');
    assert.equal(researchCall.args[10], 'resume');
    assert.equal(researchCall.args.at(-2), THREAD_ID);
    assert.equal(result.details.depth, 'thorough');
    assert.equal(result.details.reasoningEffort, 'high');
    assert.equal(result.details.continued, true);
  });
});

test('a canceled research call forwards the signal and removes its workspace', async () => {
  await withArtifactRoot(async () => {
    const {tool, calls} = createRuntime({waitForAbort: true});
    const controller = new AbortController();
    const pending = tool.execute(
      'call-cancel',
      {question: 'Research until canceled.'},
      controller.signal,
    );
    await waitFor(
      () => researchCalls(calls).length === 1,
      'research subprocess did not start',
    );
    const researchCall = researchCalls(calls)[0];
    assert.equal(researchCall.options.signal, controller.signal);

    controller.abort();
    await assert.rejects(pending, /canceled or timed out/);
    await assert.rejects(fs.access(researchCall.options.cwd ?? ''));
  });
});

test('concurrent research calls use distinct workspaces, threads, and artifacts', async () => {
  await withArtifactRoot(async () => {
    const {tool, calls} = createRuntime({
      researchDelayMs: 10,
      threadIds: [THREAD_ID, SECOND_THREAD_ID],
      reports: ['First concurrent report.', 'Second concurrent report.'],
    });
    const [first, second] = await Promise.all([
      tool.execute(
        'call-concurrent-1',
        {question: 'First question.'},
        new AbortController().signal,
      ),
      tool.execute(
        'call-concurrent-2',
        {question: 'Second question.'},
        new AbortController().signal,
      ),
    ]);

    const invocations = researchCalls(calls);
    assert.equal(invocations.length, 2);
    assert.notEqual(invocations[0].options.cwd, invocations[1].options.cwd);
    assert.notEqual(first.details.threadId, second.details.threadId);
    assert.notEqual(first.details.artifactPath, second.details.artifactPath);
    await Promise.all(
      invocations.map(call =>
        assert.rejects(fs.access(call.options.cwd ?? '')),
      ),
    );
  });
});

test('large reports are truncated only in model-facing output', async () => {
  await withArtifactRoot(async () => {
    const fullReport = `${'"'.repeat(31_000)}FULL_REPORT_END`;
    const {tool} = createRuntime({reports: [fullReport]});
    const result = await tool.execute(
      'call-large',
      {question: 'Produce a large report.'},
      new AbortController().signal,
    );

    assert.equal(result.details.report, fullReport);
    assert.doesNotMatch(result.content[0].text, /FULL_REPORT_END/);
    assert.match(result.content[0].text, /(?:truncated|content omitted)/);
    assert.ok(result.content[0].text.length <= 50_000);
    const artifact = await fs.readFile(result.details.artifactPath, 'utf8');
    assert.match(artifact, /FULL_REPORT_END/);
  });
});

test('Codex failures are surfaced with sensitive diagnostics redacted', async () => {
  const {tool} = createRuntime({failResearch: true});
  await assert.rejects(
    tool.execute(
      'call-failure',
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
  const {tool} = createRuntime({killedResearch: true});
  await assert.rejects(
    tool.execute(
      'call-killed',
      {question: 'Research until killed.'},
      new AbortController().signal,
    ),
    /canceled or timed out/,
  );
});

test('unsupported Codex versions fail before research starts', async () => {
  const {tool, calls} = createRuntime({version: 'codex-cli 0.157.0'});
  await assert.rejects(
    tool.execute(
      'call-old-version',
      {question: 'Do not start this research.'},
      new AbortController().signal,
    ),
    /requires 0\.158\.0 or newer/,
  );
  assert.equal(researchCalls(calls).length, 0);
});

test('Codex version parsing accepts release suffixes and rejects unknown output', () => {
  assert.deepEqual(parseCodexVersion('codex-cli 0.158.0-beta.1'), [0, 158, 0]);
  assert.throws(() => parseCodexVersion('unknown build'), /Could not parse/);
});
