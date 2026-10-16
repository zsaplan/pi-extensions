export const BASE_URL_ENV_VAR = 'JIRA_BASE_URL';
export const USERNAME_ENV_VAR = 'JIRA_USERNAME';
export const ACCOUNT_ID_ENV_VAR = 'JIRA_ACCOUNT_ID';
export const API_TOKEN_ENV_VAR = 'JIRA_API_TOKEN';

export interface JiraConfig {
  baseUrl: string;
  username: string;
  accountId?: string;
  apiToken: string;
}

export interface JiraConfigStatus {
  settings?: JiraConfig;
  problem?: string;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${BASE_URL_ENV_VAR} must be a valid URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${BASE_URL_ENV_VAR} must use HTTPS.`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function readJiraConfig(
  env: NodeJS.ProcessEnv = process.env,
): JiraConfigStatus {
  const missing = [
    BASE_URL_ENV_VAR,
    USERNAME_ENV_VAR,
    API_TOKEN_ENV_VAR,
  ].filter(name => !env[name]?.trim());
  if (missing.length) {
    return {
      problem: `Set required Jira environment variable(s): ${missing.join(', ')}.`,
    };
  }

  try {
    return {
      settings: {
        accountId: env[ACCOUNT_ID_ENV_VAR]?.trim() || undefined,
        apiToken: env[API_TOKEN_ENV_VAR]!.trim(),
        baseUrl: normalizeBaseUrl(env[BASE_URL_ENV_VAR]!),
        username: env[USERNAME_ENV_VAR]!.trim(),
      },
    };
  } catch (error) {
    return {problem: error instanceof Error ? error.message : String(error)};
  }
}

export function getJiraConfigStatusMessage(status: JiraConfigStatus): string {
  if (!status.settings) return status.problem ?? 'Jira is not configured.';
  return [
    `Jira credentials loaded for ${status.settings.username}.`,
    `API: ${status.settings.baseUrl}.`,
    status.settings.accountId
      ? `Account ID: ${status.settings.accountId}.`
      : `${ACCOUNT_ID_ENV_VAR} is not set.`,
  ].join(' ');
}
