import process from 'node:process';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  lstat,
  readdir,
  readFile,
  mkdir,
  writeFile,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const save = async (file, value) => {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
};
export function requireThat(condition, code) {
  if (!condition) throw new Error(code);
}
export function args(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    requireThat(
      allowed.includes(argv[i]) &&
        !Object.hasOwn(result, argv[i]) &&
        argv[i + 1] &&
        !argv[i + 1].startsWith('--'),
      'invalid_arguments',
    );
    result[argv[i]] = argv[i + 1];
  }
  return result;
}
export function run(command, argv, env, log) {
  const r = spawnSync(command, argv, {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (log) log(r.stdout || '', r.stderr || '');
  requireThat(!r.error && r.status === 0, 'subprocess_failed');
  return r.stdout;
}
export async function inventory(root, prefix = '') {
  const result = {};
  for (const name of (await readdir(path.join(root, prefix))).sort()) {
    const relative = prefix ? prefix + '/' + name : name;
    const info = await lstat(path.join(root, relative));
    requireThat(!info.isSymbolicLink(), 'release_symlink');
    if (info.isDirectory())
      Object.assign(result, await inventory(root, relative));
    else {
      requireThat(info.isFile(), 'release_non_regular_file');
      result[relative] = sha(await readFile(path.join(root, relative)));
    }
  }
  return result;
}
export async function verifyFiles(root, files) {
  for (const [name, hash] of Object.entries(files)) {
    requireThat(
      /^[a-zA-Z0-9_./-]+$/.test(name) &&
        !path.isAbsolute(name) &&
        !name.split('/').some(p => p === '..' || p === '.' || !p),
      'invalid_inventory_path',
    );
    const target = path.join(root, name);
    requireThat(
      (await realpath(target)) === target && (await lstat(target)).isFile(),
      'release_path_escape',
    );
    requireThat(sha(await readFile(target)) === hash, 'release_hash_mismatch');
  }
}
export function runtime(manifest) {
  requireThat(
    process.platform === 'darwin' && process.arch === 'arm64',
    'requires_native_arm64_macos',
  );
  requireThat(
    process.versions.node === manifest.runtime.node,
    'unqualified_node_version',
  );
}
export async function verifyRelease(root, installed = false) {
  const manifest = await json(path.join(root, 'release.json'));
  requireThat(
    manifest.schemaVersion === 1 && manifest.files && manifest.source?.commit,
    'invalid_release',
  );
  runtime(manifest);
  await verifyFiles(root, manifest.files);
  if (!installed) {
    const actual = await inventory(root);
    delete actual['release.json'];
    requireThat(
      Object.keys(actual).length === Object.keys(manifest.files).length &&
        Object.entries(actual).every(([k, v]) => manifest.files[k] === v),
      'unexpected_release_files',
    );
  }
  return manifest;
}
export async function verifyDependencies(root) {
  const parent = await import(
    pathToFileURL(
      path.join(
        root,
        'app/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      ),
    ).href
  );
  const child = await import(
    pathToFileURL(
      path.join(
        root,
        'researcher/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      ),
    ).href
  );
  requireThat(
    parent.VERSION === '1.1.0' && child.VERSION === '0.99.2',
    'sdk_version_mismatch',
  );
  const profile = await import(
    pathToFileURL(
      path.join(root, 'researcher/profile-subagent/dist/profiles.js'),
    ).href
  );
  const loaded = await profile.loadProfile('github-researcher', false, true);
  const expected = await json(path.join(root, 'research-source.json'));
  requireThat(
    loaded.digest === expected.profileDigest,
    'research_profile_mismatch',
  );
  await verifyFiles(
    path.join(root, 'researcher/profile-subagent'),
    expected.files,
  );
  return {
    parentSdk: parent.VERSION,
    researcherSdk: child.VERSION,
    profileDigest: loaded.digest,
  };
}
export async function privateFile(file) {
  const info = await lstat(file);
  requireThat(
    info.isFile() && !(info.mode & 0o077) && info.uid === process.getuid(),
    'private_file_required',
  );
}
export async function dependencyLinks(root) {
  async function visit(dir) {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name),
        info = await lstat(file);
      if (info.isSymbolicLink())
        requireThat(
          (await realpath(file)).startsWith(root + path.sep),
          'external_dependency_symlink',
        );
      else if (info.isDirectory()) await visit(file);
    }
  }
  await visit(root);
}
