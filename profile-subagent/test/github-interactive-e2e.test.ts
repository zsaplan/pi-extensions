import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const pkg = resolve(fileURLToPath(new URL('..', import.meta.url)));

test(
  'interactive GitHub entry: real Pi loading, binding and credential boundaries',
  {timeout: 120000},
  async t => {
    await mkdir(join(pkg, 'tmp/github-interactive'), {
      recursive: true,
      mode: 0o700,
    });
    const root = await mkdtemp(join(pkg, 'tmp/github-interactive/e2e-'));
    const cases = [
      {name: 'reload', scenario: 'success', reload: true},
      {name: 'session-switch', scenario: 'success', attempts: 2},
      {name: 'cli-credential', scenario: 'success', credentialSource: 'cli'},
      {name: 'github-env', scenario: 'success', credentialSource: 'github-env'},
      {
        name: 'missing-credential',
        scenario: 'success',
        credentialSource: 'missing',
      },
      {name: 'denied', scenario: 'blocked'},
      {name: 'redacted', scenario: 'redacted'},
      {name: 'cancel', scenario: 'cancel'},
      {name: 'headless', scenario: 'success', extensionMode: 'sdk'},
      {name: 'compiled-entry', scenario: 'success'},
      {name: 'codemode', scenario: 'success', viaCodemode: true},
    ];
    const results: {name: string; passed: boolean}[] = [];
    for (const item of cases) {
      await t.test(item.name, () => run(item));
    }
    async function run(item: (typeof cases)[number]) {
      const output = join(root, item.name),
        config = output + '.json';
      await writeFile(
        config,
        JSON.stringify({
          ...item,
          mode: 'fixture',
          module: join(pkg, 'dist/github-research.js'),
          interactiveModule: join(
            pkg,
            item.name === 'compiled-entry'
              ? 'dist/github-interactive.js'
              : 'src/github-interactive.ts',
          ),
          output,
          task: 'Read fixture/research README and report its setting. No runtime claims.',
        }),
        {mode: 0o600},
      );
      const child = spawnSync(
        process.execPath,
        [join(pkg, 'test/github-package-host.mjs'), config],
        {
          cwd: pkg,
          env: {...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1'},
          timeout: 25000,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        },
      );
      await writeFile(output + '.stdout', child.stdout ?? '', {mode: 0o600});
      await writeFile(output + '.stderr', child.stderr ?? '', {mode: 0o600});
      assert.equal(child.error, undefined, String(child.error));
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const value = JSON.parse(
        await readFile(join(output, 'result.json'), 'utf8'),
      );
      assert.equal(value.activeHttp, 0);
      if (item.name === 'headless') {
        assert.match(
          value.report.error,
          /No host-approved GitHub research binding/,
        );
        assert.equal(value.frames, 0);
        assert.equal(value.wireGithub, 0);
      } else {
        for (const attempt of value.attempts) {
          const report = attempt.report;
          assert.equal(report.binding.sessionId, attempt.parentSessionId);
          assert.equal(
            report.binding.threadKey,
            `interactive-${attempt.parentSessionId}`,
          );
          assert.equal(
            report.binding.taskId,
            `interactive-${report.binding.reservationId}`,
          );
          assert.equal(report.binding.repositoryAccess, 'token');
          assert.equal(
            report.binding.reservationId,
            createHash('sha256')
              .update(
                `${attempt.parentSessionId}\0${item.viaCodemode ? 'research/1' : 'research'}`,
              )
              .digest('hex'),
          );
          assert.ok(report.binding.deadlineAt >= attempt.startedAt + 90000);
          assert.ok(report.binding.deadlineAt <= attempt.finishedAt + 90000);
          assert.equal(report.research.cleanupComplete, true);
          assert.equal(attempt.openClientSockets, 0);
          if (item.name === 'cancel') {
            assert.equal(report.status, 'failed');
            assert.equal(report.research.accountingComplete, false);
          } else {
            assert.equal(report.status, 'completed');
            assert.equal(report.verification, 'unverified-report');
            assert.equal(report.research.accountingComplete, true);
            assert.deepEqual(attempt.enclosingUsage, report.usage);
            assert.equal(report.sourceEvidence.records.length, 1);
            const record = report.sourceEvidence.records[0];
            if (item.name === 'missing-credential' || item.name === 'denied') {
              assert.equal(record.isError, true);
              assert.equal(value.wireGithub, 0);
              assert.ok(
                !JSON.stringify(value).includes('SECRET_CREDENTIAL_DIAGNOSTIC'),
              );
            } else if (item.name === 'redacted') {
              assert.equal(record.integrity, 'modified-or-unavailable');
              assert.ok(JSON.stringify(record).includes('[REDACTED]'));
              assert.ok(!JSON.stringify(record).includes('fake-sensitive'));
            } else {
              assert.equal(record.isError, false);
              assert.equal(record.integrity, 'intact-adapter-observation');
              assert.ok(
                JSON.parse(record.content[0].text).citation.includes(
                  '/blob/' + 'a'.repeat(40),
                ),
              );
            }
          }
          assert.equal((await stat(report.artifactDir)).mode & 0o777, 0o700);
          assert.equal(
            (await stat(join(report.artifactDir, 'github-result.json'))).mode &
              0o777,
            0o600,
          );
          assert.ok(!JSON.stringify(report).includes('fixture-token'));
        }
        if (item.name === 'session-switch') {
          assert.equal(value.attempts.length, 2);
          assert.notEqual(
            value.attempts[0].report.binding.reservationId,
            value.attempts[1].report.binding.reservationId,
          );
          assert.notEqual(
            value.attempts[0].report.binding.sessionId,
            value.attempts[1].report.binding.sessionId,
          );
          assert.equal(value.frames, 4);
          assert.equal(value.wireGithub, 6);
        }
      }
      results.push({name: item.name, passed: true});
    }
    await writeFile(
      join(root, 'evidence.json'),
      JSON.stringify({
        root,
        results,
        liveRequests: 0,
        sdkMode: 'tui without terminal rendering',
      }),
      {mode: 0o600},
    );
    console.log('Interactive GitHub evidence: ' + root);
  },
);
