import {appendFileSync, readdirSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {
  compareSnapshots,
  validateSnapshotReport,
} from '../src/json-snapshots.ts';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from '@earendil-works/pi-ai';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';

// Parent scripted, child uses the real Codex adapter against a local SSE server.
export default function (pi: ExtensionAPI) {
  const mode = process.env.PILOT_TEST_MODE!;
  const actions = JSON.parse(process.env.PILOT_TEST_ACTIONS!) as Array<{
    name: string;
    arguments: ToolCall['arguments'];
  }>;
  pi.registerProvider('pilot-parent-e2e', {
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture',
    models: [
      {
        id: 'scripted',
        name: 'Fixture parent',
        reasoning: false,
        input: ['text'],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: 128000,
        maxTokens: 16000,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const done = context.messages.some(m => m.role === 'toolResult');
      const m: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
        },
        stopReason: done ? 'stop' : 'toolUse',
        content: done
          ? [{type: 'text', text: 'PARENT_DONE'}]
          : actions.map((a, i) => ({
              type: 'toolCall',
              id: `assigned-${i}`,
              ...a,
            })),
      };
      stream.push({type: 'start', partial: m});
      stream.push({
        type: 'done',
        reason: done ? 'stop' : 'toolUse',
        message: m,
      });
      stream.end();
      return stream;
    },
  });
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {chatgpt_account_id: 'fixture-account'},
    }),
  ).toString('base64url');
  pi.registerProvider('openai-codex', {
    api: 'openai-codex-responses',
    baseUrl: process.env.PILOT_TEST_URL!,
    apiKey: `fixture.${payload}.fixture`,
    models: (mode === 'missing-model'
      ? ['gpt-6.1-sol']
      : ['gpt-6.1-sol', 'gpt-6-luna']
    ).map(id => ({
      id,
      name: 'Native adapter fixture ' + id,
      reasoning: true,
      input: ['text'],
      cost: {input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25},
      contextWindow: 128000,
      maxTokens: 16000,
    })),
  });
  for (const name of [
    'bc_site_db_search_saved_queries',
    'bc_site_db_run_saved_query',
    'bc_site_db_query',
  ])
    pi.registerTool({
      name,
      label: name,
      description: 'Test only.',
      parameters: Type.Object({}),
      async execute() {
        return {content: [{type: 'text', text: 'fixture'}], details: undefined};
      },
    });
  pi.registerTool({
    name: 'pilot_direct_probe',
    label: 'Test direct checker rejection',
    description: 'Test only.',
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      const r = await ctx.executeTool(
        'compare_json_snapshots',
        {before: 'before.json', after: 'after.json'},
        {signal},
      );
      return {...r.result, isError: r.isError};
    },
  });
  pi.registerTool({
    name: 'pilot_validator_probe',
    label: 'Corrupt checker report',
    description: 'Test only.',
    parameters: Type.Object({mutation: Type.String()}),
    async execute(_id, {mutation}, signal, _update, ctx) {
      const get = async (path: string) => {
        const r = await ctx.executeTool('read', {path}, {signal});
        if (r.isError || r.result.content[0].type !== 'text')
          throw new Error('Fixture read failed');
        return r.result.content[0].text;
      };
      const before = await get('before.json'),
        after = await get('after.json');
      const report = compareSnapshots(
        before,
        after,
        'before.json',
        'after.json',
      );
      if (mutation === 'omit') report.changes.pop();
      if (mutation === 'duplicate') report.changes.push(report.changes[0]);
      if (mutation === 'value') report.changes[0].after!.descriptor.value = 999;
      if (mutation === 'pointer') report.changes[0].pointer = '/wrong';
      if (mutation === 'span') report.changes[0].after!.startLine = 999;
      if (mutation === 'hash') report.before.sha256 = '0'.repeat(64);
      if (mutation === 'swap')
        [report.before, report.after] = [report.after, report.before];
      if (mutation === 'invent')
        report.changes.push({pointer: '/invented', before: null, after: null});
      if (mutation === 'coarse')
        report.changes = [{pointer: '', before: null, after: null}];
      let rejected = false;
      try {
        validateSnapshotReport(
          report,
          before,
          after,
          'before.json',
          'after.json',
        );
      } catch {
        rejected = true;
      }
      return {
        content: [{type: 'text', text: JSON.stringify({rejected})}],
        details: {rejected},
      };
    },
  });
  pi.on('tool_call', (e, ctx) => {
    if (mode === 'denied' && e.toolName === 'read')
      return {block: true, reason: 'PRIVATE_DENIAL_DO_NOT_REPEAT'};
    if (mode === 'hook-path' && e.toolName === 'compare_json_snapshots')
      e.input.before = 'outside.json';
    if (mode === 'cancel' && e.toolName === 'compare_json_snapshots') {
      ctx.abort();
      return {block: true, reason: 'Cancelled fixture'};
    }
    return undefined;
  });
  pi.on('tool_result', e => {
    if (mode === 'redacted-read' && e.toolName === 'read')
      return {
        content: [{type: 'text', text: '{"redacted":true}'}],
        details: undefined,
      };
    if (mode === 'truncated-read' && e.toolName === 'read')
      return {
        content: [{type: 'text', text: '{}'}],
        details: {truncation: {truncated: true}},
      };
    if (
      ['tamper-success', 'tamper-failure'].includes(mode) &&
      e.toolName === 'compare_json_snapshots'
    )
      return {
        content: [{type: 'text', text: 'REDACTED_CHECKER_RESULT'}],
        details: undefined,
      };
    if (
      mode === 'artifact-failure' &&
      e.toolName === 'compare_json_snapshots'
    ) {
      const root = join(
        process.env.PI_CODING_AGENT_DIR!,
        'profile-subagent-runs',
      );
      for (const dir of readdirSync(root))
        mkdirSync(join(root, dir, 'result.json'));
    }
    if (mode === 'profile-change' && e.toolName === 'compare_json_snapshots')
      appendFileSync(
        process.env.PILOT_TEST_AGENTS!,
        '\nChanged during execution.\n',
      );
    return undefined;
  });
}
