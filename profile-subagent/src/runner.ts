import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Usage} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionToolContext,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {LoadedProfile} from './profiles.ts';

export const childDefaults = {
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  thinkingLevel: 'medium',
} as const;

export function profileResources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({extensions: [], errors: [], runtime}),
    getSkills: () => ({skills: [], diagnostics: []}),
    getPrompts: () => ({prompts: [], diagnostics: []}),
    getThemes: () => ({themes: [], diagnostics: []}),
    getAgentsFiles: () => ({agentsFiles: []}),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
  };
}

export async function runProfile(
  profile: LoadedProfile,
  task: string,
  ctx: ExtensionToolContext,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const {manifest} = profile;
  const toolNames = [...manifest.builtinTools, ...manifest.parentTools];
  const parentTools = toolNames.map(name => {
    const tool = ctx.tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Required parent tool is unavailable: ${name}`);
    return tool;
  });
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Parent cancelled the run.'));
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Profile time limit reached.'));
  }, manifest.timeoutSeconds * 1000);
  const customTools: ToolDefinition[] = parentTools.map(tool => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id, args, childSignal) {
      controller.signal.throwIfAborted();
      const result = await ctx.executeTool(tool.name, args, {
        signal: childSignal
          ? AbortSignal.any([controller.signal, childSignal])
          : controller.signal,
      });
      // Parent Pi already accounts for nested-tool usage; don't count it twice.
      return {
        content: result.result.content,
        details: result.result.details,
        isError: result.isError,
      };
    },
  }));
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>['session']
    | undefined;
  let unsubscribe: (() => void) | undefined;
  let artifactDir: string | undefined;
  let error: string | undefined;
  let turns = 0;
  const abortChild = () => {
    void session?.abort();
  };
  controller.signal.addEventListener('abort', abortChild, {once: true});
  const startedAt = new Date().toISOString();
  try {
    const root = join(getAgentDir(), 'profile-subagent-runs');
    await mkdir(root, {recursive: true, mode: 0o700});
    artifactDir = await mkdtemp(join(root, `${manifest.id}-`));
    await writeFile(
      join(artifactDir, 'input.json'),
      JSON.stringify(
        {
          startedAt,
          parentSessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          model: {provider: childDefaults.provider, id: childDefaults.model},
          thinkingLevel: childDefaults.thinkingLevel,
          parentModel: ctx.model
            ? {provider: ctx.model.provider, id: ctx.model.id}
            : undefined,
          parentThinkingLevel: ctx.thinkingLevel,
          task,
          profile,
        },
        null,
        2,
      ),
      {mode: 0o600},
    );
    const modelRuntime = await ModelRuntime.create({signal: controller.signal});
    const native = ctx.modelRegistry.getRegisteredNativeProvider(
      childDefaults.provider,
    );
    if (native) modelRuntime.registerNativeProvider(native);
    const config = ctx.modelRegistry.getRegisteredProviderConfig(
      childDefaults.provider,
    );
    if (config) modelRuntime.registerProvider(childDefaults.provider, config);
    const model = modelRuntime.getModel(
      childDefaults.provider,
      childDefaults.model,
    );
    if (!model)
      throw new Error(
        `Required child model is unavailable: ${childDefaults.provider}/${childDefaults.model}`,
      );
    // Copy only this provider's override, never a key for the parent's other provider.
    if (
      ctx.modelRegistry.getProviderAuthStatus(childDefaults.provider).source ===
      'runtime'
    ) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(
        childDefaults.provider,
      );
      controller.signal.throwIfAborted();
      if (!apiKey)
        throw new Error('Could not resolve the parent runtime API key.');
      await modelRuntime.setRuntimeApiKey(childDefaults.provider, apiKey, {
        signal: controller.signal,
      });
    }
    controller.signal.throwIfAborted();
    ({session} = await createAgentSession({
      cwd: ctx.cwd,
      model,
      modelRuntime,
      thinkingLevel: childDefaults.thinkingLevel,
      tools: toolNames,
      customTools,
      resourceLoader: profileResources(profile.systemPrompt),
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.inMemory({
        cacheWarming: 'off',
        compaction: {enabled: false},
        retry: {enabled: false},
        enableSkillCommands: false,
      }),
    }));
    if (
      session.model?.provider !== childDefaults.provider ||
      session.model?.id !== childDefaults.model ||
      session.thinkingLevel !== childDefaults.thinkingLevel
    )
      throw new Error(
        'Child model or thinking level did not match the required defaults.',
      );
    const expected = [...toolNames].sort();
    if (
      JSON.stringify(session.getActiveToolNames().sort()) !==
      JSON.stringify(expected)
    ) {
      throw new Error('Child tool set did not match the profile.');
    }
    unsubscribe = session.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        turns++;
        if (
          turns >= manifest.maxTurns &&
          event.message.stopReason === 'toolUse'
        ) {
          controller.abort(new Error('Profile turn limit reached.'));
        }
      }
    });
    controller.signal.throwIfAborted();
    await session.prompt(task, {expandPromptTemplates: false});
    controller.signal.throwIfAborted();
    const last = session.messages.filter(m => m.role === 'assistant').at(-1);
    if (
      !last ||
      last.stopReason !== 'stop' ||
      !session.getLastAssistantText()?.trim()
    ) {
      throw new Error(
        last?.errorMessage ||
          `Incomplete child response (${last?.stopReason ?? 'none'}).`,
      );
    }
  } catch (cause) {
    const reason = controller.signal.aborted ? controller.signal.reason : cause;
    error = reason instanceof Error ? reason.message : String(reason);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abortChild);
    unsubscribe?.();
    session?.dispose();
  }
  const usage = emptyUsage();
  for (const message of session?.messages ?? []) {
    if (message.role !== 'assistant') continue;
    const u = message.usage;
    usage.input += u.input;
    usage.output += u.output;
    usage.cacheRead += u.cacheRead;
    usage.cacheWrite += u.cacheWrite;
    usage.totalTokens += u.totalTokens;
    for (const key of [
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'total',
    ] as const) {
      usage.cost[key] += u.cost[key];
    }
  }
  const result = {
    status: error ? 'failed' : 'completed',
    profile: manifest.id,
    profileDigest: profile.digest,
    model: {provider: childDefaults.provider, id: childDefaults.model},
    thinkingLevel: childDefaults.thinkingLevel,
    startedAt,
    finishedAt: new Date().toISOString(),
    turns,
    tools: toolNames,
    artifactDir,
    error,
    usage,
    output: session?.getLastAssistantText() ?? '',
  };
  try {
    if (!artifactDir)
      throw new Error('Could not create an artifact directory.');
    await writeFile(
      join(artifactDir, 'messages.json'),
      JSON.stringify(session?.messages ?? [], null, 2),
      {mode: 0o600},
    );
    await writeFile(join(artifactDir, 'result.md'), result.output, {
      mode: 0o600,
    });
    // Completion metadata comes last: incomplete evidence must not look complete.
    await writeFile(
      join(artifactDir, 'result.json'),
      JSON.stringify(result, null, 2),
      {mode: 0o600},
    );
  } catch (cause) {
    result.status = 'failed';
    result.error =
      `${result.error ?? ''} Artifact persistence failed: ${String(cause)}`.trim();
  }
  const summary = {
    ...result,
    output: result.output.slice(0, 24000),
    outputTruncated: result.output.length > 24000,
  };
  return {
    content: [{type: 'text' as const, text: JSON.stringify(summary, null, 2)}],
    details: summary,
    usage,
    isError: result.status !== 'completed',
  };
}
