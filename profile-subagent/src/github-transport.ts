import {randomUUID} from 'node:crypto';
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Model} from '@earendil-works/pi-ai';
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';

export const researchDefaults = {
  provider: 'openai-codex',
  model: 'gpt-6-luna',
  thinkingLevel: 'high',
} as const;
let occupied = false;

// Single supervised worker only. Unowned sockets pass through untouched.
// Resolve cleanup from the SDK owning this child, not another installed pi-ai.
export async function installResearchTransport(
  runtime: ModelRuntime,
  deadlineAt: number,
  artifactDir: string,
) {
  if (occupied) throw new Error('Standard research transport already active.');
  const sdkRequire = createRequire(
    import.meta.resolve('@earendil-works/pi-coding-agent'),
  );
  const owner = sdkRequire.resolve
    .paths('@earendil-works/pi-ai')
    ?.map(p => join(p, '@earendil-works/pi-ai'))
    .find(p => existsSync(join(p, 'package.json')));
  if (
    !owner ||
    JSON.parse(readFileSync(join(owner, 'package.json'), 'utf8')).version !==
      '0.99.2'
  )
    throw new Error(
      'Research native transport version requires requalification.',
    );
  const native = (await import(
    pathToFileURL(join(owner, 'dist/api/openai-codex-responses.js')).href
  )) as {
    closeOpenAICodexWebSocketSessions(id: string): void;
  };
  if (occupied) throw new Error('Standard research transport already active.');
  const Native = globalThis.WebSocket;
  if (!Native) throw new Error('Native WebSocket unavailable.');
  occupied = true;
  const id = `gh-${randomUUID()}`;
  const sockets = new Set<WebSocket>();
  const waiters = new Set<() => void>();
  const sent = new Set<number>(),
    connected = new Set<number>();
  let requests = 0,
    terminals = 0,
    knownCost = 0,
    failure: string | undefined;
  let input = 0,
    output = 0,
    cached = 0,
    cleanupComplete = false;
  const record = (kind: string, value: unknown) =>
    appendFileSync(
      join(artifactDir, 'research-wire.jsonl'),
      JSON.stringify({at: new Date().toISOString(), kind, value}) + '\n',
      {mode: 0o600},
    );
  const fail = (message: string): never => {
    failure ??= message;
    throw new Error(message);
  };
  const Guard = new Proxy(Native, {
    construct(target, args) {
      const headers = new Headers(
        (args[1] as {headers?: Record<string, string>} | undefined)?.headers,
      );
      if (headers.get('session-id') !== id)
        return Reflect.construct(target, args);
      if (
        String(args[0]) !== 'wss://chatgpt.com/backend-api/codex/responses' ||
        headers.get('x-codex-routing-hint') !==
          'model=gpt-6-luna;tier=default' ||
        !requests ||
        connected.has(requests)
      )
        fail('Research socket destination/retry refused.');
      connected.add(requests);
      const socket = Reflect.construct(target, args) as WebSocket;
      sockets.add(socket);
      record('connection', {request: requests});
      const send = socket.send.bind(socket);
      socket.send = data => {
        if (typeof data !== 'string') return fail('Unexpected research frame.');
        const frame = JSON.parse(data) as {
          type?: string;
          model?: string;
          reasoning?: {effort?: string};
          service_tier?: string;
          previous_response_id?: unknown;
        };
        if (
          sent.has(requests) ||
          frame.type !== 'response.create' ||
          frame.model !== 'gpt-6-luna' ||
          frame.reasoning?.effort !== 'high' ||
          frame.service_tier !== 'default' ||
          frame.previous_response_id !== undefined
        )
          fail('Research frame/retry refused.');
        sent.add(requests);
        record('send', {
          request: requests,
          model: frame.model,
          effort: 'high',
          tier: 'default',
        });
        send(data);
      };
      socket.addEventListener(
        'close',
        event => {
          sockets.delete(socket);
          if (event.code !== 1000)
            failure ??= 'Research socket closed abnormally.';
          try {
            record('close', {code: event.code});
          } catch {
            failure ??= 'Research close evidence persistence failed.';
          }
          for (const wake of waiters) wake();
        },
        {once: true},
      );
      return socket;
    },
  });
  globalThis.WebSocket = Guard;
  runtime.streamSimple = (model, context, options) => {
    if (
      failure ||
      model.provider !== researchDefaults.provider ||
      model.id !== researchDefaults.model ||
      model.api !== 'openai-codex-responses' ||
      model.baseUrl !== 'https://chatgpt.com/backend-api' ||
      options?.reasoning !== 'high' ||
      requests !== terminals ||
      knownCost >= 0.25 ||
      ++requests > 10 ||
      Date.now() >= deadlineAt
    )
      return fail('Research model/accounting/deadline/cost admission refused.');
    const headers = {
      ...options.headers,
      'x-codex-routing-hint': 'model=gpt-6-luna;tier=default',
    };
    record('request', {
      request: requests,
      model: model.id,
      effort: 'high',
      tier: 'default',
    });
    return runtime.stream(model as Model<'openai-codex-responses'>, context, {
      ...options,
      headers,
      sessionId: id,
      cacheRetention: 'short',
      transport: 'websocket',
      serviceTier: 'default',
      reasoningEffort: 'high',
      maxRetries: 0,
      fetch: async () => fail('Research HTTP fallback refused.'),
      onPayload: async (payload, sentModel) => {
        const replacement = await options.onPayload?.(payload, sentModel);
        const body = (replacement === undefined ? payload : replacement) as {
          model?: string;
          service_tier?: string;
          reasoning?: {effort?: string};
        } | null;
        if (
          !body ||
          body.model !== 'gpt-6-luna' ||
          body.service_tier !== 'default' ||
          body.reasoning?.effort !== 'high'
        )
          return fail('Research payload changed outside approved model/tier.');
        return replacement;
      },
      onProviderStreamEvent: async (data, sentModel) => {
        await options.onProviderStreamEvent?.(data, sentModel);
        const event = data as {
          type?: string;
          response?: {
            model?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              total_tokens?: number;
              input_tokens_details?: {cached_tokens?: number};
            };
          };
        };
        if (['error', 'response.failed'].includes(event.type ?? ''))
          return fail('Research provider error; no retry.');
        if (
          ![
            'response.completed',
            'response.done',
            'response.incomplete',
          ].includes(event.type ?? '')
        )
          return;
        const u = event.response?.usage,
          c = u?.input_tokens_details?.cached_tokens ?? 0;
        if (
          !/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(
            event.response?.model ?? '',
          ) ||
          !u ||
          ![u.input_tokens, u.output_tokens, u.total_tokens, c].every(
            n => Number.isSafeInteger(n) && n! >= 0,
          ) ||
          u.input_tokens! < c ||
          u.total_tokens !== u.input_tokens! + u.output_tokens! ||
          terminals >= requests
        )
          return fail('Research terminal usage/model unverified.');
        terminals++;
        input += u.input_tokens! - c;
        output += u.output_tokens!;
        cached += c;
        knownCost +=
          ((u.input_tokens! - c) * model.cost.input +
            u.output_tokens! * model.cost.output +
            c * model.cost.cacheRead) /
          1e6;
        record('terminal', {
          request: requests,
          model: event.response?.model,
          usage: u,
          knownSdkCost: knownCost,
        });
      },
    });
  };
  return {
    async close() {
      try {
        native.closeOpenAICodexWebSocketSessions(id);
        if (sockets.size)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => {
                waiters.delete(wake);
                reject(new Error('Research socket close deadline reached.'));
              },
              Math.max(0, deadlineAt - Date.now()),
            );
            const wake = () => {
              if (!sockets.size) {
                clearTimeout(timer);
                waiters.delete(wake);
                resolve();
              }
            };
            waiters.add(wake);
            wake();
          });
        cleanupComplete = !sockets.size;
        if (failure) throw new Error(failure);
      } finally {
        if (globalThis.WebSocket === Guard) globalThis.WebSocket = Native;
        occupied = sockets.size > 0;
      }
    },
    summary() {
      return {
        requestedTier: 'default',
        transport: 'websocket',
        requests,
        terminals,
        accountingComplete: requests > 0 && requests === terminals,
        knownSdkCost: knownCost,
        input,
        output,
        cacheRead: cached,
        cleanupComplete,
        error: failure,
        fulfillment: 'unverified',
        invoice: null,
      };
    },
  };
}
