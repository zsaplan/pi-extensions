import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = dirname(pkg);
const out = join(pkg, 'tmp/e2e');
const configId = 'configuration-drift-reviewer';
const plannerId = 'postfix-repair-planner';
const search = (query: string, limit?: number) => ({
  name: 'profile_subagent_search',
  args: {query, ...(limit === undefined ? {} : {limit})},
});
const run = (profile = configId) => ({
  name: 'profile_subagent_run',
  args: {
    profile,
    task: 'NARROW_TASK_ONLY: Compare supplied evidence. No writes.',
  },
});
const fileTools = ['read', 'grep', 'find', 'ls'];
const dbTools = [
  'bc_site_db_search_saved_queries',
  'bc_site_db_run_saved_query',
  'bc_site_db_query',
];

test(
  'discovery through real Pi CLI, including frozen H1 queries',
  {timeout: 180000},
  async t => {
    await mkdir(out, {recursive: true});
    const runRoot = await mkdtemp(join(out, 'search-'));
    const evidence: Array<Record<string, unknown>> = [];
    const corpusText = await readFile(
      join(pkg, 'test/evaluation/cases.json'),
      'utf8',
    );
    const corpus = JSON.parse(corpusText).cases as Array<{
      id: string;
      kind: string;
      family: string;
      split: string;
      query: string;
      expected: string;
    }>;
    const cases = [
      'metadata',
      'no-match',
      'inputs',
      'ties',
      'catalog-errors',
      'duplicates',
      'registry-error',
      'large',
      'unavailable',
      'disable-after',
      'change-after',
      'file-block-read',
      'file-redaction',
      'parent-block',
      'parent-redaction',
      'dispatcher',
      'tool-search',
      'direct',
      'documentation',
      'retrieval',
    ];
    try {
      for (const name of cases)
        await t.test(name, async () => {
          const dir = join(runRoot, name);
          const extension = join(dir, 'extension');
          const cwd = join(dir, 'workspace');
          const agentDir = join(dir, 'agent');
          await mkdir(cwd, {recursive: true});
          await mkdir(agentDir, {recursive: true});
          await cp(join(pkg, 'src'), join(extension, 'src'), {recursive: true});
          await cp(join(pkg, 'profiles'), join(extension, 'profiles'), {
            recursive: true,
          });
          await writeFile(join(extension, 'package.json'), '{"type":"module"}');
          await writeFile(join(cwd, 'evidence.txt'), 'LOCAL_EVIDENCE_CONTENT');
          await writeFile(
            join(cwd, 'AGENTS.md'),
            'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_LEAK',
          );
          await mkdir(join(cwd, '.pi/skills/openspec-fixture'), {
            recursive: true,
          });
          await writeFile(
            join(cwd, '.pi/skills/openspec-fixture/SKILL.md'),
            '---\nname: openspec-fixture\ndescription: AMBIENT_OPENSPEC_MUST_NOT_LEAK\n---\nDo not load into child.',
          );
          const registry = join(extension, 'profiles');
          const agents = join(registry, configId, 'AGENTS.md');
          const configPath = join(registry, configId, 'profile.json');
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          let actions: Array<{name: string; args: Record<string, unknown>}> = [
            search(configId),
            run(),
          ];
          if (name === 'metadata')
            actions = [
              search('Compare rendered configuration snapshots'),
              search('Compare rendered configuration snapshots'),
              search(configId, 1),
              {name: 'profile_subagent_list', args: {}},
            ];
          if (name === 'no-match')
            actions = [
              search('zyxwvu quuxxyz'),
              search('please help review this task'),
            ];
          if (name === 'inputs')
            actions = [
              search(' '),
              search('x'.repeat(2049)),
              search('configuration', 0),
              search('configuration', 6),
              search('configuration', 1.5),
            ];
          if (name === 'catalog-errors') {
            for (const bad of ['broken', 'missing', 'escaping', 'bad-shape']) {
              const dest = join(registry, bad);
              await cp(join(registry, configId), dest, {recursive: true});
              const m = {...config, id: bad};
              if (bad === 'missing') m.agents = 'absent.md';
              if (bad === 'escaping') m.agents = '../../../workspace/AGENTS.md';
              if (bad === 'bad-shape') m.builtinTools = ['bash'];
              await writeFile(
                join(dest, 'profile.json'),
                bad === 'broken' ? '{broken' : JSON.stringify(m),
              );
            }
            await symlink(cwd, join(registry, 'outside'));
            actions = [search('configuration')];
          }
          if (name === 'duplicates') {
            await cp(join(registry, configId), join(registry, 'duplicate'), {
              recursive: true,
            });
            actions = [search('configuration documentation'), run()];
          }
          if (name === 'ties') {
            for (const id of ['tie-b', 'tie-a']) {
              await cp(join(registry, configId), join(registry, id), {
                recursive: true,
              });
              await writeFile(
                join(registry, id, 'profile.json'),
                JSON.stringify({...config, id, tags: ['tieprobe']}),
              );
            }
            actions = [search('tieprobe')];
          }
          if (name === 'large') {
            config.description = 'configuration '.repeat(4000);
            await writeFile(configPath, JSON.stringify(config));
            for (let i = 0; i < 12; i++) {
              await mkdir(join(registry, 'bad-' + i));
              await writeFile(
                join(registry, 'bad-' + i, 'profile.json'),
                '{bad',
              );
            }
            actions = [search(configId)];
          }
          if (name === 'registry-error') {
            await rename(registry, join(extension, 'unavailable-registry'));
            actions = [search('configuration')];
          }
          if (name === 'dispatcher' || name === 'tool-search') {
            config.parentTools = [
              name === 'dispatcher' ? 'codemode' : 'tool_search',
            ];
            await writeFile(configPath, JSON.stringify(config));
          }
          if (name === 'direct') actions = [run()];
          if (name === 'documentation')
            actions = [
              search('documentation claims source'),
              run('documentation-consistency-reviewer'),
            ];
          if (name.startsWith('parent-'))
            actions = [search(plannerId), run(plannerId)];
          if (name === 'retrieval')
            actions = corpus
              .filter(c => c.kind === 'clear')
              .map(c => search(c.query));
          const recordPath = join(dir, 'provider.jsonl');
          const toolNames = [
            ...fileTools,
            ...dbTools,
            'profile_subagent_search',
            'profile_subagent_list',
            'profile_subagent_run',
          ].filter(n => !(name === 'unavailable' && n === 'read'));
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
              toolNames.join(','),
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
              'PARENT_HISTORY_MARKER: exercise discovery.',
            ],
            {
              cwd,
              encoding: 'utf8',
              timeout: 20000,
              maxBuffer: 20 * 1024 * 1024,
              env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agentDir,
                PI_OFFLINE: '1',
                PI_SKIP_VERSION_CHECK: '1',
                PROFILE_E2E_RECORD: recordPath,
                PROFILE_E2E_SCENARIO: 'search-' + name,
                PROFILE_E2E_ACTIONS: JSON.stringify(actions),
                PROFILE_E2E_AGENTS: agents,
              },
            },
          );
          await writeFile(join(dir, 'stdout.jsonl'), result.stdout ?? '');
          await writeFile(join(dir, 'stderr.txt'), result.stderr ?? '');
          assert.equal(result.error, undefined);
          assert.equal(result.status, 0, result.stderr);
          const events = result.stdout
            .split('\n')
            .filter(l => l.startsWith('{'))
            .map(l => JSON.parse(l));
          const ends = events.filter(
            e => e.type === 'tool_execution_end' && !e.parentToolCallId,
          );
          assert.equal(ends.length, actions.length);
          const records = (await readFile(recordPath, 'utf8'))
            .trim()
            .split('\n')
            .map(l => JSON.parse(l));
          const children = records.filter(r => r.request === 'child');
          const searches = ends.filter(
            e => e.toolName === 'profile_subagent_search',
          );
          for (const e of searches.filter(e => !e.isError)) {
            assert.ok(e.result.content[0].text.length <= 24000);
            assert.ok(
              !e.result.content[0].text.includes('You have one bounded'),
            );
            for (const c of e.result.details.candidates) {
              assert.match(c.digest, /^[0-9a-f]{64}$/);
              assert.equal(c.source.kind, 'bundled');
              assert.ok(!('systemPrompt' in c));
            }
          }
          const setupFailure = [
            'duplicates',
            'unavailable',
            'disable-after',
            'dispatcher',
            'tool-search',
          ].includes(name);
          if (
            !actions.some(a => a.name === 'profile_subagent_run') ||
            setupFailure
          ) {
            assert.equal(children.length, 0);
            assert.equal(
              records.filter(r => r.executed || r.fileHook).length,
              0,
            );
            assert.deepEqual(
              await readdir(join(agentDir, 'profile-subagent-runs')).catch(
                () => [],
              ),
              [],
            );
          } else {
            assert.ok(children.length > 0);
            for (const child of children) {
              assert.deepEqual(
                [...child.tools].sort(),
                (name.startsWith('parent-')
                  ? [...fileTools, ...dbTools]
                  : fileTools
                ).sort(),
              );
              assert.ok(
                !JSON.stringify(child).includes('PARENT_HISTORY_MARKER'),
              );
              assert.ok(
                !JSON.stringify(child).includes(
                  'AMBIENT_OPENSPEC_MUST_NOT_LEAK',
                ),
              );
              assert.ok(
                !JSON.stringify(child).includes(
                  'AMBIENT_PROJECT_INSTRUCTIONS_MUST_NOT_LEAK',
                ),
              );
            }
          }
          if (setupFailure) assert.equal(ends.at(-1).isError, true);
          if (name === 'metadata') {
            assert.deepEqual(searches[0].result, searches[1].result);
            assert.equal(searches[0].result.details.candidates[0].id, configId);
            assert.equal(searches[2].result.details.candidates.length, 1);
            assert.equal(ends.at(-1).result.details.length, 5);
          }
          if (name === 'no-match')
            for (const s of searches)
              assert.deepEqual(s.result.details.candidates, []);
          if (name === 'inputs' || name === 'registry-error')
            for (const e of ends) assert.equal(e.isError, true);
          if (name === 'catalog-errors') {
            assert.equal(searches[0].result.details.diagnostics.length, 5);
            assert.ok(
              searches[0].result.details.candidates.some(
                (c: {id: string}) => c.id === configId,
              ),
            );
          }
          if (name === 'duplicates') {
            assert.equal(searches[0].result.details.diagnostics.length, 2);
            assert.ok(
              !searches[0].result.details.candidates.some(
                (c: {id: string}) => c.id === configId,
              ),
            );
          }
          if (name === 'ties')
            assert.deepEqual(
              searches[0].result.details.candidates.map(
                (c: {id: string}) => c.id,
              ),
              ['tie-a', 'tie-b'],
            );
          if (name === 'large') {
            assert.equal(searches[0].result.details.outputTruncated, true);
            assert.ok(searches[0].result.details.omittedCandidates > 0);
            assert.ok(searches[0].result.details.omittedDiagnostics > 0);
          }
          if (name === 'unavailable')
            assert.deepEqual(
              searches[0].result.details.candidates[0].unavailableTools,
              ['read'],
            );
          if (name === 'disable-after')
            assert.deepEqual(
              searches[0].result.details.candidates[0].unavailableTools,
              [],
            );
          if (name === 'change-after') {
            assert.notEqual(
              searches[0].result.details.candidates[0].digest,
              ends.at(-1).result.details.profileDigest,
            );
            assert.ok(children[0].system.includes('UPDATED_PROFILE_EVIDENCE'));
          }
          if (name === 'file-block-read' || name === 'parent-block')
            assert.ok(
              ends
                .at(-1)
                .result.details.output.includes(
                  name === 'parent-block'
                    ? 'PARENT_POLICY_DENIED'
                    : 'PARENT_FILE_POLICY_DENIED',
                ),
            );
          if (name === 'file-redaction' || name === 'parent-redaction') {
            assert.ok(
              ends
                .at(-1)
                .result.details.output.includes(
                  name === 'file-redaction'
                    ? 'PARENT_REDACTED'
                    : 'PARENT_DB_REDACTED',
                ),
            );
            assert.ok(
              !JSON.stringify(children).includes(
                name === 'file-redaction'
                  ? 'LOCAL_EVIDENCE_CONTENT'
                  : 'FAKE_DB_EVIDENCE',
              ),
            );
          }
          if (name === 'retrieval') {
            const ranks = corpus
              .filter(c => c.kind === 'clear')
              .map((c, i) => ({
                id: c.id,
                family: c.family,
                split: c.split,
                rank:
                  searches[i].result.details.candidates.findIndex(
                    (p: {id: string}) => p.id === c.expected,
                  ) + 1,
                candidates: searches[i].result.details.candidates.map(
                  (p: {id: string}) => p.id,
                ),
              }));
            await writeFile(
              join(dir, 'ranks.json'),
              JSON.stringify(ranks, null, 2),
            );
            evidence.push({ranks});
            assert.ok(ranks.filter(c => c.rank > 0).length >= 11);
            assert.ok(
              ranks.filter(c => c.split === 'held-out' && c.rank > 0).length >=
                5,
            );
            for (const family of ['postfix', 'configuration', 'documentation'])
              assert.ok(
                ranks.filter(c => c.family === family && c.rank > 0).length >=
                  3,
              );
          }
          evidence.push({name, passed: true, dir});
        });
    } finally {
      await writeFile(
        join(out, 'search-evidence.json'),
        JSON.stringify(
          {
            runRoot,
            checkedAt: new Date().toISOString(),
            corpusDigest: createHash('sha256').update(corpusText).digest('hex'),
            expectedCases: cases.length,
            evidence,
          },
          null,
          2,
        ),
      );
    }
  },
);
