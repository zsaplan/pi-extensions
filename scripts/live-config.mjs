import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function readLiveConfig(personal, env) {
  const settings = await readOptionalJson(path.join(personal, 'settings.json'));
  const provider = env.PI_LIVE_PROVIDER ?? settings.defaultProvider;
  const model = env.PI_LIVE_MODEL ?? settings.defaultModel;
  if (!provider || !model) {
    throw new Error(
      'Set PI_LIVE_PROVIDER and PI_LIVE_MODEL or configure Pi defaults',
    );
  }
  return {provider, model};
}

export async function prepareLiveCredentials({
  pi,
  personal,
  agent,
  provider,
  env,
}) {
  const auth = await readOptionalJson(path.join(personal, 'auth.json'));
  const credential = auth[provider];
  if (credential?.type !== 'oauth') {
    if (credential) {
      await writeFile(
        path.join(agent, 'auth.json'),
        JSON.stringify({[provider]: credential}),
        {mode: 0o600},
      );
    }
    return Infinity;
  }

  if (provider !== 'openai-codex') {
    throw new Error(
      'Live OAuth tests currently support openai-codex only; use an API-key provider otherwise.',
    );
  }

  // Refresh under Pi's original-store lock; never duplicate a refresh token.
  const deadline = Date.now() + 20 * 60 * 1000;
  let access;
  try {
    access = execFileSync(
      pi,
      [
        'auth',
        'print-bearer-token',
        '--provider',
        provider,
        '--min-expiry',
        '20m',
      ],
      {
        env: {
          ...env,
          PI_CODING_AGENT_DIR: personal,
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
        killSignal: 'SIGKILL',
      },
    ).trim();
    if (!access || /\s/.test(access))
      throw new Error('Invalid credential output');
  } catch {
    // Child-process errors can embed credential stdout/stderr.
    throw new Error(
      'Unable to export an OAuth access token valid for 20 minutes; check provider authentication with pi auth check.',
    );
  }
  await writeFile(
    path.join(agent, 'models.json'),
    JSON.stringify({providers: {[provider]: {apiKey: access}}}),
    {mode: 0o600},
  );
  return deadline;
}
