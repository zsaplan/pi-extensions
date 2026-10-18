import {absent, readJson, updateJson} from './store.ts';

export type SlackMethod =
  | 'auth.test'
  | 'users.info'
  | 'usergroups.list'
  | 'search.messages'
  | 'assistant.search.context'
  | 'conversations.info'
  | 'conversations.history'
  | 'conversations.replies';

const METHODS = new Set<SlackMethod>([
  'auth.test',
  'users.info',
  'usergroups.list',
  'search.messages',
  'assistant.search.context',
  'conversations.info',
  'conversations.history',
  'conversations.replies',
]);

export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SlackError('invalid_response');
  }
  return value as JsonObject;
}

export function objects(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new SlackError('invalid_response');
  return value.map(object);
}

function scopeList(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map(scope => scope.trim())
        .filter(scope => /^[a-z_:*.-]+$/.test(scope))
    : [];
}

export class SlackError extends Error {
  code: string;
  retryAfterSeconds?: number;
  requiredScopes: string[];
  constructor(
    code: string,
    options: {retryAfterSeconds?: number; requiredScopes?: unknown} = {},
  ) {
    super(code);
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.requiredScopes = scopeList(options.requiredScopes);
  }
}

// Only read availability failures are recoverable. Auth/scope/identity errors,
// malformed responses and all uncertain writes retain their fail-stop behavior.
export const transientSlackRead = (code: string) =>
  ['transport_error', 'service_unavailable', 'rate_limited'].includes(code);

/** Merge concurrent intake/tool rate limits without dropping another method's deadline. */
export async function extendCooldown(
  file: string,
  method: string,
  seconds: number,
): Promise<void> {
  await updateJson(file, current => {
    const latest = (current ?? {}) as Record<string, number>;
    return {
      ...latest,
      [method]: Math.max(latest[method] ?? 0, Date.now() + seconds * 1000),
    };
  });
}

export class ReadonlySlackClient {
  #tokens: {user: string; bot: string};
  constructor(
    tokens: {user: string; bot: string},
    private rateLimitFile?: string,
  ) {
    this.#tokens = tokens;
  }

  async call(
    identity: 'user' | 'bot',
    method: SlackMethod,
    params: Record<string, string> = {},
    signal?: AbortSignal,
    maxBytes?: number,
  ): Promise<JsonObject> {
    if (!METHODS.has(method)) throw new SlackError('method_not_allowed');
    let cooldowns: Record<string, number> = {};
    if (this.rateLimitFile) {
      try {
        cooldowns = (await readJson(this.rateLimitFile)) as Record<
          string,
          number
        >;
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if ((cooldowns[method] ?? 0) > Date.now())
        throw new SlackError('rate_limited', {
          retryAfterSeconds: Math.ceil((cooldowns[method] - Date.now()) / 1000),
        });
    }
    let response: Response;
    try {
      response = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#tokens[identity]}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params),
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SlackError(signal?.aborted ? 'cancelled' : 'transport_error');
    }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After');
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 60;
      const delay = Number.isSafeInteger(seconds) ? Math.max(1, seconds) : 60;
      if (this.rateLimitFile) {
        await extendCooldown(this.rateLimitFile, method, delay);
      }
      throw new SlackError('rate_limited', {retryAfterSeconds: delay});
    }
    if (!response.ok) {
      throw new SlackError(
        response.status >= 500 ? 'service_unavailable' : 'http_error',
      );
    }
    let data: JsonObject;
    try {
      if (maxBytes !== undefined) {
        const reader = response.body?.getReader();
        if (!reader) throw new SlackError('invalid_response');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              throw new SlackError('response_too_large');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        data = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } else data = object(await response.json());
    } catch (error) {
      if (error instanceof SlackError) throw error;
      throw new SlackError(
        signal?.aborted
          ? 'cancelled'
          : error instanceof Error && error.name === 'TimeoutError'
            ? 'transport_error'
            : 'invalid_response',
      );
    }
    if (data.ok !== true) {
      const code =
        typeof data.error === 'string' && /^[a-z_]{1,80}$/.test(data.error)
          ? data.error
          : 'slack_error';
      throw new SlackError(code, {requiredScopes: data.needed});
    }
    return data;
  }
}
