import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import type {Message} from '@earendil-works/pi-ai';
import {parentDelegationGuidance} from '../src/guidance.ts';

// Real CLI/QuickJS execution with scripted model and DB transport.
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = dirname(pkg);
const out = join(pkg, 'tmp/e2e');
const planner = 'postfix-repair-planner';
const jobs = (count: number) =>
  Array.from({length: count}, (_, i) => ({
    profile: planner,
    task: `NARROW_TASK_ONLY TASK_${i}`,
  }));
const batch = (assignments = jobs(7)) => `
const results = await Promise.allSettled(${JSON.stringify(assignments)}.map(async job =>
  JSON.parse(await tools.profile_subagent_run(job))));
text(results.map(r => r.status === 'fulfilled'
  ? {settled: r.status, ...r.value} : {settled: r.status, error: String(r.reason)}));`;

test(
  'parent orchestration through real CLI and built-in codemode',
  {timeout: 180000},
  async t => {
    await mkdir(out, {recursive: true});
    const runRoot = await mkdtemp(join(out, 'orchestration-'));
    const evidence: Array<Record<string, unknown>> = [];
    const cases = [
      'parallel',
      'direct',
      'failure-release',
      'runner-disabled',
      'missing-tool',
      'invalid-args',
      'runner-block',
      'parent-block',
      'parent-redaction',
      'file-block-read',
      'file-redaction',
      'disable-after',
      'change-after',
      'cancel',
      'timeout',
      'script-error',
      'early-return',
    ];
    try {
      for (const name of cases)
        await t.test(name, async () => {
          const dir = join(runRoot, name);
          const cwd = join(dir, 'workspace');
          const agentDir = join(dir, 'agent');
          const extension = join(dir, 'extension');
          await mkdir(cwd, {recursive: true});
          await mkdir(agentDir, {recursive: true});
          await cp(join(pkg, 'src'), join(extension, 'src'), {recursive: true});
          await cp(join(pkg, 'profiles'), join(extension, 'profiles'), {
            recursive: true,
          });
          await writeFile(join(extension, 'package.json'), '{"type":"module"}');
          await writeFile(join(cwd, 'evidence.txt'), 'LOCAL_EVIDENCE_CONTENT');
          await writeFile(join(cwd, 'AGENTS.md'), 'AMBIENT_MUST_NOT_LEAK');
          const assignments = jobs(7);
          if (name === 'failure-release')
            assignments[0].task = 'NARROW_TASK_ONLY TASK_FAIL';
          if (name.startsWith('file-'))
            for (const job of assignments)
              job.profile = 'configuration-drift-reviewer';
          let code = batch(assignments);
          if (name === 'parallel')
            code = `
const found = JSON.parse(await tools.profile_subagent_search({query: '${planner}'}));
const catalog = JSON.parse(await tools.profile_subagent_list({}));
text({found, catalogCount: catalog.length});
text(await describeTool('profile_subagent_run'));
${code}`;
          if (name === 'runner-disabled')
            code = `
text({listed: ALL_TOOLS.some(t => t.name === 'profile_subagent_run')});
try { await tools.profile_subagent_run(${JSON.stringify(assignments[0])}); }
catch (e) { text(String(e)); }`;
          if (name === 'invalid-args')
            code = `
try { await tools.profile_subagent_run({profile: '../escape', task: 'x'}); }
catch (e) { text(String(e)); }
${batch(jobs(1))}`;
          if (name === 'timeout')
            code = '// @options: {"timeout_ms": 1000}\n' + code;
          const recovers = ['timeout', 'script-error', 'early-return'].includes(
            name,
          );
          if (['script-error', 'early-return'].includes(name))
            code = `
void Promise.allSettled(${JSON.stringify(assignments)}.map(job => tools.profile_subagent_run(job)));
await tools.bc_site_db_query({site: 'barrier', sql: 'SELECT 1'});
${name === 'script-error' ? "throw new Error('SCRIPT_FAILURE_AFTER_LAUNCH');" : "return 'Ended without awaiting children';"}`;
          const actions = [{name: 'codemode', args: {code}}];
          if (recovers)
            actions.push({
              name: 'codemode',
              args: {
                code: batch([
                  {profile: planner, task: 'NARROW_TASK_ONLY TASK_RECOVERY'},
                ]),
              },
            });
          const tools = [
            'read',
            'grep',
            'find',
            'ls',
            'codemode',
            'profile_subagent_search',
            'profile_subagent_list',
            'profile_subagent_run',
            'bc_site_db_search_saved_queries',
            'bc_site_db_run_saved_query',
            'bc_site_db_query',
          ].filter(
            n =>
              !(name === 'runner-disabled' && n === 'profile_subagent_run') &&
              !(name === 'missing-tool' && n === 'bc_site_db_query'),
          );
          const recordPath = join(dir, 'provider.jsonl');
          const result = spawnSync(
            process.execPath,
            [
              join(
                repo,
                'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
              ),
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
              tools.join(','),
              '-e',
              'builtin:codemode',
              '-e',
              join(extension, 'src/index.ts'),
              '-e',
              join(pkg, 'test/fixture-provider.ts'),
              '--provider',
              'profile-e2e',
              '--model',
              'scripted',
              '--thinking',
              'off',
              'PARENT_HISTORY_MARKER: orchestrate the independent fixture assignments.',
            ],
            {
              cwd,
              encoding: 'utf8',
              timeout: 15000,
              maxBuffer: 16 * 1024 * 1024,
              env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agentDir,
                PI_OFFLINE: '1',
                PI_SKIP_VERSION_CHECK: '1',
                PROFILE_E2E_SCENARIO: `orchestration-${name}`,
                PROFILE_E2E_ACTIONS: JSON.stringify(
                  name === 'direct' ? [] : actions,
                ),
                PROFILE_E2E_RECORD: recordPath,
                PROFILE_E2E_AGENTS: join(
                  extension,
                  'profiles',
                  planner,
                  'AGENTS.md',
                ),
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
          const records = (await readFile(recordPath, 'utf8'))
            .trim()
            .split('\n')
            .map(l => JSON.parse(l));
          const requests = records.filter(r => r.request === 'child');
          const artifactRoot = join(agentDir, 'profile-subagent-runs');
          const dirs = await readdir(artifactRoot).catch(() => [] as string[]);
          const runs = await Promise.all(
            dirs.map(async id => ({
              id,
              input: JSON.parse(
                await readFile(join(artifactRoot, id, 'input.json'), 'utf8'),
              ),
              result: JSON.parse(
                await readFile(join(artifactRoot, id, 'result.json'), 'utf8'),
              ),
              messages: JSON.parse(
                await readFile(join(artifactRoot, id, 'messages.json'), 'utf8'),
              ) as Message[],
            })),
          );
          if (name === 'parallel') {
            const parent = records.find(r => r.request === 'parent');
            const declaredRun = parent.declarations.find(
              (tool: {name: string}) => tool.name === 'profile_subagent_run',
            );
            assert.ok(
              declaredRun.description.includes(parentDelegationGuidance),
            );
          }
          const noChildren = [
            'runner-disabled',
            'missing-tool',
            'runner-block',
          ].includes(name);
          const expectedRuns = noChildren
            ? 0
            : name === 'invalid-args'
              ? 1
              : name === 'direct'
                ? 5
                : ['cancel', 'disable-after'].includes(name)
                  ? 3
                  : recovers
                    ? 4
                    : 7;
          assert.equal(
            runs.length,
            expectedRuns,
            JSON.stringify({dirs, stdout: result.stdout.slice(-3000)}),
          );
          assert.equal(records.filter(r => r.childStart).length, expectedRuns);
          for (const request of requests) {
            assert.equal(request.authMatched, true);
            assert.equal(request.model, 'gpt-6.1-sol');
            assert.equal(request.reasoning, 'medium');
            assert.deepEqual(
              [...request.tools].sort(),
              (name.startsWith('file-')
                ? ['read', 'grep', 'find', 'ls']
                : [
                    'read',
                    'grep',
                    'find',
                    'ls',
                    'bc_site_db_search_saved_queries',
                    'bc_site_db_run_saved_query',
                    'bc_site_db_query',
                  ]
              ).sort(),
            );
            assert.ok(
              !JSON.stringify(request.messages).includes(
                'PARENT_HISTORY_MARKER',
              ),
            );
            assert.ok(!request.system.includes('AMBIENT_MUST_NOT_LEAK'));
          }
          const intervals = runs
            .flatMap(r => [
              {time: Date.parse(r.result.startedAt), change: 1},
              {time: Date.parse(r.result.finishedAt), change: -1},
            ])
            .sort((a, b) => a.time - b.time || a.change - b.change);
          let active = 0;
          let peak = 0;
          for (const event of intervals) {
            active += event.change;
            peak = Math.max(peak, active);
          }
          assert.ok(peak <= 3, `Exceeded concurrency bound: ${peak}`);
          if (expectedRuns >= 3)
            assert.equal(peak, 3, 'Independent runs must overlap');
          const topResults = events
            .filter(
              e => e.type === 'message_end' && e.message.role === 'toolResult',
            )
            .map(e => e.message);
          const output = topResults
            .flatMap(m => m.content)
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          if (name === 'parallel')
            assert.ok(output.includes(parentDelegationGuidance));
          if (name === 'runner-disabled')
            assert.match(output, /"listed":false/);
          if (name === 'missing-tool')
            assert.match(output, /Required parent tool is unavailable/);
          if (name === 'invalid-args')
            assert.match(output, /validation|pattern|escape/i);
          if (name === 'runner-block')
            assert.match(output, /PARENT_RUNNER_DENIED/);
          if (name === 'parent-block') {
            assert.equal(records.filter(r => r.executed).length, 0);
            assert.ok(
              runs.every(r => r.result.output.includes('PARENT_POLICY_DENIED')),
            );
          }
          if (name === 'parent-redaction') {
            assert.ok(
              runs.every(r => r.result.output.includes('PARENT_DB_REDACTED')),
            );
            assert.ok(
              !JSON.stringify(runs.map(r => r.messages)).includes(
                'FAKE_DB_EVIDENCE',
              ),
            );
          }
          if (name.startsWith('file-')) {
            assert.ok(
              runs.every(r =>
                r.result.output.includes(
                  name === 'file-redaction'
                    ? 'PARENT_REDACTED'
                    : 'PARENT_FILE_POLICY_DENIED',
                ),
              ),
            );
            assert.ok(
              !JSON.stringify(runs.map(r => r.messages)).includes(
                'LOCAL_EVIDENCE_CONTENT',
              ),
            );
          }
          if (name === 'change-after') {
            const changed = runs.filter(r =>
              r.input.profile.systemPrompt.includes('QUEUED_PROFILE_CHANGED'),
            );
            assert.equal(changed.length, 4);
            assert.equal(
              new Set(runs.map(r => r.result.profileDigest)).size,
              2,
            );
          }
          if (name === 'disable-after')
            assert.match(output, /Required parent tool is unavailable/);
          const failed = runs.filter(r => r.result.status === 'failed');
          assert.equal(
            failed.length,
            name === 'failure-release'
              ? 1
              : name === 'cancel' || recovers
                ? 3
                : 0,
          );
          if (name === 'failure-release')
            assert.match(output, /FIXTURE_PROVIDER_ERROR/);
          if (recovers)
            assert.ok(
              runs.some(
                r =>
                  r.input.task.includes('TASK_RECOVERY') &&
                  r.result.status === 'completed',
              ),
            );
          for (const run of runs) {
            assert.equal(run.messages.filter(m => m.role === 'user').length, 1);
            const tokens = run.messages
              .filter(m => m.role === 'assistant')
              .reduce((n, m) => n + m.usage.totalTokens, 0);
            assert.equal(run.result.usage.totalTokens, tokens);
            if (['parallel', 'direct'].includes(name)) {
              const key = run.input.task.match(/TASK_\d+/)[0];
              assert.ok(run.result.output.includes(`fixture-site-${key}`));
              for (const other of runs.filter(r => r.id !== run.id))
                assert.ok(
                  !JSON.stringify(run.messages).includes(
                    other.input.task.match(/TASK_\d+/)[0],
                  ),
                );
            }
          }
          let activeDb = 0;
          let peakDb = 0;
          for (const record of records) {
            if (record.dbStart) {
              activeDb++;
              peakDb = Math.max(peakDb, activeDb);
            }
            if (record.dbEnd) activeDb--;
          }
          assert.ok(peakDb <= 1, 'Preserve the parent DB tool serialization');
          assert.equal(activeDb, 0);
          for (const message of topResults) {
            if (message.nestedCalls)
              assert.equal(
                message.nestedCalls.complete,
                true,
                'No cancelled children left unfinished in parent accounting',
              );
          }
          const modelTokens = runs.reduce(
            (n, r) => n + r.result.usage.totalTokens,
            0,
          );
          const modelCost = runs.reduce(
            (n, r) => n + r.result.usage.cost.total,
            0,
          );
          const dbCalls = records.filter(r => r.executed).length;
          const chargedTokens = topResults.reduce(
            (n, r) => n + (r.usage?.totalTokens ?? 0),
            0,
          );
          const chargedCost = topResults.reduce(
            (n, r) => n + (r.usage?.cost.total ?? 0),
            0,
          );
          assert.equal(
            chargedTokens,
            modelTokens + 3 * dbCalls,
            'Nested usage must be charged exactly once',
          );
          assert.ok(
            Math.abs(chargedCost - (modelCost + 0.003 * dbCalls)) < 1e-8,
          );
          for (const hook of records.filter(r => r.hook || r.fileHook)) {
            assert.ok(hook.parentToolCallId);
            if (name !== 'direct' && hook.site !== 'barrier')
              assert.match(
                hook.parentToolCallId,
                /\//,
                'Must retain codemode -> runner -> evidence lineage',
              );
          }
          evidence.push({
            scenario: name,
            passed: true,
            directory: dir,
            children: runs.length,
            peakConcurrency: peak,
            chargedTokens,
            chargedCost,
          });
        });
    } finally {
      await writeFile(
        join(out, 'orchestration-evidence.json'),
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            runtime: process.version,
            scope:
              'Real CLI, built-in codemode, SDK; scripted model and DB, no live calls',
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
  },
);
