import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

// Requires the separately installed, reviewed researcher. Never downloads it or
// invokes a paid provider. All HTTP/WebSocket destinations are local fixtures.
test(
  'worker SDK + existing native researcher integration',
  {
    skip: !process.env.TASK_RESEARCH_PACKAGE,
    timeout: 90000,
  },
  async () => {
    const pkg = fileURLToPath(new URL('..', import.meta.url));
    await mkdir(path.join(pkg, 'tmp'), {recursive: true});
    const artifact = await mkdtemp(path.join(pkg, 'tmp/github-worker-e2e-'));
    const result = await new Promise<{code: number | null; output: string}>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.join(pkg, 'test/github-research-fixture.mjs'), artifact],
          {
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TASK_RESEARCH_PACKAGE: process.env.TASK_RESEARCH_PACKAGE,
              GH_TOKEN: 'fixture-token',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', data => {
          output += String(data);
        });
        child.stderr.on('data', data => {
          output += String(data);
        });
        child.once('error', reject);
        child.once('close', code => resolve({code, output}));
      },
    );
    assert.equal(result.code, 0, result.output + '\nArtifacts: ' + artifact);
    const report = JSON.parse(
      await readFile(path.join(artifact, 'report.json'), 'utf8'),
    );
    assert.equal(report.passed, true);
    console.log('Research integration artifact: ' + artifact);
  },
);
