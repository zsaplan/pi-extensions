import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {setTimeout, clearTimeout} from 'node:timers';
import {spawn} from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  args,
  json,
  save,
  sha,
  verifyRelease,
  dependencyLinks,
} from './release-lib.mjs';

process.umask(0o077);
const here = path.dirname(fileURLToPath(import.meta.url)),
  pkg = path.resolve(here, '..');
const opt = args(process.argv.slice(2), ['--archive', '--npm-cli']);
assert.ok(opt['--archive'] && opt['--npm-cli']);
const archive = await realpath(opt['--archive']),
  npm = await realpath(opt['--npm-cli']);
const artifact = await realpath(
  await mkdtemp(path.join(os.tmpdir(), 'task-assistant-install-')),
);
await chmod(artifact, 0o700);
const home = path.join(artifact, 'unrelated home'),
  unpack = path.join(artifact, 'unpacked release'),
  destination = path.join(artifact, 'release with spaces'),
  bin = path.join(artifact, 'bin'),
  fixtures = path.join(artifact, 'fixtures');
for (const d of [home, unpack, bin, fixtures]) await mkdir(d, {mode: 0o700});
await symlink(process.execPath, path.join(bin, 'node'));
const env = {
  HOME: home,
  PATH: bin + ':/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  TASK_FIXTURE_ARTIFACT_ROOT: fixtures,
};
const report = {
  schemaVersion: 1,
  passed: false,
  startedAt: new Date().toISOString(),
  archive,
  archiveSha256: sha(await readFile(archive)),
  artifact,
  home,
  destination,
  node: process.versions.node,
  arch: process.arch,
  checks: [],
  liveActions: 0,
};
console.log('Install E2E evidence: ' + artifact);
async function command(name, exe, argv, extra = {}, expected = 0) {
  let output = '';
  const result = await new Promise((resolve, reject) => {
    const p = spawn(exe, argv, {
      env: {...env, ...extra},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', d => {
      output += d;
    });
    p.stderr.on('data', d => {
      output += d;
    });
    const timer = setTimeout(() => {
      p.kill('SIGTERM');
    }, 900000);
    p.once('error', reject);
    p.once('close', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await writeFile(path.join(artifact, name + '.log'), output, {mode: 0o600});
  assert.equal(
    result,
    expected,
    name + ' failed; inspect ' + artifact + '/' + name + '.log',
  );
  return output;
}
try {
  assert.equal(
    (await readFile(archive + '.sha256', 'utf8')).split(/\s/)[0],
    report.archiveSha256,
  );
  await command('unpack', '/usr/bin/tar', ['-xzf', archive, '-C', unpack]);
  const manifest = await verifyRelease(unpack);
  report.releaseId = manifest.id;
  report.source = manifest.source;
  report.researcher = manifest.researcher;
  report.checks.push(
    'archive checksum, exact file inventory, platform/runtime and no source symlinks',
  );
  await command('install', process.execPath, [
    path.join(unpack, 'install.mjs'),
    '--prefix',
    destination,
    '--npm-cli',
    npm,
  ]);
  const installed = await json(path.join(destination, 'installed.json'));
  assert.equal(installed.started, false);
  assert.equal(installed.dependencies.parentSdk, '1.1.0');
  assert.equal(installed.dependencies.researcherSdk, '0.99.2');
  await dependencyLinks(destination);
  report.checks.push(
    'actual unpacked installer, destination-local locked SDKs and frozen profile, paths containing spaces',
  );
  const before = await readFile(
    path.join(destination, 'installed.json'),
    'utf8',
  );
  await command(
    'existing-destination-rejected',
    process.execPath,
    [
      path.join(unpack, 'install.mjs'),
      '--prefix',
      destination,
      '--npm-cli',
      npm,
    ],
    {},
    1,
  );
  assert.equal(
    await readFile(path.join(destination, 'installed.json'), 'utf8'),
    before,
  );
  const cliSource = path.join(unpack, 'app/dist/cli.js'),
    original = await readFile(cliSource);
  await writeFile(
    cliSource,
    Buffer.concat([original, Buffer.from('\n// tampered\n')]),
  );
  await command(
    'tampered-artifact-rejected',
    process.execPath,
    [
      path.join(unpack, 'install.mjs'),
      '--prefix',
      path.join(artifact, 'bad install'),
      '--npm-cli',
      npm,
    ],
    {},
    1,
  );
  await writeFile(cliSource, original);
  report.checks.push(
    'existing install not overwritten; tampered compiled code refused',
  );

  // Prevent every network/launchctl call in local-only management, including child Node commands.
  const guard = path.join(artifact, 'no-network-or-launch.mjs'),
    escaped = path.join(artifact, 'forbidden-action'),
    clockOffsetFile = path.join(artifact, 'configuration-clock-offset');
  await writeFile(
    guard,
    `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const clock=${JSON.stringify(clockOffsetFile)};if(fs.existsSync(clock)){const offset=Number(fs.readFileSync(clock,'utf8')),NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...v){if(v.length)super(...v);else super(NativeDate.now()+offset);}static now(){return NativeDate.now()+offset;}};}
const deny=()=>{fs.writeFileSync(${JSON.stringify(escaped)},'attempted');throw Error('Forbidden live operation');};globalThis.fetch=deny;
const exec=cp.execFileSync,spawn=cp.spawnSync;cp.execFileSync=(file,args,opts)=>{if(file==='/bin/launchctl')return deny();return exec(file,args,opts);};
cp.spawnSync=(file,args,opts)=>spawn(file,file===process.execPath?['--import',${JSON.stringify(guard)},...args]:args,opts);syncBuiltinESMExports();`,
    {mode: 0o600},
  );
  const manage = path.join(destination, 'manage.mjs'),
    privateBase = path.join(artifact, 'private state'),
    configFile = path.join(privateBase, 'config.json');
  const local = (name, argv, code = 0) =>
    command(
      name,
      process.execPath,
      ['--import', guard, manage, ...argv],
      {},
      code,
    );
  await local('init-config', [
    'init-config',
    '--file',
    configFile,
    '--private-base',
    privateBase,
  ]);
  const checked = JSON.parse(
    await local('fresh-check', ['check', '--config', configFile]),
  );
  assert.ok(checked.missingPrerequisites.includes('approval'));
  assert.equal(checked.networkChecked, false);
  await local('unapproved-configure', ['configure', '--config', configFile], 1);
  report.checks.push(
    'fresh config/check stays offline; missing credentials/approval blocks service configuration',
  );

  // Existing behavioral tests run against packaged code, not source checkout dist or node_modules.
  await mkdir(path.join(destination, 'app/test'), {mode: 0o700});
  for (const file of [
    'flow.test.ts',
    'background.test.ts',
    'e2e.test.ts',
    'github-research-fixture.mjs',
  ])
    await copyFile(
      path.join(pkg, 'test', file),
      path.join(destination, 'app/test', file),
    );
  // npm-pack tests the source workspace, not this standalone release format.
  // It still runs in package/root verification; this driver tests the real archive instead.
  await command(
    'packaged-cli-and-session-tests',
    process.execPath,
    [
      '--test',
      '--test-skip-pattern=packaged JavaScript CLI runs inside node_modules without TypeScript stripping',
      ...['e2e.test.ts', 'background.test.ts', 'flow.test.ts'].map(f =>
        path.join(destination, 'app/test', f),
      ),
    ],
    {TASK_FIXTURE_RELEASE_MANIFEST: path.join(destination, 'release.json')},
  );
  report.checks.push(
    'actual packaged preflight, task/session/restart, approval/budget, uncertain-send and supervisor/failure-latch synthetic fixtures',
  );
  const researchArtifact = path.join(fixtures, 'native-research');
  await mkdir(researchArtifact, {mode: 0o700});
  await command(
    'packaged-native-research',
    process.execPath,
    [
      path.join(destination, 'app/test/github-research-fixture.mjs'),
      researchArtifact,
    ],
    {
      GH_TOKEN: 'fixture-token',
      TASK_RESEARCH_PACKAGE: path.join(
        destination,
        'researcher/profile-subagent',
      ),
    },
  );
  assert.equal(
    (await json(path.join(researchArtifact, 'report.json'))).passed,
    true,
  );
  report.checks.push(
    'packaged parent 1.1.0 plus frozen researcher 0.99.2 native synthetic integration',
  );

  // Use only synthetic history created by the real flow fixture. Never fabricate production authority.
  const flow = (await readdir(fixtures)).filter(n => n.startsWith('flow-e2e-'));
  assert.equal(flow.length, 1);
  const f = path.join(fixtures, flow[0]),
    approvalFile = path.join(f, 'regular-approval.json'),
    backlogFile = path.join(f, 'backlog-approval.json');
  const approval = await json(approvalFile),
    c = await json(configFile);
  Object.assign(c, {
    dataRoot: approval.scope.root,
    sessionLibrary: approval.scope.session_library,
    conversation: approval.scope.conversation,
    approvalFile,
    backlogApprovalFile: backlogFile,
  });
  for (const d of [c.parentAgentDir, c.researcherAgentDir, c.sessionLibrary])
    await mkdir(d, {recursive: true, mode: 0o700});
  for (const d of [c.parentAgentDir, c.researcherAgentDir])
    await save(path.join(d, 'auth.json'), {});
  await save(c.credentialsFile, {
    SLACK_USER_TOKEN: 'fixture-private-user',
    SLACK_BOT_TOKEN: 'fixture-private-bot',
    GH_TOKEN: 'fixture-private-github',
  });
  await writeFile(configFile, JSON.stringify(c, null, 2) + '\n', {mode: 0o600});
  // Continue the flow fixture's simulated day; never rewrite its future-dated reservations.
  const offset = Number(
    await readFile(path.join(c.dataRoot, 'date-offset'), 'utf8'),
  );
  assert.equal(offset, 86400001);
  await writeFile(clockOffsetFile, String(offset), {mode: 0o600});
  report.configurationClockOffsetMs = offset;
  const ledgerFile = path.join(c.dataRoot, 'runs/regular-use.json'),
    ledgerBefore = await readFile(ledgerFile, 'utf8');
  const boundFile = path.join(c.dataRoot, 'intake/github-research.json');
  await save(boundFile, {schema_version: 1, manifest_hash: '0'.repeat(64)});
  const boundBefore = await readFile(boundFile, 'utf8');
  await local(
    'research-rebind-refused',
    ['configure', '--config', configFile],
    1,
  );
  assert.equal(await readFile(boundFile, 'utf8'), boundBefore);
  await writeFile(configFile, JSON.stringify({...c, researcher: false}), {
    mode: 0o600,
  });
  await local(
    'research-removal-refused',
    ['configure', '--config', configFile],
    1,
  );
  assert.equal(await readFile(boundFile, 'utf8'), boundBefore);
  await unlink(boundFile); // Only the synthetic mismatch introduced by this test.
  await writeFile(configFile, JSON.stringify(c), {mode: 0o600});
  await local('configure-paused', ['configure', '--config', configFile]);
  assert.equal(await readFile(ledgerFile, 'utf8'), ledgerBefore);
  const status = JSON.parse(
    await local('paused-status', ['status', '--config', configFile]),
  );
  assert.equal(status.paused, true);
  assert.equal(status.supervisor_alive, false);
  assert.equal(status.worker_alive, false);
  const settings = await json(path.join(c.serviceDir, 'settings.json'));
  assert.ok(settings.args.includes(c.parentAgentDir));
  assert.ok(settings.args.includes(c.researchManifestFile));
  assert.equal(
    settings.dependency_lock.file,
    path.join(destination, 'app/package-lock.json'),
  );
  const research = await json(c.researchManifestFile);
  assert.equal(
    research.package_dir,
    path.join(destination, 'researcher/profile-subagent'),
  );
  assert.equal(
    research.dependency_lock.hash,
    sha(await readFile(research.dependency_lock.file)),
  );
  const verifyResearch = path.join(artifact, 'verify-research-config.mjs');
  await writeFile(
    verifyResearch,
    `import {TaskStore} from ${JSON.stringify(pathToFileURL(path.join(destination, 'app/dist/store.js')).href)};\nimport {TaskGithubResearch} from ${JSON.stringify(pathToFileURL(path.join(destination, 'app/dist/github-research.js')).href)};\nconst store = await TaskStore.acquire(${JSON.stringify(c.dataRoot)});\ntry { if(!await TaskGithubResearch.open(store, ${JSON.stringify(c.researchManifestFile)})) throw Error('missing researcher'); } finally {await store.close();}\n`,
    {mode: 0o600},
  );
  await command(
    'generated-research-config-opens',
    process.execPath,
    ['--import', guard, verifyResearch],
    {GH_TOKEN: 'fixture-token'},
  );
  assert.equal(
    (await json(boundFile)).manifest_hash,
    sha(await readFile(c.researchManifestFile)),
  );
  const plistFile = path.join(
      home,
      'Library/LaunchAgents/com.zsaplan.pi-task-assistant.plist',
    ),
    plist = await readFile(plistFile, 'utf8');
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(plist, /fixture-private/);
  assert.doesNotMatch(JSON.stringify(settings), /fixture-private/);
  // A wrong-directory plist must be refused before any launchctl attempt.
  await writeFile(
    plistFile,
    plist.replace(c.serviceDir, '/wrong-service-directory'),
  );
  await local(
    'wrong-service-start-rejected',
    ['start', '--config', configFile],
    1,
  );
  await writeFile(plistFile, plist);
  await assert.rejects(readFile(escaped), {code: 'ENOENT'});
  report.checks.push(
    'paused configure/status with existing synthetic approval history unchanged, generated research config opens, rebind/removal refused, exact paths/hashes, no network or launchctl, wrong service identity held',
  );
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save(path.join(artifact, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
}
