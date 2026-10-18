import process from 'node:process';
import console from 'node:console';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  readdir,
  lstat,
  chmod,
  utimes,
  writeFile,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  args,
  inventory,
  json,
  requireThat,
  save,
  sha,
  verifyFiles,
} from './release-lib.mjs';

process.umask(0o077);
const here = path.dirname(fileURLToPath(import.meta.url)),
  pkg = path.resolve(here, '..'),
  repo = path.resolve(pkg, '..');
const opt = args(process.argv.slice(2), [
  '--out',
  '--researcher-dir',
  '--allow-dirty',
]);
requireThat(
  opt['--out'] && opt['--researcher-dir'],
  'out_and_researcher_dir_required',
);
const git = (...argv) =>
  execFileSync('git', ['-C', repo, ...argv], {encoding: 'utf8'}).trim();
const dirty = Boolean(git('status', '--porcelain'));
requireThat(
  !dirty || opt['--allow-dirty'] === 'yes',
  'commit_packaging_source_before_release',
);
async function sourceSnapshot() {
  const files = git('ls-files', '-c', '-o', '--exclude-standard')
    .split('\n')
    .sort();
  const hashes = {};
  for (const file of files)
    hashes[file] = sha(await readFile(path.join(repo, file)));
  return sha(JSON.stringify(hashes));
}
const snapshotHash = await sourceSnapshot();
const commit = git('rev-parse', 'HEAD'),
  researcher = await realpath(opt['--researcher-dir']);
const frozen = await json(path.join(here, 'research-source.json'));
await verifyFiles(researcher, frozen.files);
const out = path.resolve(opt['--out']);
await mkdir(out, {recursive: true, mode: 0o700});
const stage = await mkdtemp(path.join(out, '.stage-'));
async function copy(from, to) {
  requireThat((await lstat(from)).isFile(), 'non_regular_release_input');
  await mkdir(path.dirname(to), {recursive: true, mode: 0o700});
  await copyFile(from, to);
  await chmod(to, 0o600);
}
for (const name of [
  'release-lib.mjs',
  'install.mjs',
  'manage.mjs',
  'INSTALL.md',
  'MIGRATION.md',
  'example-config.json',
  'research-source.json',
])
  await copy(path.join(here, name), path.join(stage, name));
for (const [from, to] of [
  ['parent', 'app'],
  ['researcher', 'researcher'],
])
  for (const name of ['package.json', 'package-lock.json'])
    await copy(path.join(here, from, name), path.join(stage, to, name));
execFileSync('npm', ['run', 'build', '--workspace', 'task-assistant'], {
  cwd: repo,
  stdio: 'inherit',
});
for (const name of (await readdir(path.join(pkg, 'dist'))).sort())
  if (name.endsWith('.js'))
    await copy(
      path.join(pkg, 'dist', name),
      path.join(stage, 'app/dist', name),
    );
for (const name of Object.keys(frozen.files))
  await copy(
    path.join(researcher, name),
    path.join(stage, 'researcher/profile-subagent', name),
  );
requireThat(
  (await sourceSnapshot()) === snapshotHash,
  'source_changed_during_build',
);
const files = await inventory(stage);
for (const name of Object.keys(files)) {
  const text = await readFile(path.join(stage, name), 'utf8');
  requireThat(
    !/\/(?:Users|home)\/|task-assistant-private-records|task-assistant-reference-pilot|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/.test(
      text,
    ),
    'private_material_in_release',
  );
}
const locks = {};
for (const name of ['app', 'researcher']) {
  const lock = await json(path.join(stage, name, 'package-lock.json'));
  for (const entry of Object.values(lock.packages)) {
    if (entry.resolved)
      requireThat(
        entry.resolved.startsWith('https://registry.npmjs.org/') &&
          entry.integrity &&
          !entry.link,
        'non_registry_dependency',
      );
  }
  locks[name] = {
    file: name + '/package-lock.json',
    sha256: files[name + '/package-lock.json'],
    versions: Object.fromEntries(
      Object.entries(lock.packages)
        .filter(([k]) => k)
        .map(([k, v]) => [k, v.version]),
    ),
  };
}
const id =
  'task-assistant-' +
  commit.slice(0, 12) +
  (dirty ? '-snapshot' : '') +
  '-' +
  sha(JSON.stringify(files)).slice(0, 12) +
  '-darwin-arm64';
await save(path.join(stage, 'release.json'), {
  schemaVersion: 1,
  id,
  source: {commit, tree: git('rev-parse', 'HEAD^{tree}'), dirty, snapshotHash},
  researcher: {
    revision: frozen.revision,
    snapshotHash: sha(JSON.stringify(frozen.files)),
    profileDigest: frozen.profileDigest,
  },
  runtime: {
    platform: 'darwin',
    arch: 'arm64',
    node: process.versions.node,
    nodeMinimum: '22.19.0',
    npm: execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim(),
    parentSdk: '1.1.0',
    researcherSdk: '0.99.2',
  },
  dependencyLocks: locks,
  files,
});
const archive = path.join(out, id + '.tgz');
try {
  await lstat(archive);
  throw new Error('release_already_exists');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
for (const name of [...Object.keys(files), 'release.json'])
  await utimes(path.join(stage, name), 0, 0);
const tar = execFileSync(
  '/usr/bin/tar',
  [
    '--format',
    'ustar',
    '--uid',
    '0',
    '--gid',
    '0',
    '--uname',
    'root',
    '--gname',
    'wheel',
    '--no-xattrs',
    '--no-mac-metadata',
    '-cf',
    '-',
    '-C',
    stage,
    ...[...Object.keys(files), 'release.json'].sort(),
  ],
  {env: {...process.env, COPYFILE_DISABLE: '1'}, maxBuffer: 16 * 1024 * 1024},
);
// BSD tar's -z embeds wall-clock time in gzip; Node's gzip header uses mtime=0.
await writeFile(archive, gzipSync(tar), {flag: 'wx', mode: 0o600});
const hash = sha(await readFile(archive));
await writeFile(
  archive + '.sha256',
  hash + '  ' + path.basename(archive) + '\n',
  {flag: 'wx', mode: 0o600},
);
console.log(
  JSON.stringify({archive, sha256: hash, stage, sourceCommit: commit}),
);
