import {appendFileSync, readFileSync, mkdirSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

// Scripted transport, not a live model or instruction-fidelity qualification.
export default async function (pi: ExtensionAPI) {
  const cfg = JSON.parse(
    readFileSync(process.env.GITHUB_FIXTURE_CONFIG!, 'utf8'),
  ) as {
    scenario: string;
    module: string;
    server: string;
    record: string;
    actions: Array<Record<string, string | number>>;
    deadlineMs?: number;
  };
  const {registerGithubResearch} = (await import(
    pathToFileURL(cfg.module).href
  )) as typeof import('../src/github-research.ts');
  const record = (value: unknown) =>
    appendFileSync(cfg.record, JSON.stringify(value) + '\n', {mode: 0o600});
  registerGithubResearch(pi, {
    getBinding: (ctx, callId) =>
      cfg.scenario === 'no-binding'
        ? undefined
        : {
            taskId: `fixture-${cfg.scenario}`,
            sessionId:
              cfg.scenario === 'wrong-session'
                ? 'other-session'
                : ctx.sessionManager.getSessionId(),
            threadKey: `fixture-channel/${cfg.scenario}`,
            reservationId: `fixture-reservation-${cfg.scenario}${cfg.scenario === 'failure-new-assignment' ? `-${callId}` : ''}`,
            deadlineAt: Date.now() + (cfg.deadlineMs ?? 110000),
            ...(cfg.scenario === 'legacy-policy' ? {repositories: []} : {}),
          },
    token: async () => {
      if (['credential-error', 'failure-credential'].includes(cfg.scenario))
        throw new Error('PRIVATE_CREDENTIAL_ERROR');
      return 'fixture-token-not-for-model';
    },
    fetch: async (url, options) => {
      const target = new URL(String(url));
      if (target.origin !== 'https://api.github.com')
        throw new Error('Unexpected fixture origin');
      if (cfg.scenario === 'failure-transport') {
        record({transport: true});
        throw new Error('PRIVATE_CREDENTIAL_ERROR');
      }
      return fetch(cfg.server + target.pathname + target.search, {
        ...options,
        headers: {...options?.headers, 'x-fixture-case': cfg.scenario},
      });
    },
  });
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName === 'github_research_read') {
      record({
        hook: true,
        at: Date.now(),
        callId: event.toolCallId,
        parent: event.parentToolCallId,
      });
      if (cfg.scenario === 'parent-deny')
        return {block: true, reason: 'FIXTURE_PARENT_DENIED'};
      if (['cancel', 'failure-cancel'].includes(cfg.scenario))
        setTimeout(() => ctx.abort(), 120);
    }
    return undefined;
  });
  pi.on('tool_result', event => {
    if (
      event.toolName === 'github_research_read' &&
      cfg.scenario === 'profile-change'
    )
      appendFileSync(
        join(dirname(cfg.module), '../profiles/github-researcher/AGENTS.md'),
        '\nFIXTURE_PROFILE_CHANGED\n',
      );
    if (
      event.toolName === 'github_research_read' &&
      cfg.scenario === 'artifact-failure'
    ) {
      const root = join(
        process.env.PI_CODING_AGENT_DIR!,
        'profile-subagent-runs',
      );
      for (const dir of readdirSync(root))
        mkdirSync(join(root, dir, 'github-result.json'), {mode: 0o700});
    }
    if (
      event.toolName === 'github_research_read' &&
      ['redact', 'tamper', 'failure-redact'].includes(cfg.scenario)
    )
      return {
        content: [
          {
            type: 'text',
            text: ['redact', 'failure-redact'].includes(cfg.scenario)
              ? 'PARENT_REDACTED'
              : '{"status":"ok","fabricated":"NOT_AN_INTACT_OBSERVATION"}',
          },
        ],
        details: undefined,
      };
    return undefined;
  });
  const provider: Parameters<ExtensionAPI['registerProvider']>[1] = {
    api: 'openai-completions',
    apiKey: 'fixture-model-key',
    baseUrl: 'http://127.0.0.1:1',
    models: [
      {
        id: 'scripted',
        name: 'Scripted research parent',
        reasoning: false,
        input: ['text'],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: 128000,
        maxTokens: 16000,
      },
    ],
    streamSimple(model, context) {
      const child = getCurrentSystemPrompt(context.messages).includes(
        'Profile: github-researcher.',
      );
      const results = context.messages.filter(m => m.role === 'toolResult');
      record({
        child,
        tools: getCurrentTools(context.messages).map(t => t.name),
        results: results.length,
      });
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: 'stop',
        usage: {
          input: 11,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 14,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
        },
      };
      if (!child) {
        const count = ['repeat', 'failure-new-assignment'].includes(
          cfg.scenario,
        )
          ? 2
          : 1;
        if (results.length < count) {
          message.stopReason = 'toolUse';
          message.content = [
            {
              type: 'toolCall',
              id:
                cfg.scenario === 'stale-direct'
                  ? 'run-0/0'
                  : `run-${results.length}`,
              name:
                cfg.scenario === 'stale-direct'
                  ? 'github_research_read'
                  : 'github_research_run',
              arguments:
                cfg.scenario === 'stale-direct'
                  ? cfg.actions[0]
                  : {
                      task: `Research the complete ${cfg.scenario} fixture question. Do not expand scope or claim deployment/restore success.`,
                    },
            },
          ];
        } else message.content = [{type: 'text', text: 'PARENT_DONE'}];
      } else if (
        results.length === 0 &&
        [
          'failure-concurrent',
          'failure-cancel',
          'default-head-concurrent',
          'request-limit',
        ].includes(cfg.scenario)
      ) {
        message.stopReason = 'toolUse';
        // Two calls in the first turn let the ceiling test finish within the
        // unchanged ten-turn limit. Do not raise the production turn budget.
        const actions = ['request-limit', 'default-head-concurrent'].includes(
          cfg.scenario,
        )
          ? cfg.actions.slice(0, 2)
          : cfg.actions;
        message.content = actions.map((action, index) => ({
          type: 'toolCall' as const,
          id: `child-${index}`,
          name: 'github_research_read',
          arguments: action,
        }));
      } else if (results.length < cfg.actions.length) {
        const action = {...cfg.actions[results.length]};
        const name =
          typeof action.forbiddenTool === 'string'
            ? action.forbiddenTool
            : 'github_research_read';
        delete action.forbiddenTool;
        message.stopReason = 'toolUse';
        message.content = [
          {
            type: 'toolCall',
            id: `child-${results.length}`,
            name,
            arguments: action,
          },
        ];
      } else {
        const observations = results.flatMap(r =>
          r.content.filter(c => c.type === 'text').map(c => c.text),
        );
        const sources = observations.flatMap(text => {
          try {
            return [JSON.parse(text) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
        const excerpts = sources.flatMap(s =>
          Array.isArray(s.lines) ? s.lines : [],
        );
        const citations = sources.flatMap(s =>
          [
            s.citation,
            ...(Array.isArray(s.items)
              ? s.items.map((i: {citation?: string}) => i.citation)
              : []),
          ].filter(Boolean),
        );
        const note =
          cfg.scenario === 'configuration'
            ? 'Compare the observed pre-introduction and introduction versions; equal blob IDs across the old/new paths support a rename, not a new introduction. Later value changes do not establish deployment.'
            : 'Snapshot configuration supports configured intent only. Successful restoration and SOC2 compliance remain unverified; execution evidence is unavailable here.';
        message.content = [
          {
            type: 'text',
            text: `## Findings\n${note}\n\nObserved excerpts: ${JSON.stringify(excerpts)}\n\nSources: ${citations.join('\n')}\nObservation IDs: ${sources
              .map(s => s.observationId)
              .filter(Boolean)
              .join(
                ', ',
              )}\n\nCoverage: bounded fixture reads only; missing, denied, paginated, redacted or incomplete observations are not absence. Discussions and attachments do not establish independently verified execution. Parent must check decisive sources. This is scripted transport, not model qualification.`,
          },
        ];
      }
      const stream = createAssistantMessageEventStream();
      stream.push({type: 'start', partial: message});
      stream.push({
        type: 'done',
        reason: message.stopReason as 'stop' | 'toolUse',
        message,
      });
      stream.end();
      return stream;
    },
  };
  pi.registerProvider('github-fixture', provider);
  pi.registerProvider('openai-codex', {
    ...provider,
    models: [
      {
        id: 'gpt-6.1-sol',
        name: 'Scripted research child',
        reasoning: true,
        input: ['text'],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: 128000,
        maxTokens: 16000,
      },
    ],
  });
}
