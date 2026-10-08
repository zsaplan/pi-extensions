import {appendFileSync} from 'node:fs';
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import {Type} from 'typebox';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

// Scripted transport only. All CLI/session/tool/resource behavior is real Pi.
export default function (pi: ExtensionAPI) {
  const scenario = process.env.PROFILE_E2E_SCENARIO!;
  const orchestration = scenario.startsWith('orchestration-');
  const policyScenario = scenario.replace(/^(search|orchestration)-/, '');
  let childStarts = 0;
  let abortParent: (() => void) | undefined;
  const actions = process.env.PROFILE_E2E_ACTIONS
    ? (JSON.parse(process.env.PROFILE_E2E_ACTIONS) as Array<{
        name: string;
        args: Record<string, string | number>;
      }>)
    : undefined;
  const record = (data: unknown) =>
    appendFileSync(
      process.env.PROFILE_E2E_RECORD!,
      `${JSON.stringify({at: Date.now(), ...(data as object)})}\n`,
    );
  if (policyScenario === 'read-override') {
    pi.registerTool({
      name: 'read',
      label: 'Parent read override',
      description: 'Return sanitized file evidence.',
      parameters: Type.Object({path: Type.String()}),
      async execute() {
        record({readOverride: true});
        return {
          content: [{type: 'text', text: 'PARENT_READ_OVERRIDE'}],
          details: undefined,
        };
      },
    });
  }
  for (const name of [
    'bc_site_db_search_saved_queries',
    'bc_site_db_run_saved_query',
    'bc_site_db_query',
  ]) {
    if (scenario === 'missing-tool' && name === 'bc_site_db_query') continue;
    pi.registerTool({
      name,
      label: name,
      description: 'Fake read-only DB evidence.',
      executionMode: orchestration ? 'sequential' : undefined,
      parameters: Type.Object({
        site: Type.Optional(Type.String()),
        sql: Type.Optional(Type.String()),
      }),
      async execute(_id, args) {
        record({executed: name, args});
        if (orchestration) {
          record({dbStart: name});
          await new Promise(resolve =>
            setTimeout(resolve, args.site === 'barrier' ? 300 : 20),
          );
          record({dbEnd: name});
        }
        return {
          content: [
            {type: 'text', text: `FAKE_DB_EVIDENCE ${args.site ?? ''}`},
          ],
          details: {present: false},
          ...(orchestration
            ? {
                usage: {
                  input: 2,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 3,
                  cost: {
                    input: 0.002,
                    output: 0.001,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0.003,
                  },
                },
              }
            : {}),
        };
      },
    });
  }
  pi.on('tool_call', async (event, ctx) => {
    if (orchestration && event.toolName === 'codemode')
      abortParent = () => ctx.abort();
    if (orchestration && event.toolName === 'profile_subagent_run') {
      record({
        runnerHook: true,
        id: event.toolCallId,
        parentToolCallId: event.parentToolCallId,
      });
      if (policyScenario === 'runner-block')
        return {block: true, reason: 'PARENT_RUNNER_DENIED'};
    }
    if (scenario === 'cancel' && event.toolName === 'profile_subagent_run') {
      setTimeout(() => ctx.abort(), 1000);
    }
    if (['read', 'grep', 'find', 'ls'].includes(event.toolName)) {
      record({
        fileHook: event.toolName,
        parentToolCallId: event.parentToolCallId,
      });
      if (policyScenario === `file-block-${event.toolName}`) {
        return {block: true, reason: 'PARENT_FILE_POLICY_DENIED'};
      }
    }
    if (event.toolName === 'bc_site_db_query') {
      record({
        hook: event.toolName,
        parentToolCallId: event.parentToolCallId,
        site: event.input.site,
      });
      if (policyScenario === 'parent-block')
        return {block: true, reason: 'PARENT_POLICY_DENIED'};
    }
    return undefined;
  });
  pi.on('tool_result', async event => {
    if (event.toolName === 'profile_subagent_search') {
      if (scenario === 'search-disable-after')
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'read'));
      if (scenario === 'search-change-after')
        appendFileSync(
          process.env.PROFILE_E2E_AGENTS!,
          '\nUPDATED_PROFILE_EVIDENCE\n',
        );
    }
    if (
      policyScenario === 'parent-redaction' &&
      event.toolName === 'bc_site_db_query'
    )
      return {
        content: [{type: 'text', text: 'PARENT_DB_REDACTED'}],
        details: undefined,
      };
    if (policyScenario === 'file-redaction' && event.toolName === 'read') {
      return {
        content: [{type: 'text', text: 'PARENT_REDACTED'}],
        details: undefined,
      };
    }
    return undefined;
  });
  const providerConfig: Parameters<ExtensionAPI['registerProvider']>[1] = {
    api: 'openai-completions',
    apiKey: scenario === 'runtime-auth' ? undefined : 'test-only',
    baseUrl: 'http://127.0.0.1:1',
    models: [
      {
        id: 'scripted',
        name: 'Scripted E2E',
        reasoning: false,
        input: ['text'],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: 128000,
        maxTokens: 16000,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const system = getCurrentSystemPrompt(context.messages);
      const child = system.includes('You are a narrow delegated agent.');
      const results = context.messages.filter(m => m.role === 'toolResult');
      const taskKey = child
        ? JSON.stringify(context.messages.find(m => m.role === 'user')).match(
            /\bTASK_[A-Z0-9]+\b/,
          )?.[0]
        : undefined;
      if (orchestration && child && results.length === 0) {
        childStarts++;
        record({childStart: taskKey});
        if (childStarts === 3) {
          if (policyScenario === 'cancel')
            setTimeout(() => void abortParent?.(), 100);
          if (policyScenario === 'disable-after')
            pi.setActiveTools(
              pi.getActiveTools().filter(name => name !== 'bc_site_db_query'),
            );
          if (policyScenario === 'change-after')
            appendFileSync(
              process.env.PROFILE_E2E_AGENTS!,
              '\nQUEUED_PROFILE_CHANGED\n',
            );
        }
      }
      record({
        taskKey,
        request: child ? 'child' : 'parent',
        provider: model.provider,
        model: model.id,
        reasoning: options?.reasoning,
        authMatched:
          options?.apiKey ===
          (scenario.startsWith('runtime-auth')
            ? process.env.PROFILE_E2E_KEY
            : child
              ? 'child-test-only'
              : scenario === 'cross-provider-key'
                ? process.env.PROFILE_E2E_KEY
                : 'test-only'),
        system,
        tools: getCurrentTools(context.messages).map(t => t.name),
        declarations:
          !child && ['happy', 'orchestration-parallel'].includes(scenario)
            ? getCurrentTools(context.messages).map(({name, description}) => ({
                name,
                description,
              }))
            : undefined,
        messages: context.messages,
      });
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: 'pending',
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost:
            orchestration && child
              ? {
                  input: 0.01,
                  output: 0.002,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0.012,
                }
              : {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
        },
      };
      const call = (name: string, args: Record<string, string | number>) => {
        message.content = [
          {
            type: 'toolCall',
            id: `call-${results.length}`,
            name,
            arguments: args,
          },
        ];
        message.stopReason = 'toolUse';
      };
      if (!child) {
        if (
          policyScenario === 'direct' &&
          orchestration &&
          results.length === 0
        ) {
          message.content = Array.from({length: 5}, (_, i) => ({
            type: 'toolCall' as const,
            id: `direct-${i}`,
            name: 'profile_subagent_run',
            arguments: {
              profile: 'postfix-repair-planner',
              task: `NARROW_TASK_ONLY TASK_${i}`,
            },
          }));
          message.stopReason = 'toolUse';
        } else if (actions) {
          const action = actions[results.length];
          if (action) call(action.name, action.args);
          else {
            message.content = [{type: 'text', text: 'PARENT_DONE'}];
            message.stopReason = 'stop';
          }
        } else if (results.length === 0) {
          call('profile_subagent_run', {
            profile:
              scenario === 'invalid-profile'
                ? '../bad'
                : scenario === 'reviewer'
                  ? 'postfix-repair-reviewer'
                  : scenario.startsWith('investigator-')
                    ? 'postfix-investigator'
                    : 'postfix-repair-planner',
            task: scenario.startsWith('investigator-')
              ? `NARROW_TASK_ONLY: investigate ${scenario === 'investigator-batch' ? '268, 362, 503, 584, 525, 548, 544' : '268'} for fixture-site / uat using evidence.txt. Metadata and presence/count queries only. No writes or endpoints.`
              : 'NARROW_TASK_ONLY: inspect fixture evidence for the named target. No writes.',
          });
        } else {
          message.content = [{type: 'text', text: 'PARENT_DONE'}];
          message.stopReason = 'stop';
        }
      } else if (
        scenario === 'timeout' ||
        scenario === 'cancel' ||
        (orchestration &&
          ['timeout', 'cancel', 'script-error', 'early-return'].includes(
            policyScenario,
          ) &&
          taskKey !== 'TASK_RECOVERY')
      ) {
        const abort = () => {
          message.stopReason = 'aborted';
          message.errorMessage = 'Fixture observed cancellation';
          stream.push({type: 'error', reason: 'aborted', error: message});
          stream.end();
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener('abort', abort, {once: true});
        return stream;
      } else if (scenario === 'provider-error' || taskKey === 'TASK_FAIL') {
        message.stopReason = 'error';
        message.errorMessage = 'FIXTURE_PROVIDER_ERROR';
      } else if (scenario === 'turn-limit' || results.length === 0) {
        if (
          child &&
          (system.includes('Profile: configuration-drift-reviewer.') ||
            system.includes('Profile: documentation-consistency-reviewer.'))
        )
          call('read', {path: 'evidence.txt'});
        else if (scenario === 'forbidden')
          call('bash', {command: 'touch MUST_NOT_EXIST'});
        else if (scenario === 'recursive')
          call('profile_subagent_run', {
            profile: 'postfix-repair-planner',
            task: 'escape',
          });
        else if (
          [
            'local-read',
            'read-override',
            'file-redaction',
            'file-block-read',
          ].includes(scenario)
        )
          call('read', {path: 'evidence.txt'});
        else if (scenario === 'file-block-grep')
          call('grep', {pattern: 'LOCAL_EVIDENCE_CONTENT', path: '.'});
        else if (scenario === 'file-block-find')
          call('find', {pattern: '*.txt', path: '.'});
        else if (scenario === 'file-block-ls') call('ls', {path: '.'});
        else
          call('bc_site_db_query', {
            site: orchestration ? `fixture-site-${taskKey}` : 'fixture-site',
            sql: 'SELECT 1',
          });
      } else {
        message.stopReason = scenario === 'length' ? 'length' : 'stop';
        message.content = [
          {
            type: 'text',
            text:
              scenario === 'empty'
                ? ''
                : scenario === 'large'
                  ? 'Z'.repeat(30000)
                  : `CHILD_RESULT ${JSON.stringify(results.at(-1))}`,
          },
        ];
      }
      const finish = () => {
        stream.push({type: 'start', partial: message});
        if (message.stopReason === 'error') {
          stream.push({type: 'error', reason: 'error', error: message});
        } else {
          stream.push({
            type: 'done',
            reason: message.stopReason as 'stop' | 'toolUse' | 'length',
            message,
          });
        }
        stream.end();
      };
      if (orchestration && child && results.length === 0) {
        const abort = () => {
          clearTimeout(timer);
          message.stopReason = 'error';
          message.errorMessage = 'Fixture observed cancellation';
          finish();
        };
        const timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', abort);
          finish();
        }, 200);
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener('abort', abort, {once: true});
      } else finish();
      return stream;
    },
  };
  pi.registerProvider('profile-e2e', providerConfig);
  pi.registerProvider('openai-codex', {
    ...providerConfig,
    apiKey:
      scenario === 'runtime-auth'
        ? '${PROFILE_E2E_UNSET_KEY}'
        : scenario === 'runtime-auth-override'
          ? 'test-only'
          : 'child-test-only',
    models: [
      ...providerConfig.models!,
      ...(scenario === 'missing-child-model'
        ? []
        : [
            {
              id: 'gpt-6.1-sol',
              name: 'Scripted child default',
              reasoning: scenario !== 'unsupported-thinking',
              input: ['text'] as ['text'],
              cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
              contextWindow: 128000,
              maxTokens: 16000,
            },
          ]),
    ],
  });
}
