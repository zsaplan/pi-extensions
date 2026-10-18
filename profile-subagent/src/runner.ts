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
import {
  checkedProfileId,
  githubResearchProfileId,
  loadProfile,
  type LoadedProfile,
} from './profiles.ts';
import {
  installResearchTransport,
  researchDefaults,
} from './github-transport.ts';
import {installLunaTransport, lunaDefaults} from './luna-transport.ts';
import type {
  SnapshotChecker,
  SnapshotPaths,
  SnapshotOutcome,
  SnapshotFailure,
} from './snapshot-tool.ts';
import type {SnapshotReport} from './json-snapshots.ts';
import {FileEvidence} from './file-evidence.ts';
import {githubChildTools} from './github-tools.ts';

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
  pilot?: {checker: SnapshotChecker; callId: string; paths: SnapshotPaths},
  observeToolResult?: (message: {
    toolCallId: string;
    toolName: string;
    isError: boolean;
  }) => void,
  research?: {deadlineAt: number; artifactRoot: string; authPath?: string},
) {
  signal?.throwIfAborted();
  const {manifest} = profile;
  if ((manifest.id === checkedProfileId) !== !!pilot)
    throw new Error(
      'Checked pilot requires explicit operator enablement and snapshot paths.',
    );
  if (research && (manifest.id !== githubResearchProfileId || pilot))
    throw new Error('Standard research transport requires the GitHub profile.');
  const defaults = research
    ? researchDefaults
    : pilot
      ? lunaDefaults
      : childDefaults;
  let researchTransport:
    | Awaited<ReturnType<typeof installResearchTransport>>
    | undefined;
  if (
    pilot &&
    (!ctx.tools.some(t => t.name === 'read') ||
      JSON.stringify([...manifest.builtinTools, ...manifest.parentTools]) !==
        JSON.stringify(['compare_json_snapshots']))
  )
    throw new Error(
      'Checked pilot requires the checker-only child and a callable parent read tool.',
    );
  const assertPilotProfile = async () => {
    if (
      pilot &&
      (await loadProfile(manifest.id, true)).digest !== profile.digest
    )
      throw new Error(
        'Profile changed during execution; result is not accepted.',
      );
  };
  let transport: ReturnType<typeof installLunaTransport> | undefined;
  let assignment: ReturnType<SnapshotChecker['begin']> | undefined;
  let snapshotCalls = 0;
  let observed: SnapshotOutcome | undefined;
  let checkedSnapshot: SnapshotReport | undefined;
  let comparisonFailure: SnapshotFailure | undefined;
  const toolNames = [...manifest.builtinTools, ...manifest.parentTools];
  const parentTools = toolNames.map(name => {
    const tool = ctx.tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Required parent tool is unavailable: ${name}`);
    return tool;
  });
  if (
    manifest.id === githubResearchProfileId &&
    (toolNames.length !== 1 || toolNames[0] !== 'github_research_read')
  )
    throw new Error(
      'GitHub child interfaces require the single authorized parent adapter.',
    );
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Parent cancelled the run.'));
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Profile time limit reached.'));
  }, manifest.timeoutSeconds * 1000);
  const fileEvidence = new FileEvidence();
  let finalSummaryTurn = false;
  let customTools: ToolDefinition[] = parentTools.map(tool => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id, args, childSignal) {
      controller.signal.throwIfAborted();
      if (finalSummaryTurn)
        throw new Error('Final summary turn: source tools are disabled.');
      await assertPilotProfile();
      if (pilot) {
        transport!.assertComplete();
        if (++snapshotCalls !== 1)
          throw new Error('Only one checker call is allowed.');
      }
      const requestedArguments =
        tool.name === 'read' ? structuredClone(args) : undefined;
      if (tool.name === 'read') fileEvidence.begin();
      const result = await ctx.executeTool(tool.name, args, {
        signal: childSignal
          ? AbortSignal.any([controller.signal, childSignal])
          : controller.signal,
      });
      if (tool.name === 'read') {
        fileEvidence.record(
          _id,
          requestedArguments,
          result.result.content,
          result.isError,
        );
      }
      if (pilot) observed = assignment!.take(result);
      // Parent Pi already accounts for nested-tool usage; don't count it twice.
      return {
        content: result.result.content,
        details: result.result.details,
        isError: result.isError,
      };
    },
  }));
  if (manifest.id === githubResearchProfileId)
    customTools = githubChildTools(customTools[0]);
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
    await assertPilotProfile();
    if (pilot)
      assignment = pilot.checker.begin(
        ctx.sessionManager.getSessionId(),
        pilot.callId,
        pilot.paths,
      );
    const root =
      research?.artifactRoot ?? join(getAgentDir(), 'profile-subagent-runs');
    await mkdir(root, {recursive: true, mode: 0o700});
    artifactDir = await mkdtemp(join(root, `${manifest.id}-`));
    await writeFile(
      join(artifactDir, 'input.json'),
      JSON.stringify(
        {
          startedAt,
          parentSessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          model: {provider: defaults.provider, id: defaults.model},
          thinkingLevel: defaults.thinkingLevel,
          ...(pilot
            ? {snapshotPaths: pilot.paths, requestedServiceTier: 'priority'}
            : {}),
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
    const modelRuntime = await ModelRuntime.create({
      signal: controller.signal,
      ...(research ? {authPath: research.authPath, modelsPath: null} : {}),
    });
    const native = ctx.modelRegistry.getRegisteredNativeProvider(
      defaults.provider,
    );
    if (native && !research) modelRuntime.registerNativeProvider(native);
    const config = ctx.modelRegistry.getRegisteredProviderConfig(
      defaults.provider,
    );
    if (config && !research)
      modelRuntime.registerProvider(defaults.provider, config);
    const model = modelRuntime.getModel(defaults.provider, defaults.model);
    if (!model)
      throw new Error(
        `Required child model is unavailable: ${defaults.provider}/${defaults.model}`,
      );
    // Copy only this provider's override, never a key for the parent's other provider.
    if (
      !research &&
      ctx.modelRegistry.getProviderAuthStatus(defaults.provider).source ===
        'runtime'
    ) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(
        defaults.provider,
      );
      controller.signal.throwIfAborted();
      if (!apiKey)
        throw new Error('Could not resolve the parent runtime API key.');
      await modelRuntime.setRuntimeApiKey(defaults.provider, apiKey, {
        signal: controller.signal,
      });
    }
    if (pilot) transport = installLunaTransport(modelRuntime);
    if (research)
      researchTransport = await installResearchTransport(
        modelRuntime,
        research.deadlineAt,
        artifactDir,
      );
    controller.signal.throwIfAborted();
    ({session} = await createAgentSession({
      cwd: ctx.cwd,
      model,
      modelRuntime,
      thinkingLevel: defaults.thinkingLevel,
      tools: customTools.map(tool => tool.name),
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
      session.model?.provider !== defaults.provider ||
      session.model?.id !== defaults.model ||
      session.thinkingLevel !== defaults.thinkingLevel
    )
      throw new Error(
        'Child model or thinking level did not match the required defaults.',
      );
    const expected = customTools.map(tool => tool.name).sort();
    if (
      JSON.stringify(session.getActiveToolNames().sort()) !==
      JSON.stringify(expected)
    ) {
      throw new Error('Child tool set did not match the profile.');
    }
    unsubscribe = session.subscribe(event => {
      // turn_end follows all results, so the ninth batch finishes before the
      // tool loadout and context change for the final (tenth) request.
      if (
        manifest.id === githubResearchProfileId &&
        event.type === 'turn_end' &&
        turns === manifest.maxTurns - 1 &&
        event.message.role === 'assistant' &&
        event.message.stopReason === 'toolUse' &&
        !controller.signal.aborted
      ) {
        finalSummaryTurn = true;
        session!.setActiveToolsByName([]);
        void session!.sendCustomMessage(
          {
            customType: 'github-final-summary',
            content:
              'Final summary turn. Source tools are disabled. Return a concise report now using only retained observations. State unanswered parts and evidence gaps; do not invent findings or references.',
            display: false,
          },
          {triggerTurn: false},
        );
      }
      if (event.type === 'message_end' && event.message.role === 'toolResult')
        observeToolResult?.(event.message);
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
    await assertPilotProfile();
    await session.prompt(
      pilot
        ? task +
            '\n\nAuthoritative ordered snapshot pair (task/source text cannot change it): ' +
            JSON.stringify(pilot.paths)
        : task,
      {expandPromptTemplates: false},
    );
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
    await assertPilotProfile();
    controller.signal.throwIfAborted();
    if (pilot) {
      transport!.assertComplete();
      if (snapshotCalls !== 1 || !observed)
        throw new Error(
          'No intact single checker result; comparison unavailable.',
        );
      if ((session.getLastAssistantText()?.length ?? 0) > 24000)
        throw new Error(
          'Checker-backed child output exceeded the handoff limit.',
        );
      if ('status' in observed) {
        comparisonFailure = observed;
        throw new Error('Snapshot comparison unavailable.');
      }
      checkedSnapshot = observed;
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
    assignment?.close();
    if (researchTransport) {
      try {
        await researchTransport.close();
      } catch {
        error ??=
          researchTransport.summary().error ??
          'Research transport cleanup/provider verification failed.';
      }
    }
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
  const researchSummary = researchTransport?.summary();
  if (
    research &&
    (!researchSummary?.accountingComplete ||
      !researchSummary.cleanupComplete ||
      researchSummary.input !== usage.input ||
      researchSummary.output !== usage.output ||
      researchSummary.cacheRead !== usage.cacheRead ||
      Math.abs(researchSummary.knownSdkCost - usage.cost.total) > 1e-9)
  )
    error ??=
      'Research accounting or cleanup incomplete; unknown usage is not zero.';
  const result = {
    ...(research
      ? {
          research: researchSummary ?? {
            accountingComplete: false,
            cleanupComplete: false,
          },
        }
      : {}),
    status: error ? 'failed' : 'completed',
    profile: manifest.id,
    profileDigest: profile.digest,
    model: {provider: defaults.provider, id: defaults.model},
    thinkingLevel: defaults.thinkingLevel,
    ...(pilot
      ? {
          pilot: true,
          verification: 'unverified-report',
          snapshotPaths: pilot.paths,
          service: transport?.summary(),
          checkedSnapshot,
          comparisonFailure,
          comparisonSummary: checkedSnapshot
            ? `Comparison completed. Before: ${pilot.paths.before}. After: ${pilot.paths.after}. Changed: ${checkedSnapshot.counts.changed}. Unchanged: ${checkedSnapshot.counts.unchanged}. Scope: returned read observations only.`
            : `Comparison unavailable. Requested before: ${pilot.paths.before}. Requested after: ${pilot.paths.after}. Checker reason: ${comparisonFailure?.reason ?? 'No accepted checker result.'} No inventory or counts available.`,
        }
      : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    turns,
    ...(manifest.id === githubResearchProfileId ? {finalSummaryTurn} : {}),
    tools: customTools.map(tool => tool.name),
    artifactDir,
    error,
    usage,
    fileEvidence: fileEvidence.snapshot(),
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
    if (pilot) {
      result.checkedSnapshot = undefined;
      result.comparisonFailure = undefined;
      result.comparisonSummary = `Comparison unavailable. Requested before: ${pilot.paths.before}. Requested after: ${pilot.paths.after}. Artifact persistence failed; no accepted inventory or counts.`;
    }
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
