import process from 'node:process';
import console from 'node:console';
import {copyFile, mkdir, writeFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {
  args,
  requireThat,
  save,
  run,
  verifyRelease,
  verifyDependencies,
  dependencyLinks,
} from './release-lib.mjs';
process.umask(0o077);
const source = path.dirname(fileURLToPath(import.meta.url));
try {
  const opt = args(process.argv.slice(2), ['--prefix', '--npm-cli']);
  requireThat(
    opt['--prefix'] && opt['--npm-cli'],
    'prefix_and_npm_cli_required',
  );
  const manifest = await verifyRelease(source);
  const prefix = path.resolve(opt['--prefix']),
    npm = await realpath(opt['--npm-cli']);
  requireThat(
    !prefix.startsWith(source + path.sep) && prefix !== source,
    'separate_install_prefix_required',
  );
  const env = {
    HOME: os.homedir(),
    PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
  };
  requireThat(
    run(process.execPath, [npm, '--version'], env).trim() ===
      manifest.runtime.npm,
    'unqualified_npm_version',
  );
  await mkdir(prefix, {mode: 0o700}); // Exclusive: never update an existing release.
  requireThat(
    (await realpath(prefix)) === prefix,
    'install_prefix_must_be_canonical',
  );
  for (const name of [...Object.keys(manifest.files), 'release.json']) {
    await mkdir(path.dirname(path.join(prefix, name)), {
      recursive: true,
      mode: 0o700,
    });
    await copyFile(path.join(source, name), path.join(prefix, name));
  }
  const scratch = path.join(prefix, '.install');
  await mkdir(scratch, {mode: 0o700});
  await writeFile(path.join(scratch, 'user.npmrc'), '', {mode: 0o600});
  await writeFile(path.join(scratch, 'global.npmrc'), '', {mode: 0o600});
  for (const component of ['app', 'researcher']) {
    let log = '';
    try {
      run(
        process.execPath,
        [
          npm,
          'ci',
          '--prefix',
          path.join(prefix, component),
          '--omit=dev',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--workspaces=false',
          '--userconfig',
          path.join(scratch, 'user.npmrc'),
          '--globalconfig',
          path.join(scratch, 'global.npmrc'),
          '--registry=https://registry.npmjs.org',
        ],
        env,
        (out, err) => {
          log = out + err;
        },
      );
    } finally {
      await writeFile(path.join(scratch, component + '.log'), log, {
        mode: 0o600,
      });
    }
  }
  await verifyRelease(prefix, true);
  await dependencyLinks(prefix);
  const dependencies = await verifyDependencies(prefix);
  const cliVersions = {};
  for (const component of ['app', 'researcher']) {
    const cli = path.join(
      prefix,
      component,
      'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    );
    const version = run(process.execPath, [cli, '--version'], env).trim();
    requireThat(
      version === (component === 'app' ? '1.1.0' : '0.99.2'),
      'cli_version_mismatch',
    );
    cliVersions[component] = version;
  }
  const help = run(
    process.execPath,
    [path.join(prefix, 'app/dist/cli.js'), '--help'],
    env,
  );
  requireThat(help.includes('pi-task-assistant'), 'packaged_cli_unavailable');
  await save(path.join(prefix, 'installed.json'), {
    schemaVersion: 1,
    releaseId: manifest.id,
    installedAt: new Date().toISOString(),
    node: process.execPath,
    dependencies,
    cliVersions,
    started: false,
  });
  console.log(
    JSON.stringify({
      release: prefix,
      releaseId: manifest.id,
      dependencies,
      started: false,
      configuration:
        'Required; no private state, credentials, approval or LaunchAgent created.',
    }),
  );
} catch (error) {
  const code = /^[a-z0-9_]+$/.test(error?.message)
    ? error.message
    : 'install_failed';
  console.error(code);
  console.error(
    'Installation failed. No service was started. Keep any partial destination for inspection; do not overwrite or enable it. Check Node/npm versions, archive checksum and destination .install logs.',
  );
  process.exitCode = 1;
}
