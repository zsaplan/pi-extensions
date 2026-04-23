import type {DiscordSettings} from './config.ts';

const REQUEST_TIMEOUT_MS = 5_000;
const DISCORD_CONTENT_LIMIT = 2_000;
const TRUNCATION_SUFFIX = '…';

export {DISCORD_CONTENT_LIMIT, REQUEST_TIMEOUT_MS};

export type PostToDiscordOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function truncateDiscordContent(content: string): string {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;

  return (
    content.slice(0, DISCORD_CONTENT_LIMIT - TRUNCATION_SUFFIX.length) +
    TRUNCATION_SUFFIX
  );
}

export async function postToDiscord(
  settings: DiscordSettings,
  content: string,
  options: PostToDiscordOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  timeout.unref?.();

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(settings.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: truncateDiscordContent(content),
        username: settings.username,
        avatar_url: settings.avatarUrl,
        allowed_mentions: {parse: []},
      }),
      signal: controller.signal,
    });

    if (response.ok) return;

    const responseText = (await response.text()).trim();
    const suffix =
      responseText.length > 0 ? `: ${responseText.slice(0, 200)}` : '';
    throw new Error(
      `Discord webhook returned ${response.status} ${response.statusText}${suffix}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
