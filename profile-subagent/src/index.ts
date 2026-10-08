import {Type} from 'typebox';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {listProfiles, loadProfile} from './profiles.ts';
import {runProfile} from './runner.ts';
import {parentDelegationGuidance} from './guidance.ts';
import {maxConcurrentRuns, RunQueue} from './run-queue.ts';
import {
  SearchSchema,
  searchProfiles,
  prepareSearchArguments,
} from './search.ts';

export default function (pi: ExtensionAPI) {
  const runs = new RunQueue();
  // Codemode can finish before cancelled children; drain descendants before
  // Pi snapshots their final status and usage.
  const pending = new Map<string, {done: Promise<void>; finish: () => void}>();
  pi.on('tool_execution_start', event => {
    if (event.toolName !== 'profile_subagent_run' || !event.parentToolCallId)
      return;
    let finish!: () => void;
    const done = new Promise<void>(resolve => {
      finish = resolve;
    });
    pending.set(event.toolCallId, {done, finish});
  });
  pi.on('tool_execution_end', event => {
    const run = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    run?.finish();
  });
  pi.on('tool_result', async event => {
    // Pi assigns nested IDs as <parent id>/<n>; exclude the call itself.
    await Promise.all(
      [...pending]
        .filter(([id]) => id.startsWith(`${event.toolCallId}/`))
        .map(([, run]) => run.done),
    );
  });
  pi.registerTool({
    name: 'profile_subagent_search',
    label: 'Find a narrow specialist',
    description:
      'Search trusted bundled specialists by task, without knowing a profile ID. Returns bounded metadata, matches, source/digest, and currently unavailable required tools. Search does not launch agents or verify connectivity. Search for work worth delegating, not for every task; simple bounded checks can stay with the parent. Select only a role that fits the task and has its required tools. Scores/matches are not confidence or permission. Ask for missing scope when ambiguous; do not delegate unsupported work or use an unrestricted fallback.',
    parameters: SearchSchema,
    // Validate before Pi's integer coercion can silently truncate fractional limits.
    prepareArguments: prepareSearchArguments,
    async execute(_id, {query, limit}, _signal, _onUpdate, ctx) {
      const details = await searchProfiles(
        query,
        limit,
        ctx.tools.map(tool => tool.name),
      );
      return {
        content: [{type: 'text', text: JSON.stringify(details)}],
        details,
      };
    },
  });
  pi.registerTool({
    name: 'profile_subagent_list',
    label: 'List narrow subagent profiles',
    description:
      'List the bundled subagent profiles, exact tools, resource paths, limits, and content hashes. Does not start an agent.',
    parameters: Type.Object({}),
    async execute() {
      const profiles = await listProfiles();
      const details = profiles.map(({manifest, digest}) => ({
        ...manifest,
        digest,
      }));
      return {
        content: [{type: 'text', text: JSON.stringify(details, null, 2)}],
        details,
      };
    },
  });
  pi.registerTool({
    name: 'profile_subagent_run',
    label: 'Run narrow subagent',
    exposure: 'direct',
    executionMode: 'parallel',
    description:
      `Callable directly or from parent codemode while enabled. At most ${maxConcurrentRuns} runs execute concurrently per loaded extension; additional calls wait in a cancellable queue. In codemode, await Promise.allSettled for independent assignments, retain failures, and JSON.parse each successful JSON-text result. Do not launch dependent work together. ` +
      parentDelegationGuidance +
      ' ' +
      'Run one fresh specialist by trusted profile ID. Discover a role with profile_subagent_search for a new delegated task; a known role can run directly. Choose only a suitable role with all required tools, clarify insufficient scope, and decline delegation if none fits. Supply a self-contained task, scope, evidence paths and expected outcome. No parent history is inherited. The profile fixes instructions/tools; startup revalidates the current profile and parent capabilities, not a prior search result. Returns bounded output and private evidence paths. Completed means execution finished, not verified correctness, human approval, or authorization for further actions.',
    parameters: Type.Object(
      {
        profile: Type.String({pattern: '^[a-z][a-z0-9-]{0,63}$'}),
        task: Type.String({minLength: 1, maxLength: 30000}),
      },
      {additionalProperties: false},
    ),
    async execute(_id, {profile, task}, signal, _onUpdate, ctx) {
      if (!task.trim()) throw new Error('Provide a nonempty task.');
      return runs.run(
        async () => runProfile(await loadProfile(profile), task, ctx, signal),
        signal,
      );
    },
  });
}
