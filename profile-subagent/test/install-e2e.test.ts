import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = dirname(packageRoot);
const cli = join(
  repoRoot,
  'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
);
const fixture = join(packageRoot, 'test/fixture-provider.ts');
const dbTools = [
  'bc_site_db_search_saved_queries',
  'bc_site_db_run_saved_query',
  'bc_site_db_query',
];

test(
  'packed package install, tool prerequisites, delegation and removal',
  {timeout: 120000},
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'profile-install-'));
    const agent = join(scratch, 'agent');
    const cwd = join(scratch, 'workspace');
    const extracted = join(scratch, 'unpacked');
    const evidence: Array<Record<string, unknown>> = [];
    let passed = false;
    for (const dir of [agent, cwd, extracted]) await mkdir(dir);
    await writeFile(join(cwd, 'evidence.txt'), 'PACKAGED_LOCAL_EVIDENCE');
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
    };
    const command = async (
      name: string,
      bin: string,
      args: string[],
      extraEnv = {},
      timeout = 20000,
    ) => {
      const result = spawnSync(bin, args, {
        cwd,
        env: {...env, ...extraEnv},
        encoding: 'utf8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      await writeFile(join(scratch, `${name}.stdout`), result.stdout ?? '');
      await writeFile(join(scratch, `${name}.stderr`), result.stderr ?? '');
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      evidence.push({name, exitCode: result.status});
      return result.stdout;
    };
    try {
      const privateRoot = join(packageRoot, 'tmp/e2e');
      await mkdir(privateRoot, {recursive: true});
      const privateFixture = await mkdtemp(
        join(privateRoot, 'package-private-'),
      );
      await writeFile(join(privateFixture, 'evidence.json'), 'PRIVATE_FIXTURE');
      const rootPack = JSON.parse(
        // Packing a clean dependency tree can exceed the normal command timeout.
        await command(
          'root-pack',
          'npm',
          [
            'pack',
            repoRoot,
            '--dry-run',
            '--ignore-scripts',
            '--offline',
            '--json',
          ],
          {},
          60000,
        ),
      );
      const rootPaths = rootPack[0].files.map(
        (file: {path: string}) => file.path,
      );
      assert.ok(rootPaths.includes('profile-subagent/src/index.ts'));
      assert.ok(!rootPaths.some((path: string) => /(^|\/)tmp\//.test(path)));
      const pack = JSON.parse(
        await command('pack', 'npm', [
          'pack',
          packageRoot,
          '--offline',
          '--json',
          '--pack-destination',
          scratch,
        ]),
      );
      const paths = pack[0].files.map((file: {path: string}) => file.path);
      assert.ok(paths.includes('src/index.ts'));
      assert.ok(
        !paths.some((path: string) => /^(tmp|node_modules|test)\//.test(path)),
      );
      for (const id of [
        'postfix-investigator',
        'postfix-repair-planner',
        'postfix-repair-reviewer',
        'configuration-drift-reviewer',
        'documentation-consistency-reviewer',
      ]) {
        assert.ok(paths.includes(`profiles/${id}/profile.json`));
        assert.ok(paths.includes(`profiles/${id}/AGENTS.md`));
        assert.ok(
          paths.some(
            (path: string) =>
              path.startsWith(`profiles/${id}/skills/`) &&
              path.endsWith('/SKILL.md'),
          ),
        );
      }
      await command('extract', 'tar', [
        '-xzf',
        join(scratch, pack[0].filename),
        '-C',
        extracted,
      ]);
      const installed = join(extracted, 'package');
      await assert.rejects(stat(join(installed, 'node_modules')));
      await command('install', process.execPath, [
        cli,
        'install',
        installed,
        '--no-approve',
      ]);
      const settingsPath = join(agent, 'settings.json');
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.ok(
        settings.packages.some(
          (source: string) => resolve(agent, source) === installed,
        ),
      );
      const run = async (
        name: string,
        actions: unknown[],
        excludes: string[] = [],
      ) => {
        const stdout = await command(
          name,
          process.execPath,
          [
            cli,
            '--mode',
            'json',
            '--no-session',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-approve',
            '-e',
            fixture,
            '--provider',
            'profile-e2e',
            '--model',
            'scripted',
            '--thinking',
            'off',
            ...(excludes.length ? ['--exclude-tools', excludes.join(',')] : []),
            'PARENT_HISTORY_MARKER: run the package fixture.',
          ],
          {
            PROFILE_E2E_SCENARIO: 'happy',
            PROFILE_E2E_ACTIONS: JSON.stringify(actions),
            PROFILE_E2E_RECORD: join(scratch, `${name}.provider.jsonl`),
          },
        );
        return stdout
          .split('\n')
          .filter(line => line.startsWith('{'))
          .map(line => JSON.parse(line))
          .filter(
            event =>
              event.type === 'tool_execution_end' && !event.parentToolCallId,
          );
      };
      const blocked = await run('default-tools', [
        {
          name: 'profile_subagent_search',
          args: {query: 'documentation-consistency-reviewer'},
        },
      ]);
      assert.deepEqual(
        blocked[0].result.details.candidates[0].unavailableTools.sort(),
        ['find', 'grep', 'ls'],
      );
      settings.defaultTools = ['+grep', '+find', '+ls'];
      await writeFile(settingsPath, JSON.stringify(settings));
      const ready = await run(
        'file-role',
        [
          {name: 'profile_subagent_list', args: {}},
          {
            name: 'profile_subagent_search',
            args: {query: 'postfix-investigator'},
          },
          {
            name: 'profile_subagent_run',
            args: {
              profile: 'documentation-consistency-reviewer',
              task: 'NARROW_TASK_ONLY: read evidence.txt; no other files or writes.',
            },
          },
        ],
        dbTools,
      );
      assert.equal(ready[0].result.details.length, 5);
      assert.deepEqual(
        ready[1].result.details.candidates[0].unavailableTools.sort(),
        [...dbTools].sort(),
      );
      assert.equal(ready[2].isError, false);
      assert.equal(ready[2].result.details.status, 'completed');
      assert.match(ready[2].result.details.output, /PACKAGED_LOCAL_EVIDENCE/);
      assert.deepEqual([...ready[2].result.details.tools].sort(), [
        'find',
        'grep',
        'ls',
        'read',
      ]);
      const dbReady = await run('db-role', [
        {
          name: 'profile_subagent_run',
          args: {
            profile: 'postfix-investigator',
            task: 'NARROW_TASK_ONLY: inspect fixture-site with fake read-only evidence; no real systems.',
          },
        },
      ]);
      assert.equal(dbReady[0].result.details.status, 'completed');
      assert.match(dbReady[0].result.details.output, /FAKE_DB_EVIDENCE/);
      await command('remove', process.execPath, [
        cli,
        'remove',
        installed,
        '--no-approve',
      ]);
      const removed = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.ok(
        !removed.packages?.some(
          (source: string) => resolve(agent, source) === installed,
        ),
      );
      assert.ok((await stat(installed)).isDirectory());
      passed = true;
    } finally {
      const out = join(packageRoot, 'tmp/e2e');
      await mkdir(out, {recursive: true});
      await writeFile(
        join(out, 'install-evidence.json'),
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            passed,
            scratch,
            isolatedAgent: agent,
            transport: 'scripted; no live model or database',
            evidence,
          },
          null,
          2,
        ),
        {mode: 0o600},
      );
    }
  },
);
