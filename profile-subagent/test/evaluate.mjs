import {spawnSync} from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import {createHash} from 'node:crypto';
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
import {childDefaults} from '../src/runner.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = dirname(pkg);
const provider = process.env.PI_PROVIDER;
const model = process.env.PI_MODEL;
const thinking = process.env.PI_THINKING ?? 'low';
if (!provider || !model)
  throw new Error('Set PI_PROVIDER and PI_MODEL explicitly.');
const hash = text => createHash('sha256').update(text).digest('hex');
const corpusText = await readFile(
  join(pkg, 'test/evaluation/cases.json'),
  'utf8',
);
const {cases} = JSON.parse(corpusText);
const out = join(pkg, 'tmp/evaluation');
await mkdir(out, {recursive: true, mode: 0o700});
const runRoot = await mkdtemp(join(out, 'run-'));
const hashes = {};
async function snapshot(dir) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await snapshot(path);
    else hashes[path.slice(repo.length + 1)] = hash(await readFile(path));
  }
}
await snapshot(join(pkg, 'src'));
await snapshot(join(pkg, 'profiles'));
await snapshot(join(pkg, 'test'));
const cli = join(
  repo,
  'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
);
const piVersion = JSON.parse(
  await readFile(join(dirname(cli), '../package.json'), 'utf8'),
).version;
const report = {
  startedAt: new Date().toISOString(),
  runRoot,
  provider,
  model,
  thinking,
  childDefaults,
  node: process.version,
  piVersion,
  corpusDigest: hash(corpusText),
  hashes,
  revision: spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).stdout.trim(),
  qualityReview: 'pending; completion is not quality',
  runs: [],
};
async function save() {
  await writeFile(
    join(runRoot, 'evidence.json'),
    JSON.stringify(report, null, 2),
    {mode: 0o600},
  );
}
await save();
console.log(runRoot);
for (let sweep = 1; sweep <= 2; sweep++) {
  for (const task of cases) {
    const dir = join(runRoot, `${sweep}-${task.id}`);
    const cwd = join(dir, 'workspace');
    await mkdir(join(cwd, 'evidence'), {recursive: true, mode: 0o700});
    if (task.fixture)
      await cp(
        join(pkg, 'test/evaluation/fixtures', task.fixture),
        join(cwd, 'evidence'),
        {recursive: true},
      );
    const prompt =
      'Help with the following bounded task. Use a suitable specialist when one is available; if the task is unclear, ask a focused question. Do not claim checks you did not perform. ' +
      task.prompt;
    const args = [
      cli,
      '--mode',
      'json',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-approve',
      '-e',
      join(pkg, 'src/index.ts'),
      '-e',
      join(pkg, 'test/evaluation-tools.ts'),
      '--tools',
      'read,grep,find,ls,profile_subagent_search,profile_subagent_list,profile_subagent_run,bc_site_db_search_saved_queries,bc_site_db_run_saved_query,bc_site_db_query',
      '--provider',
      provider,
      '--model',
      model,
      '--thinking',
      thinking,
      prompt,
    ];
    await writeFile(
      join(dir, 'invocation.json'),
      JSON.stringify({cwd, args}, null, 2),
      {mode: 0o600},
    );
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 30 * 1024 * 1024,
      env: {
        ...process.env,
        PROFILE_EVAL_WORKSPACE: cwd,
        PI_SKIP_VERSION_CHECK: '1',
      },
    });
    await writeFile(join(dir, 'stdout.jsonl'), result.stdout ?? '', {
      mode: 0o600,
    });
    await writeFile(join(dir, 'stderr.txt'), result.stderr ?? '', {
      mode: 0o600,
    });
    const events = (result.stdout ?? '').split('\n').flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const starts = events.filter(
      e => e.type === 'tool_execution_start' && !e.parentToolCallId,
    );
    const ends = events.filter(
      e => e.type === 'tool_execution_end' && !e.parentToolCallId,
    );
    const selected = starts.filter(e => e.toolName === 'profile_subagent_run');
    const searches = ends.filter(e => e.toolName === 'profile_subagent_search');
    const finals = events.filter(
      e => e.type === 'message_end' && e.message.role === 'assistant',
    );
    const run = {
      sweep,
      id: task.id,
      dir,
      exit: result.status,
      error: result.error?.message,
      selected: selected.map(e => e.args),
      searches: searches.map(e => e.result),
      children: ends
        .filter(e => e.toolName === 'profile_subagent_run')
        .map(e => ({isError: e.isError, result: e.result})),
      final: finals.at(-1)?.message,
      parentUsage: finals.map(e => e.message.usage),
      selectionPass:
        task.kind === 'clear'
          ? searches.some(e => !e.isError) &&
            selected.length === 1 &&
            selected[0].args?.profile === task.expected
          : selected.length === 0,
      qualityReview:
        task.quality || task.kind === 'ambiguous' ? 'pending' : 'not scored',
    };
    report.runs.push(run);
    await save();
    console.log(
      JSON.stringify({
        sweep,
        id: task.id,
        exit: run.exit,
        selectionPass: run.selectionPass,
        selected: run.selected.map(s => s?.profile),
      }),
    );
    if (
      result.status !== 0 ||
      result.error ||
      finals.at(-1)?.message.stopReason !== 'stop'
    ) {
      report.blocked =
        'Process/model failure; remaining cases not run. Diagnose before restarting; preserve this evidence.';
      await save();
      process.exitCode = 1;
      break;
    }
  }
  if (report.blocked) break;
}
report.finishedAt = new Date().toISOString();
await save();
