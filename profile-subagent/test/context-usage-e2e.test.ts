import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('parent context extractor CLI E2E', async t => {
  const root = join(pkg, 'tmp/e2e');
  await mkdir(root, {recursive: true});
  const dir = await mkdtemp(join(root, 'context-'));
  const evidence: Array<Record<string, unknown>> = [];
  const header = {
    type: 'session',
    id: 'fixture-fork',
    version: 3,
    timestamp: '2026-10-08T10:00:00Z',
  };
  const entry = (
    id: string,
    parentId: string | null,
    role: string,
    input: number,
  ): Record<string, unknown> => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-10-08T10:01:00Z',
    message: {
      role,
      content: [],
      stopReason: 'stop',
      usage: {
        input,
        cacheRead: 80,
        cacheWrite: 10,
        cacheWrite1h: 10,
        output: 500,
        reasoning: 499,
        totalTokens: input + 590,
      },
    },
  });
  const base: Array<Record<string, unknown>> = [
    {
      ...entry('old', null, 'assistant', 9000000),
      timestamp: '2026-10-07T10:00:00Z',
    },
    entry('user', 'old', 'user', 0),
    entry('first', 'user', 'assistant', 10),
    entry('abandoned', 'user', 'assistant', 8000000),
    entry('nested', 'first', 'toolResult', 7000000),
    {
      type: 'compaction',
      id: 'compact',
      parentId: 'nested',
      timestamp: '2026-10-08T10:02:00Z',
      usage: {input: 6000000},
    },
    {
      type: 'usage',
      id: 'helper',
      parentId: 'compact',
      timestamp: '2026-10-08T10:02:01Z',
      usage: {input: 5000000},
    },
    {
      ...entry('last', 'helper', 'assistant', 20),
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
        usage: {
          input: 20,
          cacheRead: 10,
          cacheWrite: 10,
          output: 7,
          totalTokens: 47,
        },
      },
    },
  ];
  for (const name of [
    'accounting',
    'missing-usage',
    'zero-usage',
    'broken-chain',
    'cycle',
    'duplicate-id',
    'invalid-json',
    'duplicate-input',
    'overwrite',
  ]) {
    await t.test(name, async () => {
      const rows = structuredClone(base);
      const last = rows.at(-1)!;
      if (name === 'missing-usage' || name === 'zero-usage')
        last.message = {
          role: 'assistant',
          content: [],
          stopReason: name === 'missing-usage' ? 'error' : 'stop',
          usage:
            name === 'missing-usage'
              ? undefined
              : {input: 0, cacheRead: 0, cacheWrite: 0},
        };
      if (name === 'broken-chain') last.parentId = 'absent';
      if (name === 'cycle') last.parentId = 'last';
      if (name === 'duplicate-id') last.id = 'first';
      const input = join(dir, `${name}.jsonl`);
      const output = join(dir, `${name}.json`);
      const content =
        [header, ...rows].map(r => JSON.stringify(r)).join('\n') +
        (name === 'invalid-json' ? '\n{"partial":' : '\n');
      await writeFile(input, content);
      if (name === 'overwrite') await writeFile(output, 'PRESERVE');
      const result = spawnSync(
        'python3',
        [
          join(pkg, 'benchmark/context_usage.py'),
          '--output',
          output,
          input,
          ...(name === 'duplicate-input' ? [input] : []),
        ],
        {encoding: 'utf8', timeout: 10000},
      );
      assert.equal(result.error, undefined);
      const valid = ['accounting', 'missing-usage', 'zero-usage'].includes(
        name,
      );
      assert.equal(result.status === 0, valid, result.stderr);
      assert.equal(await readFile(input, 'utf8'), content);
      if (valid) {
        const report = JSON.parse(await readFile(output, 'utf8'));
        const run = report.sessions[0];
        assert.equal(
          run.sha256,
          createHash('sha256').update(content).digest('hex'),
        );
        assert.equal(run.freshParentRequests, 2);
        assert.equal(run.firstInputTokens, 100);
        assert.equal(run.peakInputTokens, 100);
        assert.equal(run.newUserMessageCount, 1);
        assert.deepEqual(run.abandonedFreshEntryIds, ['abandoned']);
        assert.equal(run.contextChanges[0].type, 'compaction');
        assert.equal(run.lastInputTokens, name === 'accounting' ? 40 : null);
        assert.equal(run.growthInputTokens, name === 'accounting' ? -60 : null);
        assert.equal(
          run.cumulativeReportedInputTokens,
          name === 'accounting' ? 140 : 100,
        );
        assert.equal(run.coverageComplete, name === 'accounting');
        assert.equal(run.completed, name !== 'missing-usage');
        assert.equal((await stat(output)).mode & 0o777, 0o600);
      } else if (name === 'overwrite') {
        assert.equal(await readFile(output, 'utf8'), 'PRESERVE');
      } else {
        await assert.rejects(stat(output));
      }
      evidence.push({
        name,
        input,
        output,
        passed: true,
        exitCode: result.status,
      });
    });
  }
  await writeFile(
    join(root, 'context-evidence.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        dir,
        evidence,
        scope:
          'Actual extractor CLI; saved fixture sessions, no models or DB calls',
      },
      null,
      2,
    ),
  );
});
