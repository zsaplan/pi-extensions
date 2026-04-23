const PRIMARY_WEBHOOK_ENV_VAR = 'PI_DISCORD_NOTIFY_WEBHOOK_URL';
const FALLBACK_WEBHOOK_ENV_VAR = 'PI_DISCORD_WEBHOOK_URL';
const ENABLED_ENV_VAR = 'PI_DISCORD_NOTIFY_ENABLED';
const EVENT_ENV_VAR = 'PI_DISCORD_NOTIFY_EVENT';
const USERNAME_ENV_VAR = 'PI_DISCORD_NOTIFY_USERNAME';
const AVATAR_URL_ENV_VAR = 'PI_DISCORD_NOTIFY_AVATAR_URL';
const DEFAULT_USERNAME = 'pi';

export {
  AVATAR_URL_ENV_VAR,
  DEFAULT_USERNAME,
  ENABLED_ENV_VAR,
  EVENT_ENV_VAR,
  FALLBACK_WEBHOOK_ENV_VAR,
  PRIMARY_WEBHOOK_ENV_VAR,
  USERNAME_ENV_VAR,
};

export type NotifyEventName = 'agent_end' | 'turn_end';

export type DiscordSettings = {
  webhookUrl: string;
  username: string;
  avatarUrl?: string;
  event: NotifyEventName;
};

export type DiscordConfig = {
  enabled: boolean;
  settings: DiscordSettings | null;
  problem?: string;
};

function readEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function parseBooleanValue(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return defaultValue;

  switch (trimmed.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return defaultValue;
  }
}

export function parseBooleanEnv(
  name: string,
  defaultValue: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBooleanValue(readEnv(name, env), defaultValue);
}

export function parseNotifyEvent(value: string | undefined): NotifyEventName {
  return value?.trim() === 'turn_end' ? 'turn_end' : 'agent_end';
}

function getWebhookUrl(env: NodeJS.ProcessEnv): string | undefined {
  return (
    readEnv(PRIMARY_WEBHOOK_ENV_VAR, env) ??
    readEnv(FALLBACK_WEBHOOK_ENV_VAR, env)
  );
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscordConfig {
  const enabled = parseBooleanEnv(ENABLED_ENV_VAR, true, env);
  const webhookUrl = getWebhookUrl(env);

  if (!webhookUrl) {
    return {
      enabled,
      settings: null,
      problem: `Set ${PRIMARY_WEBHOOK_ENV_VAR} to enable Discord notifications.`,
    };
  }

  try {
    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== 'https:') {
      return {
        enabled,
        settings: null,
        problem: `${PRIMARY_WEBHOOK_ENV_VAR} must use https.`,
      };
    }

    const avatarUrl = readEnv(AVATAR_URL_ENV_VAR, env);

    return {
      enabled,
      settings: {
        webhookUrl: parsed.toString(),
        username: readEnv(USERNAME_ENV_VAR, env) ?? DEFAULT_USERNAME,
        ...(avatarUrl ? {avatarUrl} : {}),
        event: parseNotifyEvent(readEnv(EVENT_ENV_VAR, env)),
      },
    };
  } catch {
    return {
      enabled,
      settings: null,
      problem: `${PRIMARY_WEBHOOK_ENV_VAR} is not a valid URL.`,
    };
  }
}
