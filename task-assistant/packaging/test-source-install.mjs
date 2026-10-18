import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFileSync, spawnSync} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  realpath,
  symlink,
  unlink,
  lstat,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {args, json, sha, save, dependencyLinks} from './release-lib.mjs';

process.umask(0o077);
const here = path.dirname(fileURLToPath(import.meta.url)),
  repo = path.resolve(here, '../..');
const opt = args(process.argv.slice(2), ['--npm-cli']);
assert.ok(opt['--npm-cli'], '--npm-cli must point to the real npm CLI');
const npm = await realpath(opt['--npm-cli']);
const git = (...argv) =>
  execFileSync('/usr/bin/git', ['-C', repo, ...argv], {
    encoding: 'utf8',
  }).trim();
assert.equal(
  git('status', '--porcelain'),
  '',
  'Commit the complete source before fresh-clone acceptance',
);
const commit = git('rev-parse', 'HEAD');
const artifact = await realpath(
  await mkdtemp(path.join(os.tmpdir(), 'task-assistant-source-')),
);
const home = path.join(artifact, 'isolated home'),
  bin = path.join(artifact, 'bin'),
  checkout = path.join(artifact, 'fresh clone with spaces');
for (const dir of [home, bin]) await mkdir(dir, {mode: 0o700});
await symlink(process.execPath, path.join(bin, 'node'));
await symlink(npm, path.join(bin, 'npm'));
const userConfig = path.join(artifact, 'user.npmrc'),
  globalConfig = path.join(artifact, 'global.npmrc');
for (const file of [userConfig, globalConfig])
  await writeFile(file, '', {mode: 0o600});
