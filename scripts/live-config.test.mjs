import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {prepareLiveCredentials, readLiveConfig} from './live-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pi = path.join(root, 'node_modules/.bin/pi');
const token = `fixture.${Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: 'fixture'}})).toString('base64url')}.signature`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-auth-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const personal = path.join(dir, 'original');
  const agent = path.join(dir, 'isolated');
  await mkdir(personal);
  await mkdir(agent);
  const preload = path.join(dir, 'fetch.mjs');
  const record = path.join(dir, 'requests.jsonl');
  await writeFile(
    preload,
    `
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
await import(${JSON.stringify(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js')).href)});
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://auth.openai.com/oauth/token');
  assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'original-refresh');
  appendFileSync(process.env.FIXTURE_RECORD, 'refresh\\n');
  return new Response(JSON.stringify({access_token: process.env.FIXTURE_ACCESS, refresh_token: 'rotated-refresh', expires_in: Number(process.env.FIXTURE_EXPIRY)}), {status: 200, headers: {'content-type': 'application/json'}});
};
`,
  );
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: personal,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    FIXTURE_RECORD: record,
    FIXTURE_ACCESS: token,
    FIXTURE_EXPIRY: '3600',
  };
  return {personal, agent, env, record};
}

async function seedOAuth(personal) {
  await writeFile(
    path.join(personal, 'auth.json'),
    JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access: token,
        refresh: 'original-refresh',
        expires: Date.now() + 60000,
        accountId: 'fixture',
      },
    }),
    {mode: 0o600},
  );
}

test('environment-only configuration and API-key authentication need no settings file', async t => {
  const f = await fixture(t);
  const env = {
    ...f.env,
    PI_LIVE_PROVIDER: 'openai',
    PI_LIVE_MODEL: 'gpt-6-astra',
    OPENAI_API_KEY: 'fixture-api-key',
  };
  assert.deepEqual(await readLiveConfig(f.personal, env), {
    provider: 'openai',
    model: 'gpt-6-astra',
  });
  assert.equal(
    await prepareLiveCredentials({...f, pi, provider: 'openai', env}),
    Infinity,
  );
  assert.deepEqual(await readdir(f.agent), []);
  const result = JSON.parse(
    execFileSync(pi, ['auth', 'check', '--provider', 'openai', '--json'], {
      env: {...env, PI_CODING_AGENT_DIR: f.agent},
      encoding: 'utf8',
      timeout: 20000,
    }),
  );
  assert.equal(result.status, 'ready');
});

test('missing defaults and malformed settings fail instead of being ignored', async t => {
  const f = await fixture(t);
  await assert.rejects(readLiveConfig(f.personal, {}), /Set PI_LIVE_PROVIDER/);
  await writeFile(path.join(f.personal, 'settings.json'), '{invalid');
  await assert.rejects(
    readLiveConfig(f.personal, {
      PI_LIVE_PROVIDER: 'openai',
      PI_LIVE_MODEL: 'gpt-6-astra',
    }),
    SyntaxError,
  );
});

test('real Pi CLI refreshes the original OAuth store and exports access only', async t => {
  const f = await fixture(t);
  await seedOAuth(f.personal);
  const deadline = await prepareLiveCredentials({
    ...f,
    pi,
    provider: 'openai-codex',
  });
  assert.ok(deadline > Date.now() + 19 * 60 * 1000);
  const original = JSON.parse(
    await readFile(path.join(f.personal, 'auth.json'), 'utf8'),
  );
  assert.equal(original['openai-codex'].refresh, 'rotated-refresh');
  assert.equal(await readFile(f.record, 'utf8'), 'refresh\n');
  assert.deepEqual(await readdir(f.agent), ['models.json']);
  const config = JSON.parse(
    await readFile(path.join(f.agent, 'models.json'), 'utf8'),
  );
  assert.deepEqual(config, {providers: {'openai-codex': {apiKey: token}}});
  assert.equal(
    (await stat(path.join(f.agent, 'models.json'))).mode & 0o777,
    0o600,
  );
  const result = JSON.parse(
    execFileSync(
      pi,
      ['auth', 'check', '--provider', 'openai-codex', '--json'],
      {
        env: {...f.env, PI_CODING_AGENT_DIR: f.agent},
        encoding: 'utf8',
        timeout: 20000,
      },
    ),
  );
  assert.equal(result.status, 'ready');
  assert.equal(await readFile(f.record, 'utf8'), 'refresh\n');
});

test('a refreshed token that is still too short-lived fails closed', async t => {
  const f = await fixture(t);
  await seedOAuth(f.personal);
  await assert.rejects(
    prepareLiveCredentials({
      ...f,
      pi,
      provider: 'openai-codex',
      env: {...f.env, FIXTURE_EXPIRY: '60'},
    }),
    /Unable to export an OAuth access token valid for 20 minutes/,
  );
  assert.deepEqual(await readdir(f.agent), []);
  const original = JSON.parse(
    await readFile(path.join(f.personal, 'auth.json'), 'utf8'),
  );
  assert.equal(original['openai-codex'].refresh, 'rotated-refresh');
});

test('export failure does not disclose credential stdout or stderr', async t => {
  const f = await fixture(t);
  await seedOAuth(f.personal);
  const fakePi = path.join(f.agent, 'pi');
  await writeFile(
    fakePi,
    '#!/bin/sh\nprintf SECRET_ACCESS\nprintf SECRET_REFRESH >&2\nexit 1\n',
    {mode: 0o700},
  );
  await assert.rejects(
    prepareLiveCredentials({...f, pi: fakePi, provider: 'openai-codex'}),
    error => {
      assert.match(error.message, /Unable to export/);
      assert.doesNotMatch(String(error), /SECRET/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
