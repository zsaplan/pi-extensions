import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, symlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
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
    const readerApi = await import(
      pathToFileURL(require.resolve('@zsaplan/pi-profile-subagent/github-read'))
        .href
    );
    assert.throws(
      () =>
        readerApi.createGithubReader([], {
          token: async () => {
            throw new Error('Must not reach credentials');
          },
        }),
      /token supplier is required/,
    );
    const catalog = await loadCatalog();
    assert.ok(
      !catalog.profiles.some(p => p.manifest.id === 'github-researcher'),
    );
    const branch = 'c'.repeat(40),
      head = 'a'.repeat(40);
    const file = (repository: string, path = 'README.md', commit?: string) => ({
      operation: 'file',
      repository,
      path,
      ...(commit ? {commit} : {}),
    });
    const discovery = {
      operation: 'repositories',
      query: 'research org:fixture',
    };
    const tokenCases: Record<string, object[]> = {
      'token-research': [
        discovery,
        {
          operation: 'resolve',
          repository: 'fixture/research',
          ref: 'feature/restore',
        },
        {
          operation: 'list',
          repository: 'fixture/research',
          commit: branch,
          path: '.',
        },
        file('fixture/research', 'README.md', branch),
        file('fixture/other', 'src/config.yml'),
        {operation: 'history', repository: 'fixture/other', path: '.'},
        file('fixture/third', 'README.md', 'f'.repeat(40)),
        {
          operation: 'discussion',
          repository: 'fixture/third',
          kind: 'issue',
          number: 99,
        },
        {
          operation: 'search',
          repository: 'fixture/research',
          commit: branch,
          path: '.',
          term: 'setting',
        },
      ],
      'token-boundaries': [
        file('fixture/research/../../outside'),
        file('fixture/research\n'),
        file('fixture/research', '.env', head),
        file('fixture/research', '../README.md', head),
        {operation: 'list', repository: 'fixture/research', path: '/'},
        file('fixture/research', 'link', head),
        {operation: 'resolve', repository: 'fixture/denied'},
        {operation: 'resolve', repository: 'fixture/denied'},
        {...discovery, page: 2},
      ],
      'token-empty': [{operation: 'resolve', repository: 'fixture/empty'}],
      'token-hook-denied': [file('fixture/other')],
      'token-redacted': [file('fixture/other')],
    };
    const results: {scenario: string; passed: boolean}[] = [];
    for (const scenario of [
      'success',
      'blocked',
      'redacted',
      'provider-error',
      'missing-usage',
      'cancel',
      'delayed-close',
      'connection-audit-failure',
      'close-deadline',
      ...Object.keys(tokenCases),
      'legacy-policy',
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
            task:
              'Read fixture/research README at commit ' +
              head +
              ' and report the setting without claiming runtime execution.',
            actions: tokenCases[scenario],
            ...(scenario === 'legacy-policy' ? {legacyRepositories: []} : {}),
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
        if (scenario === 'legacy-policy') {
          assert.match(
            JSON.stringify(value.report),
            /Repository access options are no longer supported/,
          );
          assert.equal(value.connections, 0);
          assert.equal(value.wireGithub, 0);
        } else if (scenario in tokenCases) {
          const report = value.report;
          assert.equal(report.status, 'completed', stdout);
          assert.equal(report.binding.repositoryAccess, 'token');
          assert.equal(report.research.cleanupComplete, true);
          assert.equal(report.research.accountingComplete, true);
          assert.deepEqual(value.enclosingUsage, report.usage);
          const records = report.sourceEvidence.records as Array<{
            integrity: string;
            isError: boolean;
            content: Array<{text: string}>;
          }>;
          assert.equal(records.length, tokenCases[scenario].length);
          const requests = value.events.filter(
            (e: {kind: string}) => e.kind === 'github-request',
          ) as Array<{path: string; query: string}>;
          if (scenario === 'token-hook-denied') {
            assert.equal(value.wireGithub, 0);
            assert.ok(records.every(r => r.isError));
          } else {
            const observations = records.map(r =>
              JSON.parse(r.content[0].text),
            );
            if (scenario === 'token-research') {
              assert.ok(observations.every(o => o.status === 'ok'));
              assert.equal(observations[0].items.length, 5);
              assert.equal(observations[0].coverage.incompleteResults, true);
              assert.equal(observations[0].coverage.collectionLimited, true);
              assert.ok(report.sourceEvidence.clippedObservations.length > 0);
              assert.equal(observations[1].commit, branch);
              assert.deepEqual(
                observations[2].entries.map((e: {path: string}) => e.path),
                ['README.md', 'src'],
              );
              assert.ok(observations[2].omitted >= 2);
              assert.ok(
                observations[3].citation.includes(
                  `/blob/${branch}/README.md#L1-`,
                ),
              );
              assert.equal(observations[4].commit, head);
              assert.ok(observations[4].citation.includes('fixture/other'));
              assert.equal(observations[5].items[0].commit, head);
              assert.equal(observations[6].commit, 'f'.repeat(40));
              assert.ok(
                observations[7].items[0].citation.includes(
                  'fixture/third/issues/99',
                ),
              );
              assert.equal(observations[8].matches[0].path, 'README.md');
              assert.equal(
                requests.filter(
                  e =>
                    e.path === '/repos/fixture/other/commits' &&
                    new URLSearchParams(e.query).get('per_page') === '1',
                ).length,
                1,
              );
              assert.ok(
                requests.some(
                  e =>
                    new URLSearchParams(e.query).get('sha') ===
                    'feature/restore',
                ),
              );
              assert.ok(requests.every(e => !e.path.includes('evil.invalid')));
            } else if (scenario === 'token-boundaries') {
              assert.ok(
                observations.slice(0, 6).every(o => o.status === 'refused'),
              );
              assert.ok(
                observations.slice(6, 8).every(o => o.status === 'unavailable'),
              );
              assert.equal(observations[6].requestFailure.reused, false);
              assert.equal(observations[7].requestFailure.reused, true);
              assert.match(
                observations[6].reason,
                /absence is not established/,
              );
              assert.equal(
                requests.filter(e =>
                  e.path.startsWith('/repos/fixture/denied/'),
                ).length,
                1,
              );
              assert.equal(requests.length, 4);
              assert.ok(requests.every(e => !e.path.includes('/git/blobs/')));
              assert.equal(
                observations[8].coverage.earlierPagesNotObserved,
                true,
              );
            } else if (scenario === 'token-empty') {
              assert.equal(observations[0].status, 'unavailable');
              assert.match(observations[0].reason, /no pinned version/);
              assert.equal(value.wireGithub, 1);
            } else if (scenario === 'token-redacted') {
              assert.equal(records[0].integrity, 'modified-or-unavailable');
              assert.ok(
                JSON.stringify(report.sourceEvidence).includes('[REDACTED]'),
              );
              assert.ok(
                !JSON.stringify(report.sourceEvidence).includes(
                  'fake-sensitive',
                ),
              );
            }
          }
        } else if (scenario === 'connection-audit-failure') {
          assert.equal(value.attempts.length, 2);
          const [failed, recovered] = value.attempts;
          assert.equal(failed.report.status, 'failed');
          assert.equal(failed.auditFailures, 1);
          assert.equal(failed.connections, 0);
          assert.equal(failed.frames, 0);
          assert.equal(failed.wireGithub, 0);
          assert.equal(failed.openClientSockets, 0);
          assert.equal(failed.report.research.cleanupComplete, true);
          assert.equal(failed.report.research.accountingComplete, false);
          assert.equal(recovered.report.status, 'completed');
          assert.equal(recovered.connections, 1);
          assert.equal(recovered.frames, 2);
          assert.equal(recovered.wireGithub, 3);
          assert.equal(recovered.openClientSockets, 0);
          assert.equal(recovered.auditFailures, 1);
          assert.equal(recovered.report.research.cleanupComplete, true);
          assert.equal(recovered.report.research.accountingComplete, true);
          assert.deepEqual(recovered.enclosingUsage, recovered.report.usage);
        } else if (scenario === 'close-deadline') {
          assert.equal(value.attempts.length, 2);
          const [failed, refused] = value.attempts;
          assert.equal(failed.report.status, 'failed');
          assert.equal(failed.report.research.cleanupComplete, false);
          assert.equal(failed.report.research.accountingComplete, true);
          assert.equal(failed.connections, 1);
          assert.equal(failed.frames, 2);
          assert.equal(failed.wireGithub, 3);
          assert.equal(failed.openClientSockets, 1);
          assert.ok(failed.closeRequests > 0);
          assert.ok(failed.finishedAt >= failed.deadlineAt);
          assert.equal(refused.report.status, 'failed');
          assert.match(
            refused.report.error,
            /Standard research transport already active/,
          );
          assert.equal(refused.connections, failed.connections);
          assert.equal(refused.frames, failed.frames);
          assert.equal(refused.wireGithub, failed.wireGithub);
          assert.equal(refused.openClientSockets, 1);
          assert.equal(refused.report.research.accountingComplete, false);
          assert.notEqual(
            refused.report.binding.reservationId,
            failed.report.binding.reservationId,
          );
          assert.notEqual(
            refused.report.binding.sessionId,
            failed.report.binding.sessionId,
          );
        } else if (
          ['provider-error', 'missing-usage', 'cancel'].includes(scenario)
        ) {
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
