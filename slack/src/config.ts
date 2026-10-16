export const READ_TOKEN_ENV_VAR = 'SLACK_USER_TOKEN';
export const WRITE_TOKEN_ENV_VAR = 'SLACK_BOT_TOKEN';
export const PRIMARY_TOKEN_ENV_VAR = READ_TOKEN_ENV_VAR;
export const API_BASE_URL_ENV_VAR = 'PI_SLACK_API_BASE_URL';
export const SKIP_SEND_CONFIRM_ENV_VAR = 'PI_SLACK_SKIP_SEND_CONFIRM';
export const ALLOW_NONINTERACTIVE_WRITES_ENV_VAR =
  'PI_SLACK_ALLOW_NONINTERACTIVE_WRITES';

const DEFAULT_API_BASE_URL = 'https://slack.com/api';

export function readSlackUploadLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PI_SLACK_MAX_UPLOAD_BYTES;
  const value = raw === undefined ? 20 * 1024 * 1024 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100 * 1024 * 1024) {
    throw new Error(
      'PI_SLACK_MAX_UPLOAD_BYTES must be an integer from 1 to 104857600.',
    );
  }
  return value;
}

export interface SlackConfig {
  token: string;
  tokenSource: string;
  apiBaseUrl: string;
  skipSendConfirm: boolean;
  allowNonInteractiveWrites: boolean;
}

export interface SlackConfigStatus {
  settings?: SlackConfig;
  problem?: string;
  tokenEnvVars: string[];
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function readSlackTokenConfig(
  env: NodeJS.ProcessEnv,
  tokenEnvVar: string,
  tokenKind: 'user' | 'bot',
): SlackConfigStatus {
  const candidates = [tokenEnvVar];
  const tokenSource = candidates.find(name => Boolean(env[name]?.trim()));

  if (!tokenSource) {
    return {
      tokenEnvVars: candidates,
      problem: `Set ${tokenEnvVar} to a Slack ${tokenKind} token.`,
    };
  }

  return {
    tokenEnvVars: candidates,
    settings: {
      token: env[tokenSource]!.trim(),
      tokenSource,
      apiBaseUrl: normalizeBaseUrl(env[API_BASE_URL_ENV_VAR]),
      skipSendConfirm: parseBoolean(env[SKIP_SEND_CONFIRM_ENV_VAR]),
      allowNonInteractiveWrites: parseBoolean(
        env[ALLOW_NONINTERACTIVE_WRITES_ENV_VAR],
      ),
    },
  };
}

export function readSlackConfig(
  env: NodeJS.ProcessEnv = process.env,
): SlackConfigStatus {
  return readSlackTokenConfig(env, READ_TOKEN_ENV_VAR, 'user');
}

export function readSlackWriteConfig(
  env: NodeJS.ProcessEnv = process.env,
): SlackConfigStatus {
  return readSlackTokenConfig(env, WRITE_TOKEN_ENV_VAR, 'bot');
}

function formatSlackConfigStatusMessage(
  status: SlackConfigStatus,
  tokenKind: 'user' | 'bot',
): string {
  if (!status.settings) {
    return status.problem ?? `Slack ${tokenKind} token is not set.`;
  }

  const sendMode = status.settings.skipSendConfirm
    ? 'send confirmation disabled'
    : 'send confirmation enabled';
  const nonInteractiveMode = status.settings.allowNonInteractiveWrites
    ? 'non-interactive writes allowed'
    : 'non-interactive writes blocked';

  return [
    `Slack ${tokenKind} token loaded from ${status.settings.tokenSource}.`,
    `API: ${status.settings.apiBaseUrl}.`,
    `${sendMode}; ${nonInteractiveMode}.`,
  ].join(' ');
}

export function getSlackConfigStatusMessage(status: SlackConfigStatus): string {
  return formatSlackConfigStatusMessage(status, 'user');
}

export function getSlackWriteConfigStatusMessage(
  status: SlackConfigStatus,
): string {
  return formatSlackConfigStatusMessage(status, 'bot');
}
