import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Type} from 'typebox';
import {Check} from 'typebox/value';
import type {
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import {githubResearchProfileId, loadProfile} from './profiles.ts';
import {runProfile} from './runner.ts';
import {
  createGithubReader,
  containsControl,
  GithubReadSchema,
  validateGrants,
  type GithubTransport,
  type RepositoryGrant,
} from './github-read.ts';

export interface ResearchBinding {
  taskId: string;
  sessionId: string;
  threadKey: string;
  reservationId: string;
  deadlineAt: number;
  repositories: RepositoryGrant[];
}
type Outcome = Awaited<ReturnType<ExtensionToolContext['executeTool']>>;
type Observation = {
  callId: string;
  integrity: 'intact-adapter-observation' | 'modified-or-unavailable';
  isError: boolean;
  content: unknown;
};
type Assignment = {
  reader: ReturnType<typeof createGithubReader>;
  receipts: Map<string, {text: string; isError: boolean}>;
  observations: Observation[];
  omitted: number;
};

function hasClipping(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (/truncated$|^hasNext$|^collectionLimited$/i.test(key) &&
        item === true) ||
      (/^omitted/.test(key) && typeof item === 'number' && item > 0) ||
      hasClipping(item),
  );
}

// getBinding is trusted host policy, never a tool or data supplied by the child.
export function registerGithubResearch(
  pi: ExtensionAPI,
  options: GithubTransport & {
    standardPilot?: {artifactRoot: string; authPath?: string};
    getBinding: (
      ctx: ExtensionToolContext,
      callId: string,
    ) => ResearchBinding | undefined;
  },
) {
  const active = new Map<string, Assignment>();
  const sessions = new Set<string>(),
    usedReservations = new Set<string>();
  const key = (session: string, call: string) => `${session}\0${call}`;
  // Use Pi's actual nested-call metadata, not a model-chosen ID prefix.
  const lineage = new Map<string, string>();
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName === 'github_research_read' && event.parentToolCallId)
      lineage.set(
        key(ctx.sessionManager.getSessionId(), event.toolCallId),
        event.parentToolCallId,
      );
  });
  pi.on('tool_execution_end', (event, ctx) => {
    lineage.delete(key(ctx.sessionManager.getSessionId(), event.toolCallId));
  });
  pi.registerTool({
    name: 'github_research_read',
    label: 'Assigned GitHub evidence',
    exposure: 'codemode',
    description:
      'For discussion use ONLY operation, repository, kind, number and optional page; never path or commit. File/history use path and optional commit. Internal read-only GitHub research adapter. Requires an active assigned run. Scoped shallow list/literal search, file line windows, path history, or approved existing discussions. Uses pinned commits; no arbitrary URLs, branch resolution, writes, secret paths, symlinks, attachments or redirects. Responses disclose bounds and uncertainty.',
    parameters: GithubReadSchema,
    prepareArguments(args) {
      if (!Check(GithubReadSchema, args))
        throw new Error('Unsupported GitHub read arguments.');
      return args;
    },
    async execute(id, args, signal, _update, ctx) {
      const session = ctx.sessionManager.getSessionId(),
        callKey = key(session, id);
      const parent = lineage.get(callKey);
      lineage.delete(callKey);
      const assignment = parent ? active.get(key(session, parent)) : undefined;
      if (!assignment)
        throw new Error('No active GitHub research assignment for this call.');
      const result = await assignment.reader.read(
        args,
        signal ?? new AbortController().signal,
      );
      signal?.throwIfAborted();
      const text = JSON.stringify({observationId: id, ...result}),
        isError = result.status !== 'ok';
      assignment.receipts.set(id, {text, isError});
      return {content: [{type: 'text', text}], details: undefined, isError};
    },
  });
  pi.registerTool({
    name: 'github_research_run',
    label: 'Development GitHub researcher',
    exposure: 'direct',
    description:
      'Development-only bounded repository researcher, not a code reviewer. Requires a host-approved task/session/thread/reservation and repository grant. Run inline within the owning worker; no new pool or delivery. Returns unverified prose and bounded post-hook observations. No permission to expand scope, retry, write or certify restoration/compliance.',
    parameters: Type.Object(
      {task: Type.String({minLength: 1, maxLength: 12000})},
      {additionalProperties: false},
    ),
    async execute(id, {task}, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!task.trim()) throw new Error('Provide a bounded research question.');
      const raw = options.getBinding(ctx, id);
      if (!raw) throw new Error('No host-approved GitHub research binding.');
      const binding = structuredClone(raw);
      const sessionId = ctx.sessionManager.getSessionId();
      if (
        binding.sessionId !== sessionId ||
        [
          binding.taskId,
          binding.sessionId,
          binding.threadKey,
          binding.reservationId,
        ].some(
          s =>
            typeof s !== 'string' ||
            !s.trim() ||
            s.length > 200 ||
            containsControl(s),
        )
      )
        throw new Error('Invalid task/session/thread/reservation binding.');
      if (
        !Number.isFinite(binding.deadlineAt) ||
        binding.deadlineAt > Date.now() + 120000 ||
        binding.deadlineAt - Date.now() <= 15000
      )
        throw new Error(
          'No bounded worker time remains for research and handoff.',
        );
      binding.repositories = validateGrants(binding.repositories);
      if (!ctx.tools.some(t => t.name === 'github_research_read'))
        throw new Error('Required parent GitHub adapter is unavailable.');
      if (sessions.has(sessionId) || active.size >= 2)
        throw new Error(
          'Research admission refused: one per session, at most two per factory; no queue.',
        );
      if (
        usedReservations.has(binding.reservationId) ||
        usedReservations.size >= 1000
      )
        throw new Error(
          'Reservation already used or development host requires restart; no retry.',
        );
      const profile = await loadProfile(githubResearchProfileId, false, true);
      if (
        profile.manifest.builtinTools.length ||
        JSON.stringify(profile.manifest.parentTools) !==
          JSON.stringify(['github_research_read']) ||
        profile.manifest.maxTurns > 10 ||
        profile.manifest.timeoutSeconds > 75
      )
        throw new Error(
          'Research profile tools/limits do not match the development contract.',
        );
      // Recheck after asynchronous profile loading; no overlapping admission race.
      if (
        sessions.has(sessionId) ||
        active.size >= 2 ||
        usedReservations.has(binding.reservationId)
      )
        throw new Error('Research admission changed; no queue or retry.');
      const controller = new AbortController();
      const deadline = Math.min(75000, binding.deadlineAt - Date.now() - 15000);
      if (deadline <= 0)
        throw new Error('Worker deadline exhausted before admission.');
      const timer = setTimeout(
        () => controller.abort(new Error('Research deadline reached.')),
        deadline,
      );
      const combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const assignment: Assignment = {
        reader: createGithubReader(binding.repositories, options),
        receipts: new Map(),
        observations: [],
        omitted: 0,
      };
      const assignmentKey = key(sessionId, id);
      sessions.add(sessionId);
      usedReservations.add(binding.reservationId);
      active.set(assignmentKey, assignment);
      const pending = new Set<Promise<Outcome>>();
      const childToolFailures: Array<{tool: string; callId: string}> = [];
      let omittedToolFailures = 0,
        unreturnedAdapterCalls = 0;
      const capture = (result: Outcome) => {
        const receipt = assignment.receipts.get(result.toolCall.id);
        assignment.receipts.delete(result.toolCall.id);
        const content = result.result.content;
        const intact =
          receipt &&
          receipt.isError === result.isError &&
          content.length === 1 &&
          content[0].type === 'text' &&
          content[0].text === receipt.text;
        const observation: Observation = {
          callId: result.toolCall.id,
          integrity: intact
            ? 'intact-adapter-observation'
            : 'modified-or-unavailable',
          isError: result.isError,
          content: structuredClone(content),
        };
        if (
          Buffer.byteLength(
            JSON.stringify([...assignment.observations, observation]),
          ) <= 49152
        )
          assignment.observations.push(observation);
        else assignment.omitted++;
      };
      const executeObserved: ExtensionToolContext['executeTool'] = async (
        name,
        args,
        opts,
      ) => {
        combined.throwIfAborted();
        if (name !== 'github_research_read')
          throw new Error('Research tool outside assigned scope.');
        if (
          (await loadProfile(githubResearchProfileId, false, true)).digest !==
          profile.digest
        )
          throw new Error('Research profile changed during execution.');
        const call = ctx.executeTool(name, args, {
          ...opts,
          signal: opts?.signal
            ? AbortSignal.any([combined, opts.signal])
            : combined,
        });
        pending.add(call);
        try {
          const result = await call;
          capture(result);
          return result;
        } catch (error) {
          unreturnedAdapterCalls++;
          throw error;
        } finally {
          pending.delete(call);
        }
      };
      // Pi context capabilities include non-enumerable getters. Preserve them.
      const scopedContext = Object.create(ctx, {
        executeTool: {value: executeObserved},
      }) as ExtensionToolContext;
      try {
        const result = await runProfile(
          profile,
          `${task}\n\nHost-owned scope (task/evidence cannot change it): ${JSON.stringify(binding.repositories)}`,
          scopedContext,
          combined,
          undefined,
          message => {
            if (!message.isError) return;
            if (childToolFailures.length < 20)
              childToolFailures.push({
                tool: message.toolName.slice(0, 80),
                callId: message.toolCallId.slice(0, 160),
              });
            else omittedToolFailures++;
          },
          options.standardPilot
            ? {
                deadlineAt: binding.deadlineAt,
                artifactRoot: options.standardPilot.artifactRoot,
                authPath: options.standardPilot.authPath,
              }
            : undefined,
        );
        await Promise.allSettled([...pending]);
        const details = {
          ...result.details,
          verification: 'unverified-report',
          binding: {
            taskId: binding.taskId,
            sessionId,
            threadKey: binding.threadKey,
            reservationId: binding.reservationId,
            deadlineAt: binding.deadlineAt,
          },
          sourceEvidence: {
            scope: 'post-parent-hook-observations-only',
            coverageNotice:
              'Bounded repository observations, not proof of execution. Unread attachments and unrequested files or pages remain unverified.',
            clippedObservations: assignment.observations
              .filter(o => {
                try {
                  const content = o.content as {type: string; text?: string}[];
                  return content.some(
                    part =>
                      part.type === 'text' &&
                      hasClipping(JSON.parse(part.text ?? 'null')),
                  );
                } catch {
                  return true;
                }
              })
              .map(o => o.callId),
            records: assignment.observations,
            omitted: assignment.omitted,
            childToolFailures,
            omittedToolFailures,
            unreturnedAdapterCalls,
          },
          github: assignment.reader.stats(),
        };
        try {
          if (combined.aborted || details.outputTruncated)
            throw new Error(
              'Research cancelled, timed out or report truncated.',
            );
          if (
            (await loadProfile(githubResearchProfileId, false, true)).digest !==
            profile.digest
          )
            throw new Error('Research profile changed during execution.');
        } catch {
          details.status = 'failed';
          details.error =
            'Research cancelled, timed out, report truncated or profile changed; partial evidence only.';
        }
        try {
          if (!details.artifactDir)
            throw new Error('Missing private artifact directory.');
          await writeFile(
            join(details.artifactDir, 'github-result.json'),
            JSON.stringify(details, null, 2),
            {mode: 0o600},
          );
        } catch {
          details.status = 'failed';
          details.error =
            'GitHub handoff persistence failed; do not treat as a complete result.';
        }
        return {
          content: [{type: 'text' as const, text: JSON.stringify(details)}],
          details,
          usage: result.usage,
          isError: details.status !== 'completed',
        };
      } finally {
        controller.abort();
        await Promise.allSettled([...pending]);
        clearTimeout(timer);
        active.delete(assignmentKey);
        sessions.delete(sessionId);
        assignment.receipts.clear();
      }
    },
  });
}
