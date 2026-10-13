import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
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
import {setTimeout as sleep} from 'node:timers/promises';
import test from 'node:test';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = dirname(pkg);
const cli = join(pkg, 'benchmark/experiments.py');

test(
  'composable experiment CLI E2E; scripted transport only',
  {timeout: 120000},
  async t => {
    const scratch = join(pkg, 'tmp/e2e');
    await mkdir(scratch, {recursive: true});
    const root = await mkdtemp(join(scratch, 'experiments-'));
    const evidence: Array<Record<string, unknown>> = [];
    const providerRecord = join(root, 'provider.jsonl');
    const agent = join(root, 'agent');
    await mkdir(agent);
    const work = join(root, 'work');
    await mkdir(work);
    await writeFile(join(work, 'evidence.txt'), 'FIXTURE_EVIDENCE\n');
    const second = join(root, 'second');
    await mkdir(second);
    await writeFile(join(second, 'evidence.txt'), 'SECOND_EVIDENCE\n');
    await writeFile(
      join(root, 'prompt.md'),
      'Compare the supplied local evidence.\n',
    );
    await writeFile(
      join(root, 'authorization.md'),
      'Read-only local fixture; no network or writes.\n',
    );
    const childAction = {
      name: 'profile_subagent_run',
      args: {
        profile: 'configuration-drift-reviewer',
        task: 'Inspect evidence.txt only; no writes.',
      },
    };
    const tools = [
      'read',
      'grep',
      'find',
      'ls',
      'codemode',
      'profile_subagent_search',
      'profile_subagent_list',
      'profile_subagent_run',
    ];
    const config = {
      version: 1,
      id: 'fixture-composition',
      hypothesis: 'H005',
      criterion: 'Mechanics only; no quality/performance claim',
      cli: [
        process.execPath,
        join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
      ],
      common: {
        extensions: [
          join(pkg, 'src/index.ts'),
          join(pkg, 'test/fixture-provider.ts'),
          'builtin:codemode',
        ],
        inputs: [join(pkg, 'src'), join(pkg, 'profiles'), work, second],
        tools,
        provider: 'profile-e2e',
        model: 'scripted',
        thinking: 'off',
        timeoutSeconds: 30,
        environment: {
          PI_CODING_AGENT_DIR: agent,
          PROFILE_E2E_SCENARIO: 'orchestration-experiments',
          PROFILE_E2E_RECORD: providerRecord,
        },
      },
      cases: {
        first: {
          cwd: work,
          prompt: 'prompt.md',
          authorization: 'authorization.md',
        },
        second: {
          cwd: second,
          prompt: 'prompt.md',
          authorization: 'authorization.md',
        },
      },
      variants: {
        direct: {
          environment: {
            PROFILE_E2E_ACTIONS: JSON.stringify([
              {name: 'read', args: {path: 'evidence.txt'}},
            ]),
          },
        },
        child: {
          environment: {PROFILE_E2E_ACTIONS: JSON.stringify([childAction])},
        },
        nested: {
          environment: {
            PROFILE_E2E_ACTIONS: JSON.stringify([
              {
                name: 'codemode',
                args: {
                  code: `text(JSON.parse(await tools.profile_subagent_run(${JSON.stringify(childAction.args)})));`,
                },
              },
            ]),
          },
        },
      },
      trials: [
        {id: 'direct', case: 'first', variant: 'direct'},
        {id: 'child', case: 'second', variant: 'child'},
        {id: 'nested', case: 'first', variant: 'nested'},
      ],
    };
    const invoke = async (args: string[], ok = true) => {
      const result = spawnSync('python3', [cli, ...args], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 45000,
        maxBuffer: 4 * 1024 * 1024,
      });
      evidence.push({
        args,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status === 0, ok, result.stderr + result.stdout);
      return result;
    };
    const prepare = async (name: string, plan = config) => {
      const path = join(root, name + '.json');
      await writeFile(path, JSON.stringify(plan));
      const group = join(root, name);
      await invoke(['prepare', path, group]);
      return group;
    };
    const summary = async (group: string) => {
      const result = await invoke(['summarize', group]);
      const dir = result.stdout.trim();
      return {
        dir,
        data: JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')),
      };
    };
    try {
      await t.test(
        'plan composition, real direct/child/codemode execution, accounting and private evidence',
        async () => {
          const group = await prepare('matrix');
          await assert.rejects(stat(providerRecord)); // Preparation cannot invoke a model.
          await invoke(['run', group, 'child'], false); // Frozen order.
          for (const trial of config.trials)
            await invoke(['run', group, trial.id]);
          const {dir, data} = await summary(group);
          for (const [i, row] of data.results.entries()) {
            assert.equal(row.execution.status, 'exited');
            assert.equal(row.execution.exitCode, 0);
            assert.equal(row.metrics.completed, true);
            assert.equal(
              row.metrics.accountingComplete,
              true,
              JSON.stringify(row.metrics),
            );
            assert.equal(row.metrics.childCount, i === 0 ? 0 : 1);
            assert.equal(row.metrics.totalReportedCost, i === 0 ? 0 : 0.024);
            assert.equal(row.metrics.context.peakInputTokens, 10);
            assert.equal(row.quality, 'unreviewed');
            assert.equal(row.execution.cwd, i === 1 ? second : work);
            const parent = await readFile(
              join(dir, trialId(i), 'parent-session.jsonl'),
              'utf8',
            );
            assert.ok(parent.includes('PARENT_DONE'));
            const entries = parent
              .trim()
              .split('\n')
              .map(line => JSON.parse(line));
            assert.equal(entries[0].cwd, i === 1 ? second : work);
            assert.ok(
              entries.some(
                e =>
                  e.message?.role === 'user' &&
                  JSON.stringify(e.message.content).includes(
                    'Compare the supplied local evidence.',
                  ),
              ),
            );
            assert.deepEqual(row.configurationIssues, []);
            assert.ok(
              row.metrics.requestSetups.every(
                (s: {provider: string; model: string}) =>
                  s.provider === 'profile-e2e' && s.model === 'scripted',
              ),
            );
            const observed =
              i === 0
                ? parent
                : await readFile(
                    join(dir, trialId(i), 'child-1/messages.json'),
                    'utf8',
                  );
            assert.ok(
              observed.includes(
                i === 1 ? 'SECOND_EVIDENCE' : 'FIXTURE_EVIDENCE',
              ),
            );
            if (i > 0) {
              assert.deepEqual(row.metrics.children[0].model, {
                provider: 'openai-codex',
                id: 'gpt-6.1-sol',
              });
              assert.equal(row.metrics.children[0].thinkingLevel, 'medium');
            }
          }
          function trialId(i: number) {
            return config.trials[i].id;
          }
          assert.equal((await stat(group)).mode & 0o777, 0o700);
          assert.equal(
            (await stat(join(dir, 'summary.json'))).mode & 0o777,
            0o600,
          );
          assert.equal(
            await readFile(join(work, 'evidence.txt'), 'utf8'),
            'FIXTURE_EVIDENCE\n',
          );
          const saved = await readFile(
            join(group, 'runs/direct/execution.json'),
            'utf8',
          );
          await invoke(['run', group, 'direct'], false);
          assert.equal(
            await readFile(join(group, 'runs/direct/execution.json'), 'utf8'),
            saved,
          );
          assert.notEqual((await summary(group)).dir, dir);
          const altered = join(root, 'altered-evidence');
          await cp(group, altered, {recursive: true});
          const alteredSession = join(
            altered,
            'runs/direct/parent-session.jsonl',
          );
          await writeFile(
            alteredSession,
            (await readFile(alteredSession, 'utf8')) + '\n',
          );
          const alteredSummary = await summary(altered);
          assert.match(
            alteredSummary.data.results[0].measurementError,
            /Recorded evidence changed/,
          );
          assert.equal(
            alteredSummary.data.results[1].metrics.accountingComplete,
            true,
          );
        },
      );
      await t.test(
        'input additions and frozen-plan edits block before model work',
        async () => {
          const group = await prepare('drift');
          const before = await readFile(providerRecord, 'utf8');
          await writeFile(join(work, 'new.txt'), 'NEW INPUT');
          await invoke(['run', group, 'direct'], false);
          const execution = JSON.parse(
            await readFile(join(group, 'runs/direct/execution.json'), 'utf8'),
          );
          assert.equal(execution.status, 'blocked');
          assert.equal(await readFile(providerRecord, 'utf8'), before);
          const changed = await prepare('plan-drift');
          await writeFile(join(changed, 'plan.json'), '{}');
          await invoke(['run', changed, 'direct'], false);
          assert.equal(await readFile(providerRecord, 'utf8'), before);
        },
      );
      await t.test(
        'strict IDs, unknown fields, and duplicate trial IDs rejected',
        async () => {
          for (const patch of [
            {surprise: true},
            {trials: [config.trials[0], config.trials[0]]},
            {trials: [{...config.trials[0], id: '../escape'}]},
          ]) {
            const path = join(root, 'invalid.json');
            await writeFile(path, JSON.stringify({...config, ...patch}));
            await invoke(['prepare', path, join(root, 'invalid')], false);
          }
        },
      );
      await t.test(
        'timeout preserves incomplete evidence, never a fabricated successful zero',
        async () => {
          const plan = structuredClone(config);
          plan.common.timeoutSeconds = 1;
          plan.common.environment.PROFILE_E2E_SCENARIO = 'timeout';
          plan.trials = [{id: 'timeout', case: 'first', variant: 'child'}];
          const group = await prepare('timeout', plan);
          await invoke(['run', group, 'timeout'], false);
          const {data} = await summary(group);
          assert.equal(data.results[0].execution.status, 'timed-out');
          assert.ok(
            data.results[0].measurementError ||
              !data.results[0].metrics.accountingComplete,
          );
          await invoke(['run', group, 'timeout'], false);
        },
      );
      await t.test(
        'cancellation and evidence-write failure stop the owned CLI',
        async () => {
          const plan = structuredClone(config);
          plan.common.environment.PROFILE_E2E_SCENARIO = 'timeout';
          plan.trials = [{id: 'cancel', case: 'first', variant: 'child'}];
          const group = await prepare('cancel', plan);
          const child = spawn('python3', [cli, 'run', group, 'cancel'], {
            cwd: repo,
            stdio: 'ignore',
          });
          const exit = new Promise<number | null>(resolve =>
            child.once('exit', resolve),
          );
          try {
            for (let i = 0; i < 150; i++) {
              if (
                await stat(join(group, 'runs/cancel/process.json')).catch(
                  () => null,
                )
              )
                break;
              await sleep(50);
            }
            await stat(join(group, 'runs/cancel/process.json'));
            await sleep(500);
            child.kill('SIGTERM');
            assert.equal(await exit, 1);
            const record = JSON.parse(
              await readFile(join(group, 'runs/cancel/execution.json'), 'utf8'),
            );
            assert.equal(record.status, 'cancelled');
            await assert.rejects(stat(join(group, '.running')));
          } finally {
            child.kill('SIGKILL');
          }
          const processInfo = JSON.parse(
            await readFile(join(group, 'runs/cancel/process.json'), 'utf8'),
          );
          assert.throws(() => process.kill(processInfo.pid, 0), {
            code: 'ESRCH',
          });
          const failure = await prepare('write-failure', plan);
          const wrapper = join(root, 'fail-evidence-write.py');
          await writeFile(
            wrapper,
            `import sys, pathlib, json\nsys.dont_write_bytecode = True\nsys.path.insert(0, ${JSON.stringify(join(pkg, 'benchmark'))})\nimport experiments\noriginal = experiments.save\ndef fail(path, value):\n    if path.name == 'process.json':\n        original(path.with_name('injected-process.json'), value)\n        raise OSError('Injected evidence-write failure')\n    original(path, value)\nexperiments.save = fail\nsys.exit(experiments.main())\n`,
          );
          const failed = spawnSync(
            'python3',
            [wrapper, 'run', failure, 'cancel'],
            {cwd: repo, encoding: 'utf8', timeout: 30000},
          );
          assert.equal(failed.status, 1, failed.stderr + failed.stdout);
          const failedRecord = JSON.parse(
            await readFile(join(failure, 'runs/cancel/execution.json'), 'utf8'),
          );
          const failedProcess = JSON.parse(
            await readFile(
              join(failure, 'runs/cancel/injected-process.json'),
              'utf8',
            ),
          );
          assert.equal(failedRecord.status, 'invalid');
          assert.match(failedRecord.error, /Injected evidence-write failure/);
          assert.throws(() => process.kill(failedProcess.pid, 0), {
            code: 'ESRCH',
          });
        },
      );
      await t.test(
        'failed child is retained even when the parent completes',
        async () => {
          const plan = structuredClone(config);
          plan.common.environment.PROFILE_E2E_SCENARIO = 'provider-error';
          plan.trials = [{id: 'failed', case: 'first', variant: 'child'}];
          const group = await prepare('failed-child', plan);
          await invoke(['run', group, 'failed']);
          const {data} = await summary(group);
          assert.equal(data.results[0].metrics.completed, true);
          assert.equal(data.results[0].metrics.children[0].status, 'failed');
          assert.equal(data.results[0].metrics.toolFailures.length, 1);
          assert.equal(data.results[0].quality, 'unreviewed');
        },
      );
      await t.test(
        'outside-root child evidence and conflicting accounting remain unknown',
        async () => {
          const original = await readFile(
            join(root, 'matrix/runs/child/parent-session.jsonl'),
            'utf8',
          );
          for (const mode of [
            'outside-root',
            'missing-usage',
            'missing-child-cost',
            'omitted-arguments',
          ]) {
            const rows = original
              .trim()
              .split('\n')
              .map(line => JSON.parse(line));
            const result = rows.find(
              e =>
                e.message?.role === 'toolResult' &&
                e.message.toolName === 'profile_subagent_run',
            );
            if (mode === 'outside-root')
              result.message.details.artifactDir = work;
            else if (mode === 'missing-usage')
              delete rows.find(e => e.message?.role === 'assistant').message
                .usage;
            else if (mode === 'missing-child-cost')
              result.message.usage.cost.total = 0;
            else {
              result.message.nestedCalls.complete = false;
              for (const call of result.message.nestedCalls.calls) {
                delete call.arguments;
                call.argumentsBytes = 20000;
              }
            }
            const source = join(root, mode + '.jsonl');
            await writeFile(
              source,
              rows.map(e => JSON.stringify(e)).join('\n') + '\n',
            );
            const measured = await invoke([
              'measure',
              source,
              join(root, mode),
              '--child-root',
              join(agent, 'profile-subagent-runs'),
            ]);
            const m = JSON.parse(measured.stdout);
            assert.equal(m.accountingComplete, mode === 'omitted-arguments');
            assert.equal(
              m.totalReportedCost,
              mode === 'omitted-arguments' ? 0.024 : null,
            );
            assert.ok(
              mode === 'omitted-arguments'
                ? m.warnings.length > 0
                : m.issues.length > 0,
            );
            if (mode === 'outside-root')
              await assert.rejects(stat(join(root, mode, 'child-1')));
          }
          assert.equal(
            await readFile(
              join(root, 'matrix/runs/child/parent-session.jsonl'),
              'utf8',
            ),
            original,
          );
        },
      );
      await t.test(
        'unrelated charges cannot mask missing direct, nested or grouped child usage',
        async () => {
          const plan = structuredClone(config);
          const call = `tools.profile_subagent_run(${JSON.stringify(childAction.args)})`;
          plan.variants.nested.environment.PROFILE_E2E_ACTIONS = JSON.stringify(
            [
              {
                name: 'codemode',
                args: {
                  code: `text(await Promise.allSettled([${call}, ${call}]));`,
                },
              },
            ],
          );
          plan.trials = [{id: 'grouped', case: 'first', variant: 'nested'}];
          const grouped = await prepare('grouped-usage', plan);
          await invoke(['run', grouped, 'grouped']);
          const groupedSummary = await summary(grouped);
          assert.equal(groupedSummary.data.results[0].metrics.childCount, 2);
          assert.equal(
            groupedSummary.data.results[0].metrics.totalReportedCost,
            0.048,
          );
          for (const layout of ['child', 'nested', 'grouped']) {
            const run =
              layout === 'grouped'
                ? join(grouped, 'runs/grouped')
                : join(root, 'matrix/runs', layout);
            const original = await readFile(
              join(run, 'parent-session.jsonl'),
              'utf8',
            );
            for (const mode of ['valid', 'underreported', 'missing']) {
              const rows = original
                .split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line));
              const caller = rows.find(e => e.message?.role === 'assistant');
              const result = rows.find(e => e.message?.role === 'toolResult');
              caller.message.content.push({
                type: 'toolCall',
                id: 'unrelated',
                name: 'fixture_model_tool',
                arguments: {},
              });
              const extra = structuredClone(result);
              extra.id = 'unrelated-result';
              extra.parentId = result.id;
              extra.message = {
                role: 'toolResult',
                toolCallId: 'unrelated',
                toolName: 'fixture_model_tool',
                content: [{type: 'text', text: 'Synthetic charged tool'}],
                isError: false,
                usage: structuredClone(result.message.usage),
              };
              extra.message.usage.cost = {
                input: 0.1,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.1,
              };
              const index = rows.indexOf(result) + 1;
              rows[index].parentId = extra.id;
              rows.splice(index, 0, extra);
              if (mode === 'missing') delete result.message.usage;
              if (mode === 'underreported')
                result.message.usage.cost.total =
                  layout === 'grouped' ? 0.024 : 0;
              const source = join(root, `${layout}-${mode}.jsonl`);
              await writeFile(
                source,
                rows.map(row => JSON.stringify(row)).join('\n') + '\n',
              );
              const measured = await invoke([
                'measure',
                source,
                join(root, `${layout}-${mode}`),
                '--child-root',
                join(agent, 'profile-subagent-runs'),
                ...(layout === 'child'
                  ? []
                  : ['--events', join(run, 'events.jsonl')]),
              ]);
              const m = JSON.parse(measured.stdout);
              assert.equal(m.accountingComplete, mode === 'valid');
              if (mode === 'valid') {
                assert.ok(
                  Math.abs(
                    m.totalReportedCost -
                      (layout === 'grouped' ? 0.148 : 0.124),
                  ) < 1e-9,
                );
              } else {
                assert.equal(m.totalReportedCost, null);
                assert.match(m.issues.join('\n'), /enclosing tool usage/);
                assert.ok(
                  Math.abs(
                    m.recordedCostKnown -
                      (layout === 'grouped' && mode === 'underreported'
                        ? 0.124
                        : 0.1),
                  ) < 1e-9,
                );
              }
            }
            assert.equal(
              await readFile(join(run, 'parent-session.jsonl'), 'utf8'),
              original,
            );
          }
        },
      );
      await t.test(
        'offline measurement handles inherited/abandoned/helper usage and Unicode LF framing',
        async () => {
          const session = join(root, 'import.jsonl');
          const usage = {
            input: 10,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 11,
            cost: {total: 0.1},
          };
          const entry = (
            id: string,
            parentId: string | null,
            message: object,
          ) => ({
            id,
            parentId,
            type: 'message',
            timestamp: '2026-10-09T10:01:00Z',
            message,
          });
          const rows = [
            {
              type: 'session',
              id: 'old-import',
              timestamp: '2026-10-09T10:00:00Z',
            },
            {
              ...entry('inherited', null, {
                role: 'assistant',
                usage,
                content: [],
                stopReason: 'stop',
              }),
              timestamp: '2026-10-08T10:00:00Z',
            },
            entry('user', 'inherited', {
              role: 'user',
              content: 'Hello\u2028World',
            }),
            entry('abandoned', 'user', {
              role: 'assistant',
              content: [],
              usage,
              stopReason: 'stop',
            }),
            {
              id: 'helper',
              parentId: 'user',
              type: 'usage',
              timestamp: '2026-10-09T10:01:00Z',
              kind: 'cache_warm',
              usage,
            },
            entry('final', 'helper', {
              role: 'assistant',
              content: [],
              usage,
              stopReason: 'stop',
            }),
          ];
          await writeFile(
            session,
            rows.map(r => JSON.stringify(r)).join('\n') + '\n',
          );
          const result = await invoke([
            'measure',
            session,
            join(root, 'imported'),
          ]);
          const m = JSON.parse(result.stdout);
          assert.ok(Math.abs(m.totalReportedCost - 0.3) < 1e-9);
          assert.equal(m.parentRequests, 2);
          assert.equal(m.context.freshParentRequests, 1);
          assert.deepEqual(m.context.abandonedFreshEntryIds, ['abandoned']);
          await writeFile(session, '{partial');
          await invoke(['measure', session, join(root, 'partial')], false);
        },
      );
    } finally {
      await writeFile(
        join(scratch, 'experiments-evidence.json'),
        JSON.stringify(
          {
            root,
            scope:
              'Actual Pi/experiment CLI with scripted provider; no paid models or live DB',
            evidence,
            files: await readdir(root),
          },
          null,
          2,
        ),
        {mode: 0o600},
      );
    }
  },
);
