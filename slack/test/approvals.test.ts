import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ContextEvent,
  ContextEventResult,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  createSlackApprovalGate,
  type SlackWriteConfirmationOptions,
} from '../src/approvals.ts';
import type {SlackConfig} from '../src/config.ts';

const config: SlackConfig = {
  token: 'private-token',
  tokenSource: 'SLACK_BOT_TOKEN',
  apiBaseUrl: 'https://slack.com/api',
  skipSendConfirm: false,
  allowNonInteractiveWrites: false,
};
const options: SlackWriteConfirmationOptions = {
  title: 'Send?',
  target: 'test thread',
  threadScope: {channelId: 'C12345678', parentThreadTs: '1.000001'},
};

function harness() {
  const entries: unknown[] = [];
  const state = {
    sessionId: 'session-a',
    choice: 'Approve thread for this session',
    selections: 0,
    confirmations: 0,
    lookups: 0,
    denyOnce: false,
  };
  const commands = new Map<
    string,
    {handler: (args: string, ctx: ExtensionContext) => Promise<void>}
  >();
  let contextHandler!: (
    event: ContextEvent,
    ctx: ExtensionContext,
  ) => Promise<ContextEventResult>;
  const pi = {
    on(_event: string, handler: typeof contextHandler) {
      contextHandler = handler;
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({type: 'custom', customType, data: structuredClone(data)});
    },
    registerCommand(
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      },
    ) {
      commands.set(name, command);
    },
  };
  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => state.sessionId,
      getEntries: () => entries,
    },
    ui: {
      select: async () => {
        state.selections++;
        return state.choice;
      },
      confirm: async () => {
        state.confirmations++;
        return !state.denyOnce;
      },
      notify() {},
    },
  } as unknown as ExtensionContext;
  const lookup = async (settings: SlackConfig) => {
    state.lookups++;
    return {
      workspaceId: settings.token === 'other-workspace' ? 'TOTHER' : 'T123',
      botUserId: settings.token === 'other-bot' ? 'UOTHER' : 'UBOT',
      botId: settings.token === 'other-bot' ? 'BOTHER' : 'BBOT',
      apiBaseUrl: settings.apiBaseUrl,
    };
  };
  const reload = () => createSlackApprovalGate(pi as never, lookup);
  const context = (context = ctx, messages: ContextEvent['messages'] = []) =>
    contextHandler({type: 'context', messages}, context);
  return {entries, state, commands, ctx, reload, pi, lookup, context};
}