const env = {
  HOME: home,
  PATH: bin + ':/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  NPM_CONFIG_USERCONFIG: userConfig,
  NPM_CONFIG_GLOBALCONFIG: globalConfig,
};
const report = {
  schemaVersion: 1,
  passed: false,
  artifact,
  commit,
  startedAt: new Date().toISOString(),
  checks: [],
};
console.log('Source-install evidence: ' + artifact);
async function command(name, exe, argv, cwd = artifact, failure = null) {
  const result = spawnSync(exe, argv, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 1200000,
  });
  await writeFile(
    path.join(artifact, name + '.log'),
    (result.stdout || '') + (result.stderr || ''),
    {mode: 0o600},
  );
  assert.ifError(result.error);
  if (failure) {
    assert.notEqual(result.status, 0, name + ' should fail');
    assert.ok(
      result.stderr.includes(failure),
      name + ' must fail for ' + failure,
    );
  } else
    assert.equal(
      result.status,
      0,
      name + ' failed; inspect ' + artifact + '/' + name + '.log',
    );
  return result.stdout;
}
try {
  await command('clone', '/usr/bin/git', [
    'clone',
    '--no-local',
    '--no-hardlinks',
    '--no-tags',
    '--single-branch',
    repo,
    checkout,
  ]);
  assert.equal(
    (
      await command(
        'clone-head',
        '/usr/bin/git',
        ['rev-parse', 'HEAD'],
        checkout,
      )
    ).trim(),
    commit,
  );
  assert.equal(
    await lstat(path.join(checkout, '.git/objects/info/alternates')).then(
      () => true,
      () => false,
    ),
    false,
  );
  await command(
    'npm-ci',
    process.execPath,
    [
      npm,
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ],
    checkout,
  );
  await dependencyLinks(checkout);
  report.checks.push(
    'isolated single-branch Git clone without shared objects or developer dependencies; destination-local locked build dependencies',
  );

  // Ignored outputs are deliberately untrustworthy. Neither build may consume them.
  for (const component of ['task-assistant', 'profile-subagent']) {
    const dist = path.join(checkout, component, 'dist');
    await mkdir(dist, {recursive: true, mode: 0o700});
    await writeFile(
      path.join(dist, 'stale.js'),
      'throw Error("stale checkout output");\n',
    );
    await writeFile(
      path.join(
        dist,
        component === 'task-assistant' ? 'cli.js' : 'github-research.js',
      ),
      'not valid JavaScript\n',
    );
  }
  const builder = path.join(
    checkout,
    'task-assistant/packaging/build-release.mjs',
  );
  const first = JSON.parse(
    (
      await command(
        'build-first',
        process.execPath,
        [builder, '--out', path.join(artifact, 'first release')],
        checkout,
      )
    ).trim(),
  );
  const second = JSON.parse(
    (
      await command(
        'build-second',
        process.execPath,
        [builder, '--out', path.join(artifact, 'second release')],
        checkout,
      )
    ).trim(),
  );
  assert.equal(first.sha256, second.sha256);
  assert.equal(sha(await readFile(first.archive)), first.sha256);
  assert.equal(sha(await readFile(second.archive)), first.sha256);
  const manifest = await json(path.join(first.stage, 'release.json'));
  assert.equal(manifest.source.commit, commit);
  assert.equal(manifest.source.dirty, false);
  assert.ok(
    !Object.keys(manifest.files).some(n =>
      /(?:\.map|\.d\.ts|\.tsbuildinfo|stale\.js)$/.test(n),
    ),
  );
  report.archive = first.archive;
  report.archiveSha256 = first.sha256;
  report.manifest = manifest;
  report.checks.push(
    'both components compiled from checkout source; stale dist ignored; no source maps/declarations/build caches shipped; two byte-identical clean-source archives',
  );

  // A different user's home path must be refused before an archive is written.
  const appSource = path.join(checkout, 'task-assistant/src/config.ts'),
    appBytes = await readFile(appSource);
  try {
    for (const [label, homePath] of [
      ['mac-home', '/Users/fixture person/private.txt'],
      ['linux-home', '/home/fixture-person/private.txt'],
    ]) {
      await writeFile(
        appSource,
        Buffer.concat([
          appBytes,
          Buffer.from(
            '\nexport const releasePrivacyProbe = ' +
              JSON.stringify(homePath) +
              ';\n',
          ),
        ]),
      );
      const output = path.join(artifact, label);
      await command(
        label + '-refused',
        process.execPath,
        [builder, '--out', output, '--allow-dirty', 'yes'],
        checkout,
        'private_material_in_release',
      );
      assert.ok(!(await readdir(output)).some(n => n.endsWith('.tgz')));
    }
  } finally {
    await writeFile(appSource, appBytes);
  }
  report.checks.push(
    'synthetic macOS and Linux home paths rejected before archive creation; application source restored',
  );

  const source = path.join(checkout, 'profile-subagent/src/github-read.ts'),
    original = await readFile(source);
  try {
    await writeFile(
      source,
      Buffer.concat([original, Buffer.from('\n// changed source\n')]),
    );
    await command(
      'changed-source-refused',
      process.execPath,
      [
        builder,
        '--out',
        path.join(artifact, 'bad source'),
        '--allow-dirty',
        'yes',
      ],
      checkout,
      'release_hash_mismatch',
    );
  } finally {
    await writeFile(source, original);
  }
  const extra = path.join(checkout, 'profile-subagent/src/unexpected.ts');
  try {
    await writeFile(extra, 'export const unexpected = true;\n');
    await command(
      'extra-source-refused',
      process.execPath,
      [
        builder,
        '--out',
        path.join(artifact, 'extra source'),
        '--allow-dirty',
        'yes',
      ],
      checkout,
      'unexpected_research_source',
    );
  } finally {
    await unlink(extra);
  }
  const lock = path.join(checkout, 'package-lock.json'),
    lockBytes = await readFile(lock);
  try {
    await writeFile(lock, Buffer.concat([lockBytes, Buffer.from('\n')]));
    await command(
      'changed-build-lock-refused',
      process.execPath,
      [
        builder,
        '--out',
        path.join(artifact, 'bad lock'),
        '--allow-dirty',
        'yes',
      ],
      checkout,
      'build_dependencies_changed',
    );
  } finally {
    await writeFile(lock, lockBytes);
  }
  assert.equal(
    (
      await command(
        'final-clone-status',
        '/usr/bin/git',
        ['status', '--porcelain'],
        checkout,
      )
    ).trim(),
    '',
  );
  report.checks.push(
    'changed researcher source, extra compiler inputs and changed build lock refused; original checkout bytes restored',
  );

  const result = await command(
    'archive-install-e2e',
    process.execPath,
    [
      path.join(checkout, 'task-assistant/packaging/test-install.mjs'),
      '--archive',
      first.archive,
      '--npm-cli',
      npm,
    ],
    checkout,
  );
  report.install = JSON.parse(result.slice(result.indexOf('\n') + 1));
  assert.equal(report.install.passed, true);
  assert.equal(report.install.archiveSha256, first.sha256);
  report.checks.push(
    'actual freshly built archive passed the isolated install, task/session/restart, native cross-SDK research and paused-service E2E',
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save(path.join(artifact, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
}
