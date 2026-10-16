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

import {childCall} from './github-child-call.ts';

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
    task?: string;
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
            reservationId: `fixture-reservation-${cfg.scenario}${['failure-new-assignment', 'assignment-reference-isolation'].includes(cfg.scenario) ? `-${callId}` : ''}`,
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
  let readCalls = 0,
    syntheticPacketBytes = 2;
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName === 'github_research_read') {
      readCalls++;
      record({
        hook: true,
        at: Date.now(),
        callId: event.toolCallId,
        parent: event.parentToolCallId,
        args: event.input,
      });
      if (
        cfg.scenario === 'parent-deny' ||
        (cfg.scenario === 'cache-deny' && readCalls === 2)
      )
        return {block: true, reason: 'FIXTURE_PARENT_DENIED'};
      if (['cancel', 'failure-cancel'].includes(cfg.scenario))
        setTimeout(() => ctx.abort(), 120);
    }
    return undefined;
  });
  pi.on('tool_result', event => {
    if (
      event.toolName === 'github_research_read' &&
      cfg.scenario.startsWith('retention-')
    ) {
      let text: string | undefined;
      if (cfg.scenario === 'retention-hook-overflow' && readCalls === 1)
        text = 'OMITTED_HOOK_BODY_' + 'é'.repeat(25000);
      if (cfg.scenario === 'retention-child-limit' && readCalls === 1)
        text = 'é'.repeat(8192); // Fits the packet, but not the 16 KiB child view with its notice.
      if (cfg.scenario.startsWith('retention-packet-') && readCalls <= 4) {
        const content = [
          {type: 'text' as const, text: `SYNTHETIC_HOOK_${readCalls}_`},
        ];
        const entry = {
          callId: event.toolCallId,
          integrity: 'modified-or-unavailable',
          isError: event.isError,
          content,
        };
        const targetGrowth =
          readCalls < 4
            ? 12000
            : 49152 -
              syntheticPacketBytes +
              Number(cfg.scenario.endsWith('-over'));
        const padding =
          targetGrowth -
          Buffer.byteLength(JSON.stringify(entry)) -
          Number(readCalls > 1);
        content[0].text +=
          'é'.repeat(Math.floor(padding / 2)) + 'X'.repeat(padding % 2);
        syntheticPacketBytes +=
          Buffer.byteLength(JSON.stringify(entry)) + Number(readCalls > 1);
        text = content[0].text;
      }
      if (text !== undefined)
        return {
          content: [{type: 'text' as const, text}],
          details: {mustNotReachChild: 'ALTERNATE_HOOK_BODY'},
        };
    }
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
      (cfg.scenario === 'reference-redact' ||
        (cfg.scenario === 'cache-redact' && readCalls === 2))
    ) {
      const value = JSON.parse((event.content[0] as {text: string}).text);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'unavailable',
              sourceId: value.sourceId,
              revisionHandle: value.revisionHandle,
            }),
          },
        ],
        details: undefined,
      };
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
  let staleRevision = '',
    staleSource = '';
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
        ...(child && results.length === 0
          ? {toolSchemas: getCurrentTools(context.messages)}
          : {}),
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
        const count = [
          'repeat',
          'failure-new-assignment',
          'assignment-reference-isolation',
        ].includes(cfg.scenario)
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
                      task:
                        cfg.task ??
                        `Research the complete ${cfg.scenario} fixture question. Do not expand scope or claim deployment/restore success.`,
                    },
            },
          ];
        } else message.content = [{type: 'text', text: 'PARENT_DONE'}];
      } else if (
        ['adapter-limit', 'failure-detail-cap'].includes(cfg.scenario) &&
        results.length < cfg.actions.length
      ) {
        message.stopReason = 'toolUse';
        message.content = cfg.actions
          .slice(results.length, results.length + (results.length < 16 ? 4 : 3))
          .map((action, index) => ({
            type: 'toolCall' as const,
            id: `child-${results.length + index}`,
            name: 'github_research_read',
            arguments: action,
          }));
      } else if (
        results.length === 0 &&
        [
          'failure-concurrent',
          'failure-cancel',
          'default-head-concurrent',
          'request-limit',
          'retention-concurrent',
        ].includes(cfg.scenario)
      ) {
        message.stopReason = 'toolUse';
        // Two calls in the first turn let the ceiling test finish within the
        // unchanged ten-turn limit. Do not raise the production turn budget.
        const actions = ['request-limit', 'default-head-concurrent'].includes(
          cfg.scenario,
        )
          ? cfg.actions.slice(0, 2)
          : cfg.scenario === 'retention-concurrent'
            ? cfg.actions.slice(0, 4)
            : cfg.actions;
        message.content = actions.map((action, index) => ({
          type: 'toolCall' as const,
          id: `child-${index}`,
          name: 'github_research_read',
          arguments: action,
        }));
      } else if (results.length < cfg.actions.length) {
        const action = {...cfg.actions[results.length]};
        if (
          cfg.scenario === 'assignment-reference-isolation' &&
          staleRevision
        ) {
          action.revision = staleRevision;
          delete action.commit;
        }
        if (action.revision === '@previous') {
          const prior = results
            .flatMap(r => r.content)
            .find(c => c.type === 'text');
          action.revision = JSON.parse(
            prior?.type === 'text' ? prior.text : '{}',
          ).revisionHandle;
          if (cfg.scenario !== 'reference-conflict') delete action.commit;
        }
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
        const citations = sources
          .flatMap(s =>
            [
              s.sourceId,
              ...['items', 'matches'].flatMap(key =>
                Array.isArray(s[key])
                  ? s[key].map((i: {sourceId?: string}) => i.sourceId)
                  : [],
              ),
            ].filter(Boolean),
          )
          .map(id => `[[${id}]]`);
        if (cfg.scenario === 'assignment-reference-isolation') {
          if (staleSource) citations.push(`[[${staleSource}]]`);
          else {
            staleSource = String(sources[0].sourceId);
            staleRevision = String(sources[0].revisionHandle);
          }
        }
        // Adversarial fixture: guess an omitted ID despite the explicit gap.
        // Do not retrieve omitted source data from receipts or artifacts.
        if (cfg.scenario === 'reference-omitted')
          citations.push(
            `[[${String(sources[0].sourceId).replace(/-\d+$/, '-4')}]]`,
          );
        if (cfg.scenario === 'reference-expanded-limit')
          citations.push(...Array(300).fill(citations[0]));
        if (cfg.scenario === 'reference-raw')
          citations.push(`[direct](${sources[0].citation})`);
        if (cfg.scenario === 'reference-uppercase')
          citations.push(
            String(sources[0].citation).replace('https:', 'HTTPS:'),
          );
        if (cfg.scenario === 'reference-relative')
          citations.push('[direct](../config/service.yml#L2)');
        if (cfg.scenario === 'reference-wrong-commit')
          citations.push(
            String(sources[0].citation).replace(
              /\/blob\/[a-f0-9]{40}/,
              '/blob/' + 'a'.repeat(40),
            ),
          );
        if (cfg.scenario === 'reference-mutated')
          citations.push(
            String(sources[0].citation).replace(
              /\/blob\/([a-f0-9]{3})/,
              '/blob/',
            ),
          );
        if (cfg.scenario === 'reference-range')
          citations.push(
            String(sources[0].citation).replace(/#L.*/, '#L999-L1000'),
          );
        if (cfg.scenario === 'reference-unknown')
          citations.push('[[S000000000000-1]]');
        if (cfg.scenario === 'reference-malformed')
          citations.push('[[Sunfinished');
        const note =
          cfg.scenario === 'tool-contract-errors'
            ? 'Deliberately inaccurate fixture summary: one refused search and two schema failures.'
            : cfg.scenario === 'heldout-conflict'
              ? 'Documentation says retry_limit is 9, while settings specify 3 and the consumer reads settings.retry_limit. This is a source conflict, not proof of runtime behavior.'
              : cfg.scenario === 'heldout-incomplete'
                ? 'Consumer evidence is inaccessible. Documentation and settings disagree; the complete runtime question remains unanswered.'
                : cfg.scenario === 'adapter-limit'
                  ? 'Partial research: adapter budget exhausted before decisive file reads. No manifest contents or restore candidate established.'
                  : cfg.scenario === 'configuration'
                    ? 'Compare the observed pre-introduction and introduction versions; equal blob IDs across the old/new paths support a rename, not a new introduction. Later value changes do not establish deployment.'
                    : 'Snapshot configuration supports configured intent only. Successful restoration and SOC2 compliance remain unverified; execution evidence is unavailable here.';
        message.content = [
          {
            type: 'text',
            text: `## Findings\n${note}\n\nSources: ${citations.join('\n')}\nObservation IDs: ${sources
              .map(s => s.observationId)
              .filter(Boolean)
              .join(
                ', ',
              )}\n\nCoverage: bounded fixture reads only; missing, denied, paginated, redacted or incomplete observations are not absence. Discussions and attachments do not establish independently verified execution. Parent must check decisive sources. This is scripted transport, not model qualification.`,
          },
        ];
      }
      if (child)
        message.content = message.content.map(part =>
          part.type === 'toolCall' && part.name === 'github_research_read'
            ? {...part, ...childCall(part.arguments)}
            : part,
        );
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
