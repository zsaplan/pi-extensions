import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
  childEvidenceHandoff,
  parentDelegationGuidance,
} from '../src/guidance.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = dirname(packageRoot);
const outRoot = join(packageRoot, 'tmp/e2e');
const cli = join(
  repoRoot,
  'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
);

test('real Pi CLI and SDK delegation E2E', {timeout: 120000}, async t => {
  await mkdir(outRoot, {recursive: true});
  const runRoot = await mkdtemp(join(outRoot, 'run-'));
  const evidence: Array<Record<string, unknown>> = [];
  let baselineDigest: string | undefined;
  const cases = [
    'happy',
    'shared-guidance-provenance',
    'reviewer',
    'investigator-single',
    'investigator-batch',
    'local-read',
    'read-override',
    'file-redaction',
    'file-block-read',
    'file-block-grep',
    'file-block-find',
    'file-block-ls',
    'missing-file-tool',
    'runtime-auth',
    'runtime-auth-override',
    'cross-provider-key',
    'missing-child-model',
    'unsupported-thinking',
    'forbidden',
    'recursive',
    'parent-block',
    'missing-tool',
    'invalid-profile',
    'missing-resource',
    'invalid-manifest',
    'escape-resource',
    'turn-limit',
    'timeout',
    'cancel',
    'provider-error',
    'empty',
    'length',
    'large',
  ];
  try {
    for (const scenario of cases) {
      await t.test(scenario, async () => {
        const dir = join(runRoot, scenario);
        const agentDir = join(dir, 'agent');
        const cwd = join(dir, 'workspace');
        const extension = join(dir, 'extension');
        await mkdir(agentDir, {recursive: true});
        await mkdir(cwd, {recursive: true});
        await cp(join(packageRoot, 'src'), join(extension, 'src'), {
          recursive: true,
        });
        await cp(join(packageRoot, 'profiles'), join(extension, 'profiles'), {
          recursive: true,
        });
        await writeFile(join(extension, 'package.json'), '{"type":"module"}');
        if (scenario === 'shared-guidance-provenance') {
          const path = join(extension, 'src/guidance.ts');
          const original = await readFile(path, 'utf8');
          const changed = original.replace(
            "'# Evidence handoff',",
            "'# Evidence handoff',\n  'SHARED_POLICY_CHANGE',",
          );
          assert.notEqual(changed, original);
          await writeFile(path, changed);
        }
        await writeFile(
          join(agentDir, 'AGENTS.md'),
          'AMBIENT_USER_INSTRUCTIONS_MUST_NOT_LEAK',
        );
        await writeFile(
          join(cwd, 'AGENTS.md'),
          'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_LEAK',
        );
        await writeFile(join(cwd, 'evidence.txt'), 'LOCAL_EVIDENCE_CONTENT');
        const manifestPath = join(
          extension,
          'profiles/postfix-repair-planner/profile.json',
        );
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (scenario === 'turn-limit') manifest.maxTurns = 2;
        if (scenario === 'timeout') manifest.timeoutSeconds = 1;
        if (scenario === 'missing-resource') manifest.agents = 'absent.md';
        if (scenario === 'escape-resource')
          manifest.agents = '../../../workspace/AGENTS.md';
        if (scenario === 'invalid-manifest') manifest.builtinTools.push('bash');
        await writeFile(manifestPath, JSON.stringify(manifest));
        const recordPath = join(dir, 'provider.jsonl');
        const runtimeKey = 'fixture-runtime-only-not-for-artifacts';
        const parentToolNames = [
          'read',
          'grep',
          'find',
          'ls',
          'profile_subagent_list',
          'profile_subagent_run',
          'bc_site_db_search_saved_queries',
          'bc_site_db_run_saved_query',
          'bc_site_db_query',
        ].filter(
          name =>
            !(scenario === 'missing-file-tool' && name === 'read') &&
            !(scenario === 'missing-tool' && name === 'bc_site_db_query'),
        );
        const result = spawnSync(
          process.execPath,
          [
            cli,
            '--offline',
            '--mode',
            'json',
            '--no-session',
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-approve',
            '--tools',
            parentToolNames.join(','),
            ...(scenario.startsWith('runtime-auth') ||
            scenario === 'cross-provider-key'
              ? ['--api-key', runtimeKey]
              : []),
            '-e',
            join(extension, 'src/index.ts'),
            '-e',
            join(packageRoot, 'test/fixture-provider.ts'),
            '--provider',
            scenario.startsWith('runtime-auth')
              ? 'openai-codex'
              : 'profile-e2e',
            '--model',
            'scripted',
            '--thinking',
            'off',
            'PARENT_HISTORY_MARKER: delegate the fixture task.',
          ],
          {
            cwd,
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 10 * 1024 * 1024,
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: agentDir,
              PI_OFFLINE: '1',
              PI_SKIP_VERSION_CHECK: '1',
              PROFILE_E2E_SCENARIO: scenario,
              PROFILE_E2E_KEY: runtimeKey,
              PROFILE_E2E_RECORD: recordPath,
            },
          },
        );
        await writeFile(join(dir, 'stdout.jsonl'), result.stdout ?? '');
        await writeFile(join(dir, 'stderr.txt'), result.stderr ?? '');
        assert.equal(result.error, undefined, String(result.error));
        assert.equal(result.status, 0, result.stderr);
        const events = result.stdout
          .split('\n')
          .filter(l => l.startsWith('{'))
          .map(l => JSON.parse(l));
        const toolResult = events.find(
          e =>
            e.type === 'tool_execution_end' &&
            e.toolName === 'profile_subagent_run' &&
            !e.parentToolCallId,
        );
        assert.ok(
          toolResult,
          `Missing runner result: ${result.stdout.slice(-3000)} ${result.stderr}`,
        );
        const records = (await readFile(recordPath, 'utf8'))
          .trim()
          .split('\n')
          .map(l => JSON.parse(l));
        const requests = records.filter(r => r.request === 'child');
        const setupFailure = [
          'missing-tool',
          'missing-file-tool',
          'invalid-profile',
          'missing-resource',
          'invalid-manifest',
          'escape-resource',
        ].includes(scenario);
        if (setupFailure) {
          assert.equal(requests.length, 0);
          assert.equal(toolResult.isError, true);
        } else if (
          ['missing-child-model', 'unsupported-thinking'].includes(scenario)
        ) {
          assert.equal(requests.length, 0);
          assert.equal(toolResult.isError, true);
          assert.equal(toolResult.result.details.status, 'failed');
          assert.match(
            toolResult.result.details.error,
            scenario === 'missing-child-model'
              ? /Required child model is unavailable/
              : /thinking level did not match/,
          );
        } else {
          assert.ok(requests.length > 0);
          for (const request of records.filter(r => r.request)) {
            assert.equal(
              request.authMatched,
              true,
              'Parent and child must use the effective parent key',
            );
          }
          for (const request of requests) {
            assert.equal(request.provider, 'openai-codex');
            assert.equal(request.model, 'gpt-6.1-sol');
            assert.equal(request.reasoning, 'medium');
            assert.deepEqual(
              [...request.tools].sort(),
              [
                'read',
                'grep',
                'find',
                'ls',
                'bc_site_db_search_saved_queries',
                'bc_site_db_run_saved_query',
                'bc_site_db_query',
              ].sort(),
            );
            const context = JSON.stringify(request.messages);
            assert.ok(
              !context.includes('AMBIENT_USER_INSTRUCTIONS_MUST_NOT_LEAK'),
            );
            assert.ok(
              !context.includes('AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_LEAK'),
            );
            assert.ok(!context.includes('PARENT_HISTORY_MARKER'));
            assert.ok(context.includes('NARROW_TASK_ONLY'));
            assert.ok(!request.system.includes(parentDelegationGuidance));
            if (scenario === 'shared-guidance-provenance')
              assert.ok(request.system.includes('SHARED_POLICY_CHANGE'));
            else assert.ok(request.system.includes(childEvidenceHandoff));
            assert.ok(
              request.system.includes(
                scenario === 'reviewer'
                  ? '# Review a postfix repair'
                  : scenario.startsWith('investigator-')
                    ? '# Investigate postfix findings'
                    : '# Plan a postfix repair',
              ),
            );
          }
          const runs = await readdir(join(agentDir, 'profile-subagent-runs'));
          assert.equal(runs.length, 1);
          const artifactDir = join(agentDir, 'profile-subagent-runs', runs[0]);
          const summary = JSON.parse(
            await readFile(join(artifactDir, 'result.json'), 'utf8'),
          );
          const messages = JSON.parse(
            await readFile(join(artifactDir, 'messages.json'), 'utf8'),
          );
          const failed = [
            'turn-limit',
            'timeout',
            'cancel',
            'provider-error',
            'empty',
            'length',
          ].includes(scenario);
          assert.equal(
            summary.status,
            failed ? 'failed' : 'completed',
            JSON.stringify(summary),
          );
          assert.equal(toolResult.isError, failed);
          assert.ok(summary.profileDigest.match(/^[0-9a-f]{64}$/));
          if (scenario === 'happy') {
            baselineDigest = summary.profileDigest;
            const parent = records.find(r => r.request === 'parent');
            const declared = parent.declarations.find(
              (tool: {name: string}) => tool.name === 'profile_subagent_run',
            );
            assert.ok(declared.description.includes(parentDelegationGuidance));
          }
          if (scenario === 'shared-guidance-provenance') {
            assert.ok(baselineDigest);
            assert.notEqual(summary.profileDigest, baselineDigest);
          }
          if (scenario === 'local-read') {
            assert.ok(baselineDigest);
            assert.equal(summary.profileDigest, baselineDigest);
          }
          assert.deepEqual(summary.model, {
            provider: 'openai-codex',
            id: 'gpt-6.1-sol',
          });
          assert.equal(summary.thinkingLevel, 'medium');
          const input = JSON.parse(
            await readFile(join(artifactDir, 'input.json'), 'utf8'),
          );
          assert.deepEqual(input.model, summary.model);
          assert.equal(input.thinkingLevel, 'medium');
          assert.equal(input.parentModel.id, 'scripted');
          assert.equal(input.parentThinkingLevel, 'off');
          assert.equal((await stat(artifactDir)).mode & 0o777, 0o700);
          assert.equal(
            (await stat(join(artifactDir, 'result.md'))).mode & 0o777,
            0o600,
          );
          assert.equal(
            summary.usage.totalTokens,
            messages.reduce(
              (sum: number, m: {role: string; usage?: {totalTokens: number}}) =>
                sum +
                (m.role === 'assistant' ? (m.usage?.totalTokens ?? 0) : 0),
              0,
            ),
          );
          if (
            scenario.startsWith('runtime-auth') ||
            scenario === 'cross-provider-key'
          ) {
            for (const file of await readdir(artifactDir)) {
              assert.ok(
                !(await readFile(join(artifactDir, file), 'utf8')).includes(
                  runtimeKey,
                ),
                file,
              );
            }
            for (const file of [
              'auth.json',
              'models.json',
              'models-store.json',
            ]) {
              const content = await readFile(
                join(agentDir, file),
                'utf8',
              ).catch(() => '');
              assert.ok(!content.includes(runtimeKey), file);
            }
            assert.ok(!result.stdout.includes(runtimeKey));
            assert.ok(!result.stderr.includes(runtimeKey));
          }
          const childResults = messages.filter(
            (m: {role: string}) => m.role === 'toolResult',
          );
          if (['forbidden', 'recursive', 'parent-block'].includes(scenario)) {
            assert.equal(childResults[0].isError, true);
            assert.equal(records.filter(r => r.executed).length, 0);
          }
          if (scenario === 'parent-block') {
            const hook = records.find(r => r.hook);
            assert.ok(hook?.parentToolCallId);
            assert.ok(
              JSON.stringify(childResults).includes('PARENT_POLICY_DENIED'),
            );
          }
          if (scenario.startsWith('file-block-')) {
            const name = scenario.slice('file-block-'.length);
            assert.ok(records.find(r => r.fileHook === name)?.parentToolCallId);
            assert.equal(childResults[0].isError, true);
            assert.ok(summary.output.includes('PARENT_FILE_POLICY_DENIED'));
            assert.ok(!summary.output.includes('LOCAL_EVIDENCE_CONTENT'));
          }
          if (
            ['local-read', 'read-override', 'file-redaction'].includes(scenario)
          ) {
            assert.ok(
              records.find(r => r.fileHook === 'read')?.parentToolCallId,
            );
            const expected =
              scenario === 'local-read'
                ? 'LOCAL_EVIDENCE_CONTENT'
                : scenario === 'read-override'
                  ? 'PARENT_READ_OVERRIDE'
                  : 'PARENT_REDACTED';
            assert.ok(summary.output.includes(expected));
            if (scenario !== 'local-read') {
              assert.ok(
                !JSON.stringify(messages).includes('LOCAL_EVIDENCE_CONTENT'),
              );
            }
          }
          if (scenario === 'large') {
            assert.equal(
              (await readFile(join(artifactDir, 'result.md'), 'utf8')).length,
              30000,
            );
            assert.equal(toolResult.result.details.output.length, 24000);
            assert.equal(toolResult.result.details.outputTruncated, true);
          }
          if (scenario === 'turn-limit') {
            assert.equal(requests.length, 2);
            assert.equal(records.filter(r => r.executed).length, 1);
          }
          if (scenario.startsWith('investigator-')) {
            assert.equal(summary.profile, 'postfix-investigator');
            const assignments = messages.filter(
              (m: {role: string}) => m.role === 'user',
            );
            assert.equal(assignments.length, 1);
            for (const id of scenario === 'investigator-batch'
              ? ['268', '362', '503', '584', '525', '548', '544']
              : ['268']) {
              assert.ok(JSON.stringify(assignments).includes(id));
            }
          }
          if (
            ['happy', 'reviewer'].includes(scenario) ||
            scenario.startsWith('investigator-')
          ) {
            assert.ok(summary.output.includes('FAKE_DB_EVIDENCE'));
            assert.ok(records.find(r => r.hook)?.parentToolCallId);
          }
        }
        await assert.rejects(stat(join(cwd, 'MUST_NOT_EXIST')));
        evidence.push({scenario, passed: true, directory: dir});
      });
    }
  } finally {
    await writeFile(
      join(outRoot, 'evidence.json'),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          runtime: process.version,
          testProvider: 'deterministic; no live model or database',
          runRoot,
          expectedCases: cases.length,
          completedCases: evidence.length,
          evidence,
        },
        null,
        2,
      ),
    );
  }
});
