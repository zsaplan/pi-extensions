import type {Model} from '@earendil-works/pi-ai';
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';

export const lunaDefaults = {
  provider: 'openai-codex',
  model: 'gpt-6-luna',
  thinkingLevel: 'medium',
} as const;

// Pi 0.99.2 streamSimple drops serviceTier. Adapt this child instance only,
// delegating to the native stream to preserve auth, cancellation and pricing.
// No provider reimplementation, parent interception or model fallback.
export function installLunaTransport(runtime: ModelRuntime) {
  let requests = 0,
    terminals = 0,
    error: string | undefined;
  const responseModels: Array<string | null> = [];
  const responseTiers: Array<string | null> = [];
  const fail = (reason: string) => {
    error ??= reason;
    throw new Error(reason);
  };
  const bounded = (value: unknown) =>
    typeof value === 'string' ? value.slice(0, 128) : null;
  runtime.streamSimple = (model, context, options) => {
    if (
      model.provider !== lunaDefaults.provider ||
      model.api !== 'openai-codex-responses' ||
      model.id !== lunaDefaults.model ||
      options?.reasoning !== 'medium'
    )
      return fail('Pilot child model/API/reasoning mismatch.');
    return runtime.stream(model as Model<'openai-codex-responses'>, context, {
      ...options,
      reasoningEffort: 'medium',
      serviceTier: 'priority',
      onPayload: async (payload, sentModel) => {
        const replacement = await options?.onPayload?.(payload, sentModel);
        // Only undefined means unchanged. Never restore a null/redacted payload.
        const next = replacement === undefined ? payload : replacement;
        const body = next as {
          model?: unknown;
          service_tier?: unknown;
          reasoning?: {effort?: unknown};
        } | null;
        if (
          !body ||
          body.model !== lunaDefaults.model ||
          body.reasoning?.effort !== 'medium' ||
          body.service_tier !== 'priority'
        )
          return fail('Pilot outgoing model/reasoning/tier mismatch.');
        if (++requests > 50)
          return fail('Pilot request metadata limit exceeded.');
        return next;
      },
      onProviderStreamEvent: async (data, sentModel) => {
        await options?.onProviderStreamEvent?.(data, sentModel);
        const event = data as {
          type?: string;
          response?: {model?: unknown; service_tier?: unknown};
        } | null;
        if (
          !event ||
          !['response.completed', 'response.done'].includes(event.type ?? '')
        )
          return;
        terminals++;
        if (terminals > 50) {
          error ??= 'Pilot response metadata limit exceeded.';
          return;
        }
        const identity = bounded(event.response?.model);
        responseModels.push(identity);
        responseTiers.push(bounded(event.response?.service_tier));
        if (!/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(identity ?? ''))
          error ??= 'Pilot terminal response model is missing or unexpected.';
      },
    });
  };
  return {
    assertComplete() {
      if (error || !requests || requests !== terminals)
        throw new Error(
          error ?? 'Pilot request/response metadata is incomplete.',
        );
    },
    summary() {
      return {
        requestedServiceTier: 'priority',
        requestHooks: requests,
        terminalResponses: terminals,
        responseModels,
        responseTiers,
        error,
        meaning:
          'Observed provider metadata, not proof of fast service or invoiced pricing.',
      };
    },
  };
}
