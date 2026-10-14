import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(packageRoot, 'dist/cli.js');
const sample = {
  request: 'fixture-secret-request',
  outcome: 'A local investigation note.',
  sources: [
    {
      workspace_id: 'TONE',
      channel_id: 'CSOURCE',
      message_ts: '1700000000.000001',
    },
  ],
  inbox: {
    workspace_id: 'TONE',
    channel_id: 'DASSIST',
    owner_user_id: 'UOWNER',
    bot_user_id: 'UBOT',
  },
};
function run(
  args: string[],
  input?: unknown,
  preload?: string,
): Promise<{
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(preload ? ['--import', preload] : []), cli, ...args],
      {
        env: {PATH: process.env.PATH, HOME: process.env.HOME},
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({code, signal, stdout, stderr}),
    );
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

test('durable queue through the compiled CLI', async t => {
  await mkdir(path.join(packageRoot, 'tmp'), {recursive: true});
  const artifact = await mkdtemp(path.join(packageRoot, 'tmp/queue-e2e-'));
  const root = path.join(artifact, 'state');
  const outcomes: string[] = [];
  let id = '';
  let directory = '';
  t.after(async () => {
    await writeFile(
      path.join(artifact, 'report.json'),
      JSON.stringify(
        {
          schema_version: 1,
          invocation: 'npm run test --workspace task-assistant',
          suite: 'queue-cli-e2e',
          node: process.version,
          base_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: packageRoot,
            encoding: 'utf8',
          }).trim(),
          task_id: id,
          outcomes,
          live_slack: false,
          model_invoked: false,
          unverified: [
            'Live task execution',
            'Slack writes',
            'Pi-session recovery',
          ],
        },
        null,
        2,
      ) + '\n',
    );
    t.diagnostic(`Evidence: ${path.join(artifact, 'report.json')}`);
  });
  await t.test(
    'publishes a complete record and emits only routing metadata',
    async () => {
      const result = await run(['enqueue', '--root', root], sample);
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.ok(!result.stdout.includes(sample.request));
      const data = JSON.parse(result.stdout);
      id = data.task_id;
      directory = data.task_path;
      assert.equal(data.result, 'created');
      assert.equal(data.status, 'queued');
      assert.deepEqual((await readdir(directory)).sort(), [
        'artifacts',
        'evidence.md',
        'handoffs.md',
        'plan.md',
        'task.json',
      ]);
      const record = JSON.parse(
        await readFile(path.join(directory, 'task.json'), 'utf8'),
      );
      assert.equal(record.id, id);
      assert.equal(record.request, sample.request);
      assert.equal('status' in record, false);
      assert.equal(record.session.id, null);
      assert.deepEqual(await readdir(path.join(root, 'staging')), []);
      outcomes.push('complete-publication');
    },
  );
  await t.test(
    'deduplicates across every status and preserves external session storage',
    async () => {
      await mkdir(path.join(root, 'sessions', id));
      await writeFile(
        path.join(root, 'sessions', id, 'session.jsonl'),
        'fixture-session',
      );
      for (const status of ['active', 'waiting', 'review', 'done', 'queued']) {
        assert.equal(
          (
            await run([
              'move',
              '--root',
              root,
              '--task-id',
              id,
              '--status',
              status,
            ])
          ).code,
          0,
        );
        const result = await run(['enqueue', '--root', root], sample);
        assert.equal(result.code, 0);
        const data = JSON.parse(result.stdout);
        assert.equal(data.task_id, id);
        assert.equal(data.status, status);
        assert.equal(data.result, 'existing');
      }
      assert.equal(
        await readFile(
          path.join(root, 'sessions', id, 'session.jsonl'),
          'utf8',
        ),
        'fixture-session',
      );
      outcomes.push('cross-status-dedup-and-session-paths');
    },
  );
  await t.test(
    'serializes concurrent requests and rejects cross-task or inbox conflicts',
    async () => {
      const second = {
        ...sample,
        sources: [{...sample.sources[0], message_ts: '1700000001.000001'}],
      };
      const results = await Promise.all([
        run(['enqueue', '--root', root], second),
        run(['enqueue', '--root', root], second),
      ]);
      assert.ok(results.every(result => result.code === 0));
      assert.deepEqual(
        results.map(result => JSON.parse(result.stdout).result).sort(),
        ['created', 'existing'],
      );
      const conflict = await run(['enqueue', '--root', root], {
        ...sample,
        sources: [...sample.sources, ...second.sources],
      });
      assert.equal(JSON.parse(conflict.stdout).error, 'source_conflict');
      const wrongInbox = await run(['enqueue', '--root', root], {
        ...sample,
        inbox: {...sample.inbox, channel_id: 'DOTHER'},
      });
      assert.equal(JSON.parse(wrongInbox.stdout).error, 'inbox_conflict');
      outcomes.push('concurrency-and-conflicts');
    },
  );
  await t.test(
    'rejects invalid and oversized inputs without echoing content',
    async () => {
      for (const input of [
        null,
        {...sample, status: 'done'},
        {...sample, request: 'x'.repeat(70000)},
        {...sample, sources: [{...sample.sources[0], channel_id: '../escape'}]},
        {...sample, sources: [sample.sources[0], sample.sources[0]]},
      ]) {
        const result = await run(['enqueue', '--root', root], input);
        assert.equal(result.code, 1);
        assert.equal(JSON.parse(result.stdout).status, 'blocked');
        assert.ok(!result.stdout.includes(sample.request));
        assert.ok(!result.stderr.includes(sample.request));
      }
      assert.equal(
        JSON.parse((await run(['list', '--root', root])).stdout).tasks.length,
        2,
      );
      outcomes.push('invalid-inputs');
    },
  );
  await t.test(
    'adds source aliases so either source deduplicates on restart',
    async () => {
      const alias = {...sample.sources[0], message_ts: '1700000002.000001'};
      const result = await run(['enqueue', '--root', root], {
        ...sample,
        sources: [...sample.sources, alias],
      });
      assert.equal(JSON.parse(result.stdout).result, 'existing');
      const replay = await run(['enqueue', '--root', root], {
        ...sample,
        sources: [alias],
      });
      assert.equal(JSON.parse(replay.stdout).task_id, id);
      outcomes.push('source-alias-replay');
    },
  );
  await t.test(
    'recovers a killed coordinator without exposing staged records',
    async () => {
      const isolatedRoot = path.join(artifact, 'interrupted');
      const preload = path.join(artifact, 'crash.mjs');
      await writeFile(
        preload,
        "import fs from 'node:fs/promises';\nimport {syncBuiltinESMExports} from 'node:module';\nconst rename=fs.rename;\nfs.rename=async(a,b)=>{if(String(a).includes('/staging/')&&String(b).includes('/queued/')) process.kill(process.pid,'SIGKILL');return rename(a,b);};\nsyncBuiltinESMExports();\n",
      );
      const killed = await run(
        ['enqueue', '--root', isolatedRoot],
        sample,
        preload,
      );
      assert.equal(killed.signal, 'SIGKILL');
      assert.deepEqual(await readdir(path.join(isolatedRoot, 'queued')), []);
      const recovered = await run(['enqueue', '--root', isolatedRoot], sample);
      assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).result, 'created');
      assert.equal(JSON.parse(recovered.stdout).task_id, id);
      assert.deepEqual(await readdir(path.join(isolatedRoot, 'staging')), []);
      outcomes.push('crash-before-publication-and-stale-lock-recovery');
    },
  );
});