// Consequential failures: stale/revoked consent, wrong identity/session, and
// unattended/global-bypass settings advertising an unsolicited destination.
test('context advertises only current verified thread grants and refreshes after revoke', async t => {
  const previous = {...process.env};
  process.env.SLACK_BOT_TOKEN = config.token;
  process.env.PI_SLACK_API_BASE_URL = config.apiBaseUrl;
  t.after(() => {
    for (const name of [
      'SLACK_BOT_TOKEN',
      'PI_SLACK_API_BASE_URL',
      'PI_SLACK_SKIP_SEND_CONFIRM',
    ]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const h = harness();
  const gate = h.reload();
  const snapshot = async (ctx = h.ctx) => {
    const result = await h.context(ctx);
    return JSON.stringify(result.messages);
  };
  assert.match(await snapshot(), /None\./);
  await gate(config, h.ctx, options);
  const first = await h.context();
  assert.match(JSON.stringify(first), /C12345678 thread 1.000001/);
  assert.ok(!JSON.stringify(first).includes(config.token));
  assert.equal(h.entries.length, 1); // Context snapshots are not persisted.
  const refreshed = await h.context(h.ctx, first.messages);
  assert.equal(refreshed.messages!.length, 1);
  assert.match(await snapshot({...h.ctx, hasUI: false}), /None\./);
  h.state.sessionId = 'fork';
  assert.match(await snapshot(), /None\./);
  h.state.sessionId = 'session-a';
  for (const token of ['other-workspace', 'other-bot']) {
    process.env.SLACK_BOT_TOKEN = token;
    assert.match(await snapshot(), /None\./);
  }
  process.env.SLACK_BOT_TOKEN = config.token;
  process.env.PI_SLACK_API_BASE_URL = 'https://other.test/api';
  assert.match(await snapshot(), /None\./);
  process.env.PI_SLACK_API_BASE_URL = config.apiBaseUrl;
  h.reload();
  assert.match(await snapshot(), /C12345678 thread 1.000001/);
  await h.commands.get('slack-approvals')!.handler('clear', h.ctx);
  assert.match(await snapshot(), /None\./);
  process.env.PI_SLACK_SKIP_SEND_CONFIRM = '1';
  assert.match(await snapshot(), /None\./);
  delete process.env.SLACK_BOT_TOKEN;
  assert.match(await snapshot(), /None\./);
});

test('Canvas grants and failed identity verification never advertise a thread', async t => {
  const previousToken = process.env.SLACK_BOT_TOKEN;
  const previousApi = process.env.PI_SLACK_API_BASE_URL;
  process.env.SLACK_BOT_TOKEN = config.token;
  process.env.PI_SLACK_API_BASE_URL = config.apiBaseUrl;
  t.after(() => {
    if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = previousToken;
    if (previousApi === undefined) delete process.env.PI_SLACK_API_BASE_URL;
    else process.env.PI_SLACK_API_BASE_URL = previousApi;
  });
  const h = harness();
  const gate = h.reload();
  h.state.choice = 'Approve Canvas content for this session';
  await gate(config, h.ctx, {
    ...options,
    threadScope: undefined,
    canvasScope: {canvasId: 'F123'},
  });
  assert.match(JSON.stringify(await h.context()), /None\./);
  h.state.choice = 'Approve thread for this session';
  await gate(config, h.ctx, options);
  createSlackApprovalGate(h.pi as never, async () => {
    throw new Error('unavailable');
  });
  assert.match(JSON.stringify(await h.context()), /None\./);
});

test('thread approval is reused and reload restores it without storing tokens', async () => {
  const {reload, ctx, state, entries} = harness();
  let gate = reload();
  await gate(config, ctx, options);
  await gate(config, ctx, options);
  assert.equal(state.selections, 1);
  assert.equal(state.lookups, 1);
  gate = reload();
  await gate(config, ctx, options);
  assert.equal(state.selections, 1);
  assert.equal(state.lookups, 2);
  assert.equal(entries.length, 1);
  assert.ok(!JSON.stringify(entries).includes('private-token'));
});

test('new sessions and forks cannot inherit session consent', async () => {
  const {reload, ctx, state} = harness();
  const gate = reload();
  await gate(config, ctx, options);
  state.sessionId = 'fork-with-inherited-entries';
  state.choice = 'Cancel';
  await assert.rejects(gate(config, ctx, options), /cancelled/);
  state.sessionId = 'session-a';
  await reload()(config, ctx, options);
  assert.equal(state.selections, 2);
});

test('approval once and cancellation do not create a grant', async () => {
  const {reload, ctx, state, entries} = harness();
  const gate = reload();
  state.choice = 'Approve once';
  await gate(config, ctx, options);
  state.choice = 'Cancel';
  await assert.rejects(gate(config, ctx, options), /cancelled/);
  assert.equal(entries.length, 0);
  assert.equal(state.selections, 2);
});

test('grant is exact to workspace/bot/API/channel/parent, not a whole-channel bypass', async () => {
  const {reload, ctx, state} = harness();
  const gate = reload();
  await gate(config, ctx, options);
  state.choice = 'Cancel';
  for (const patch of [
    {channelId: 'C87654321'},
    {parentThreadTs: '2.000001'},
  ]) {
    await assert.rejects(
      gate(config, ctx, {
        ...options,
        threadScope: {...options.threadScope!, ...patch},
      }),
      /cancelled/,
    );
  }
  await assert.rejects(
    gate({...config, token: 'other-bot'}, ctx, options),
    /cancelled/,
  );
  await assert.rejects(
    gate({...config, token: 'other-workspace'}, ctx, options),
    /cancelled/,
  );
  await assert.rejects(
    gate({...config, apiBaseUrl: 'https://other.test/api'}, ctx, options),
    /cancelled/,
  );
  // Rotation to a new token for the same bot retains the identity-scoped grant.
  await gate({...config, token: 'rotated-token'}, ctx, options);
  state.denyOnce = true;
  await assert.rejects(
    gate(config, ctx, {...options, threadScope: undefined}),
    /cancelled/,
  );
});

test('an existing grant does not weaken unattended execution policy', async () => {
  const {reload, ctx} = harness();
  const gate = reload();
  await gate(config, ctx, options);
  const unattended = {...ctx, hasUI: false};
  await assert.rejects(
    gate(config, unattended, {...options, confirm: true}),
    /blocked/,
  );
  await assert.rejects(
    gate({...config, allowNonInteractiveWrites: true}, unattended, options),
    /blocked/,
  );
  await gate({...config, allowNonInteractiveWrites: true}, unattended, {
    ...options,
    confirm: true,
  });
});

test('queued parallel replies reuse the first grant instead of prompting twice', async () => {
  const {reload, ctx, state} = harness();
  const gate = reload();
  await Promise.all([gate(config, ctx, options), gate(config, ctx, options)]);
  assert.equal(state.selections, 1);
});

test('failed identity verification falls back to approval-once, never a grant', async () => {
  const {pi, ctx, state, entries} = harness();
  const gate = createSlackApprovalGate(pi as never, async () => {
    throw new Error('network');
  });
  await gate(config, ctx, options);
  assert.equal(state.confirmations, 1);
  assert.equal(entries.length, 0);
  state.denyOnce = true;
  await assert.rejects(gate(config, ctx, options), /cancelled/);
});

test('revoke-all remains effective after reload; cancelled revoke changes nothing', async () => {
  const {reload, ctx, state, commands} = harness();
  const gate = reload();
  await gate(config, ctx, options);
  state.denyOnce = true;
  await commands.get('slack-approvals')!.handler('clear', ctx);
  await gate(config, ctx, options);
  assert.equal(state.selections, 1);
  state.denyOnce = false;
  await commands.get('slack-approvals')!.handler('clear', ctx);
  state.choice = 'Cancel';
  await assert.rejects(reload()(config, ctx, options), /cancelled/);
});

test('a single grant can be selected and revoked', async () => {
  const {reload, ctx, state, commands} = harness();
  const gate = reload();
  await gate(config, ctx, options);
  await gate(config, ctx, {
    ...options,
    threadScope: {channelId: 'C87654321', parentThreadTs: '2.000001'},
  });
  state.choice = '1. T123 / UBOT / C12345678 thread 1.000001';
  await commands.get('slack-approvals')!.handler('', ctx);
  state.choice = 'Cancel';
  await assert.rejects(reload()(config, ctx, options), /cancelled/);
  await gate(config, ctx, {
    ...options,
    threadScope: {channelId: 'C87654321', parentThreadTs: '2.000001'},
  });
});

test('allow command pre-approves a parent permalink without posting', async t => {
  const originalToken = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = config.token;
  t.after(() => {
    if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = originalToken;
  });
  const {reload, ctx, commands, state, entries} = harness();
  const gate = reload();
  await commands
    .get('slack-approvals')!
    .handler(
      'allow https://workspace.slack.com/archives/C12345678/p1788882359008009',
      ctx,
    );
  assert.equal(state.confirmations, 1);
  assert.equal(entries.length, 1);
  state.choice = 'Cancel';
  // The command uses normal config; match its API base URL in this isolated test.
  const commandConfig = {
    ...config,
    apiBaseUrl:
      process.env.PI_SLACK_API_BASE_URL?.replace(/\/+$/, '') ||
      config.apiBaseUrl,
  };
  await gate(commandConfig, ctx, {
    ...options,
    threadScope: {channelId: 'C12345678', parentThreadTs: '1788882359.008009'},
  });
  assert.equal(state.selections, 0);
  await assert.rejects(
    commands.get('slack-approvals')!.handler('clear', {...ctx, hasUI: false}),
    /interactive UI/,
  );
});

test('Canvas consent is separate, exact, reloadable, and unavailable to other sessions', async () => {
  const {reload, ctx, state} = harness();
  const canvasOptions = {
    ...options,
    threadScope: undefined,
    canvasScope: {canvasId: 'F123'},
  };
  const gate = reload();
  await gate(config, ctx, options);
  state.choice = 'Cancel';
  await assert.rejects(gate(config, ctx, canvasOptions), /cancelled/);
  state.choice = 'Approve Canvas content for this session';
  await gate(config, ctx, canvasOptions);
  const selected = state.selections;
  await reload()(config, ctx, canvasOptions);
  assert.equal(state.selections, selected);
  state.choice = 'Cancel';
  await assert.rejects(
    gate(config, ctx, {...canvasOptions, canvasScope: {canvasId: 'F456'}}),
    /cancelled/,
  );
  state.sessionId = 'fork';
  await assert.rejects(gate(config, ctx, canvasOptions), /cancelled/);
  state.sessionId = 'session-a';
  state.denyOnce = true;
  await assert.rejects(
    gate(config, ctx, {...canvasOptions, canvasScope: undefined}),
    /cancelled/,
  );
  await assert.rejects(
    gate(config, {...ctx, hasUI: false}, {...canvasOptions, confirm: true}),
    /blocked/,
  );
  await assert.rejects(
    gate(config, ctx, {...options, canvasScope: {canvasId: 'F123'}}),
    /both thread and Canvas/,
  );
});

test('v1 thread grants survive upgrade and v2 revocation remains effective', async () => {
  const {reload, ctx, state, entries, commands} = harness();
  entries.push({
    type: 'custom',
    customType: 'slack-thread-approval-v1',
    data: {
      sessionId: 'session-a',
      action: 'grant',
      grant: {
        sessionId: 'session-a',
        workspaceId: 'T123',
        botUserId: 'UBOT',
        botId: 'BBOT',
        apiBaseUrl: config.apiBaseUrl,
        ...options.threadScope,
      },
    },
  });
  state.choice = 'Cancel';
  await reload()(config, ctx, options);
  assert.equal(state.selections, 0);
  await commands.get('slack-approvals')!.handler('clear', ctx);
  await assert.rejects(reload()(config, ctx, options), /cancelled/);
});

test('allow-canvas command accepts a permalink and pre-approves only that Canvas', async t => {
  const previous = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = config.token;
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = previous;
  });
  const {reload, ctx, state, commands} = harness();
  const gate = reload();
  await commands
    .get('slack-approvals')!
    .handler('allow-canvas https://workspace.slack.com/docs/T123/F123', ctx);
  const commandConfig = {
    ...config,
    apiBaseUrl:
      process.env.PI_SLACK_API_BASE_URL?.replace(/\/+$/, '') ||
      config.apiBaseUrl,
  };
  state.choice = 'Cancel';
  await gate(commandConfig, ctx, {
    ...options,
    threadScope: undefined,
    canvasScope: {canvasId: 'F123'},
  });
  assert.equal(state.selections, 0);
  await assert.rejects(gate(commandConfig, ctx, options), /cancelled/);
  await assert.rejects(
    commands
      .get('slack-approvals')!
      .handler('allow-canvas https://evil.test/docs/T123/F456', ctx),
  );
});

test('abort before/during approval cannot persist consent', async () => {
  const {reload, ctx, entries} = harness();
  const gate = reload();
  await assert.rejects(
    gate(config, ctx, {...options, signal: AbortSignal.abort()}),
  );
  const controller = new AbortController();
  const cancelled = {
    ...ctx,
    ui: {
      ...ctx.ui,
      select: async () => {
        controller.abort();
        return 'Approve thread for this session';
      },
    },
  };
  await assert.rejects(
    gate(config, cancelled as ExtensionContext, {
      ...options,
      signal: controller.signal,
    }),
  );
  assert.equal(entries.length, 0);
});
