import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, symlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {loadCatalog} from '../src/profiles.ts';

process.umask(0o077);
const pkg = resolve(fileURLToPath(new URL('..', import.meta.url)));
test(
  'packed researcher: compiled exports, default-off discovery and native transport boundaries',
  {timeout: 120000},
  async t => {
    await mkdir(join(pkg, 'tmp/github-package'), {recursive: true});
    const root = await mkdtemp(join(pkg, 'tmp/github-package/e2e-'));
    const run = (bin: string, args: string[], timeout = 30000) => {
      const p = spawnSync(bin, args, {
        cwd: pkg,
        timeout,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      assert.equal(p.error, undefined, String(p.error));
      assert.equal(p.status, 0, p.stderr + p.stdout);
      return p.stdout;
    };
    const pack = JSON.parse(
      run('npm', ['pack', '--json', '--pack-destination', root], 60000),
    )[0];
    const paths = pack.files.map((f: {path: string}) => f.path);
    assert.ok(paths.includes('dist/github-research.js'));
    assert.ok(paths.includes('dist/github-read.js'));
    assert.ok(paths.includes('profiles/github-researcher/AGENTS.md'));
    assert.ok(!paths.some((p: string) => /(^|\/)(tmp|test)\//.test(p)));
    run('tar', ['-xzf', join(root, pack.filename), '-C', root]);
    await symlink(
      resolve(pkg, '../node_modules'),
      join(root, 'package/node_modules'),
      'dir',
    );
    await mkdir(join(root, 'node_modules/@zsaplan'), {recursive: true});
    await symlink(
      join(root, 'package'),
      join(root, 'node_modules/@zsaplan/pi-profile-subagent'),
      'dir',
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({name: 'packed-research-host', type: 'module'}),
    );
    const require = createRequire(join(root, 'host.cjs'));
    const module =
      require.resolve('@zsaplan/pi-profile-subagent/github-research');
    assert.ok(module.startsWith(join(root, 'package/dist/')));
    const catalog = await loadCatalog();
    assert.ok(
      !catalog.profiles.some(p => p.manifest.id === 'github-researcher'),
    );
    const results: {scenario: string; passed: boolean}[] = [];
    for (const scenario of [
      'success',
      'blocked',
      'redacted',
      'provider-error',
      'missing-usage',
      'cancel',
      'delayed-close',
    ]) {
      await t.test(scenario, async () => {
        const output = join(root, scenario),
          config = join(root, scenario + '.json');
        await writeFile(
          config,
          JSON.stringify({
            mode: 'fixture',
            scenario,
            module,
            output,
            task: 'Read the approved README and report the setting without claiming runtime execution.',
            grants: [
              {
                repository: 'fixture/research',
                head: 'a'.repeat(40),
                paths: ['README.md'],
                history: false,
                discussions: [],
              },
            ],
          }),
        );
        const stdout = run(process.execPath, [
          join(pkg, 'test/github-package-host.mjs'),
          config,
        ]);
        await writeFile(join(output, 'host.stdout'), stdout);
        const value = JSON.parse(
          await readFile(join(output, 'result.json'), 'utf8'),
        );
        assert.equal(value.activeHttp, 0);
        if (['provider-error', 'missing-usage', 'cancel'].includes(scenario)) {
          assert.notEqual(value.report?.status, 'completed');
          if (value.report)
            assert.equal(value.report.research.accountingComplete, false);
          assert.equal(value.frames, 1);
        } else {
          assert.equal(value.report.status, 'completed', stdout);
          assert.equal(value.report.research.cleanupComplete, true);
          assert.equal(value.report.research.accountingComplete, true);
          assert.deepEqual(value.enclosingUsage, value.report.usage);
          assert.equal(value.frames, 2);
          assert.equal(value.connections, 1);
          if (scenario === 'blocked') {
            assert.equal(value.wireGithub, 0);
            assert.ok(
              value.report.sourceEvidence.records.some(
                (r: {isError: boolean}) => r.isError,
              ),
            );
          } else assert.equal(value.wireGithub, 3);
          if (scenario === 'redacted') {
            assert.ok(
              JSON.stringify(value.report.sourceEvidence).includes(
                '[REDACTED]',
              ),
            );
            assert.ok(
              !JSON.stringify(value.report.sourceEvidence).includes(
                'fake-sensitive',
              ),
            );
            assert.equal(
              value.report.sourceEvidence.records[0].integrity,
              'modified-or-unavailable',
            );
          }
        }
        results.push({scenario, passed: true});
      });
    }
    await writeFile(
      join(root, 'evidence.json'),
      JSON.stringify(
        {
          root,
          module,
          tarball: join(root, pack.filename),
          integrity: pack.integrity,
          results,
          liveRequests: 0,
        },
        null,
        2,
      ),
    );
    console.log('Packed researcher evidence: ' + root);
  },
);
