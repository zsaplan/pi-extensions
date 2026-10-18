import process from 'node:process';
import console from 'node:console';
import {readFile, lstat, mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {
  args,
  json,
  privateFile,
  requireThat,
  run,
  save,
  sha,
  verifyDependencies,
  verifyRelease,
} from './release-lib.mjs';

process.umask(0o077);
const release = path.dirname(fileURLToPath(import.meta.url));
const cleanEnv = () => ({
  HOME: os.homedir(),
  PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
});
const pathKeys = [
  'releaseDir',
  'dataRoot',
  'sessionLibrary',
  'parentAgentDir',
  'researcherAgentDir',
  'serviceDir',
  'credentialsFile',
  'approvalFile',
  'researchManifestFile',
];
async function configuration(file) {
  await privateFile(file);
  const c = await json(file);
  requireThat(
    c.schemaVersion === 1 &&
      c.releaseDir === release &&
      typeof c.researcher === 'boolean' &&
      /^[CDG][A-Z0-9]+$/.test(c.conversation),
    'invalid_configuration',
  );
  requireThat(
    Object.keys(c).every(k =>
      [
        'schemaVersion',
        'researcher',
        'conversation',
        'backlogApprovalFile',
        ...pathKeys,
      ].includes(k),
    ),
    'unknown_configuration_key',
  );
  requireThat(
    c.backlogApprovalFile === null ||
      (typeof c.backlogApprovalFile === 'string' &&
        c.backlogApprovalFile.length > 0),
    'invalid_backlog_path',
  );
  for (const k of [
    ...pathKeys,
    ...(c.backlogApprovalFile ? ['backlogApprovalFile'] : []),
  ]) {
    requireThat(
      typeof c[k] === 'string' &&
        path.isAbsolute(c[k]) &&
        path.resolve(c[k]) === c[k],
      'absolute_configuration_path_required',
    );
    if (k !== 'releaseDir')
      requireThat(
        c[k] !== release && !c[k].startsWith(release + path.sep),
        'state_must_be_outside_release',
      );
  }
  const independent = [
    'dataRoot',
    'sessionLibrary',
    'parentAgentDir',
    'researcherAgentDir',
    'serviceDir',
  ];
  for (const a of independent)
    for (const b of independent)
      if (a !== b)
        requireThat(
          c[a] !== c[b] && !c[a].startsWith(c[b] + path.sep),
          'separate_state_directories_required',
        );
  return c;
}
async function prerequisites(c) {
  const missing = [];
  for (const key of [
    'dataRoot',
    'sessionLibrary',
    'parentAgentDir',
    ...(c.researcher ? ['researcherAgentDir'] : []),
  ]) {
    try {
      const s = await lstat(c[key]);
      requireThat(
        s.isDirectory() && !(s.mode & 0o077) && s.uid === process.getuid(),
        'private_directory_required',
      );
    } catch {
      missing.push(key);
    }
  }
  for (const [name, file] of [
    ['credentials', c.credentialsFile],
    ['approval', c.approvalFile],
    ['parent login', path.join(c.parentAgentDir, 'auth.json')],
    ...(c.backlogApprovalFile
      ? [['backlog approval', c.backlogApprovalFile]]
      : []),
    ...(c.researcher
      ? [['researcher login', path.join(c.researcherAgentDir, 'auth.json')]]
      : []),
  ]) {
    try {
      await privateFile(file);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}
async function credentials(c) {
  await privateFile(c.credentialsFile);
  const secrets = await json(c.credentialsFile);
  requireThat(
    typeof secrets.SLACK_USER_TOKEN === 'string' &&
      secrets.SLACK_USER_TOKEN.trim() &&
      typeof secrets.SLACK_BOT_TOKEN === 'string' &&
      secrets.SLACK_BOT_TOKEN.trim(),
    'slack_credentials_required',
  );
  if (c.researcher)
    requireThat(
      typeof secrets.GH_TOKEN === 'string' && secrets.GH_TOKEN.trim(),
      'github_credentials_required',
    );
  return {
    ...cleanEnv(),
    SLACK_USER_TOKEN: secrets.SLACK_USER_TOKEN,
    SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN,
    ...(c.researcher ? {GH_TOKEN: secrets.GH_TOKEN} : {}),
  };
}
try {
  const command = process.argv[2],
    opt = args(process.argv.slice(3), ['--config', '--file', '--private-base']);
  const manifest = await verifyRelease(release, true);
  const dependencies = await verifyDependencies(release);
  if (command === 'init-config') {
    requireThat(
      opt['--file'] && opt['--private-base'] && !opt['--config'],
      'file_and_private_base_required',
    );
    const base = path.resolve(opt['--private-base']);
    requireThat(
      base !== release && !base.startsWith(release + path.sep),
      'state_must_be_outside_release',
    );
    const example = await json(path.join(release, 'example-config.json'));
    for (const key of pathKeys)
      example[key] =
        key === 'releaseDir' ? release : path.join(base, example[key]);
    await save(path.resolve(opt['--file']), example);
    console.log(
      JSON.stringify({
        config: path.resolve(opt['--file']),
        started: false,
        credentialsCreated: false,
        approvalCreated: false,
      }),
    );
  } else {
    requireThat(
      opt['--config'] && !opt['--file'] && !opt['--private-base'],
      'config_required',
    );
    const c = await configuration(path.resolve(opt['--config']));
    if (command === 'check') {
      console.log(
        JSON.stringify({
          releaseVerified: true,
          releaseId: manifest.id,
          dependencies,
          missingPrerequisites: await prerequisites(c),
          networkChecked: false,
          authenticationChecked: false,
          approvalValidated: false,
          started: false,
          integrations: {
            github: c.researcher
              ? 'configured; access not verified'
              : 'disabled',
            jiraZendesk: 'link display only; no researcher',
            grafana: 'not enabled by this service package',
          },
        }),
      );
    } else if (command === 'configure') {
      requireThat(
        (await prerequisites(c)).length === 0,
        'missing_private_prerequisites',
      );
      const env = await credentials(c),
        approval = await json(c.approvalFile);
      requireThat(
        approval.scope?.root === c.dataRoot &&
          approval.scope?.session_library === c.sessionLibrary &&
          approval.scope?.conversation === c.conversation,
        'approval_path_or_conversation_mismatch',
      );
      let boundResearch;
      try {
        boundResearch = await json(
          path.join(c.dataRoot, 'intake/github-research.json'),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      requireThat(
        !boundResearch || c.researcher,
        'existing_research_binding_required',
      );
      if (c.researcher) {
        const frozen = await json(path.join(release, 'research-source.json'));
        const research = {
          schema_version: 1,
          root: c.dataRoot,
          package_dir: path.join(release, 'researcher/profile-subagent'),
          profile_digest: frozen.profileDigest,
          files: frozen.files,
          dependency_lock: {
            file: path.join(release, 'researcher/package-lock.json'),
            hash: sha(
              await readFile(
                path.join(release, 'researcher/package-lock.json'),
              ),
            ),
          },
          auth_path: path.join(c.researcherAgentDir, 'auth.json'),
        };
        // Never rewrite an existing binding or historical admission to fit a new release.
        let raw = JSON.stringify(research, null, 2) + '\n',
          exists = false;
        try {
          raw = await readFile(c.researchManifestFile, 'utf8');
          exists = true;
          await privateFile(c.researchManifestFile);
          requireThat(
            JSON.stringify(JSON.parse(raw)) === JSON.stringify(research),
            'existing_research_manifest_mismatch',
          );
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        requireThat(
          !boundResearch || boundResearch.manifest_hash === sha(raw),
          'existing_research_binding_requires_migration',
        );
        if (!exists) await save(c.researchManifestFile, research);
      }
      await mkdir(path.dirname(c.serviceDir), {recursive: true, mode: 0o700});
      const output = run(
        process.execPath,
        [
          path.join(release, 'app/dist/cli.js'),
          'service',
          'install',
          '--directory',
          c.serviceDir,
          '--approval',
          c.approvalFile,
          '--agent-dir',
          c.parentAgentDir,
          '--dependency-lock',
          path.join(release, 'app/package-lock.json'),
          ...(c.backlogApprovalFile
            ? ['--backlog-approval', c.backlogApprovalFile]
            : []),
          ...(c.researcher
            ? ['--github-research-config', c.researchManifestFile]
            : []),
        ],
        env,
      );
      process.stdout.write(output);
    } else if (command === 'preflight') {
      process.stdout.write(
        run(
          process.execPath,
          [
            path.join(release, 'app/dist/cli.js'),
            'preflight',
            '--search-api',
            'legacy',
            '--conversation',
            c.conversation,
          ],
          await credentials(c),
        ),
      );
    } else if (['start', 'stop', 'status'].includes(command)) {
      process.stdout.write(
        run(
          process.execPath,
          [
            path.join(release, 'app/dist/cli.js'),
            'service',
            command,
            '--directory',
            c.serviceDir,
          ],
          cleanEnv(),
        ),
      );
    } else throw new Error('unknown_command');
  }
} catch (error) {
  console.error(
    /^[a-z0-9_]+$/.test(error?.message) ? error.message : 'command_failed',
  );
  console.error(
    'Command failed. Check private configuration, required local logins/credentials, exact approval/research bindings and installed service state. No automatic retry. Inspect any partial configuration before proceeding.',
  );
  process.exitCode = 1;
}
