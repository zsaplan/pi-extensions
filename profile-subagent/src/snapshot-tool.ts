import {resolve} from 'node:path';
import {Type} from 'typebox';
import type {
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import {compareSnapshots, type SnapshotReport} from './json-snapshots.ts';

export const SnapshotPathsSchema = Type.Object(
  {
    before: Type.String({minLength: 1, maxLength: 4096}),
    after: Type.String({minLength: 1, maxLength: 4096}),
  },
  {additionalProperties: false},
);
export type SnapshotPaths = {before: string; after: string};
export type SnapshotFailure = {
  status: 'unavailable';
  scope: 'returned-read-observations-only';
  paths: SnapshotPaths;
  reason: string;
};
export type SnapshotOutcome = SnapshotReport | SnapshotFailure;
export function resolveSnapshotPaths(
  paths: SnapshotPaths,
  cwd: string,
): SnapshotPaths {
  const pair = {
    before: resolve(cwd, paths.before),
    after: resolve(cwd, paths.after),
  };
  if (pair.before === pair.after)
    throw new Error('Use two distinct snapshot paths.');
  return pair;
}
// Only checker-owned fixed messages can be attested. Never echo arbitrary tool
// exceptions (which can contain secrets, source text or policy-redacted details).
const reasons = new Set([
  'Snapshot exceeds 32 KiB.',
  'Snapshot is not strict JSON.',
  'Snapshot root must be an object.',
  'Snapshot depth/node limit exceeded.',
  'Duplicate decoded object key.',
  'Only safe integer literals are supported.',
  'Snapshot inventory metadata/coverage mismatch.',
  'Snapshot inventory value, pointer, span or duplicate mismatch.',
  'Snapshot inventory hash/coverage mismatch.',
  'Snapshot report exceeds 16 KiB; no complete report returned.',
]);
type ToolOutcome = Awaited<ReturnType<ExtensionToolContext['executeTool']>>;
type Receipt = {call: string; text: string; failed: boolean};
type Assignment = {paths: SnapshotPaths; attempts: number; receipt?: Receipt};

// One registry per loaded extension, shared by its runner and registered tool.
// No process-global recovery of results, no credentials, no host sandbox claim.
export function createSnapshotChecker(pi: ExtensionAPI) {
  const assignments = new Map<string, Assignment>();
  const key = (session: string, call: string) => `${session}\0${call}`;
  let registered = false;
  return {
    begin(session: string, call: string, paths: SnapshotPaths) {
      const id = key(session, call);
      if (assignments.has(id))
        throw new Error('Snapshot assignment already active.');
      const assignment: Assignment = {paths, attempts: 0};
      assignments.set(id, assignment);
      return {
        take(result: ToolOutcome): SnapshotOutcome | undefined {
          const receipt = assignment.receipt;
          delete assignment.receipt;
          const content = result.result.content;
          if (
            assignments.get(id) !== assignment ||
            !receipt ||
            receipt.call !== result.toolCall.id ||
            receipt.failed !== result.isError ||
            content.length !== 1 ||
            content[0].type !== 'text' ||
            content[0].text !== receipt.text
          )
            return undefined;
          return JSON.parse(receipt.text) as SnapshotOutcome;
        },
        close() {
          if (assignments.get(id) === assignment) assignments.delete(id);
        },
      };
    },
    register() {
      if (registered) return;
      registered = true;
      pi.registerTool({
        name: 'compare_json_snapshots',
        label: 'Internal checked-pilot comparison',
        exposure: 'codemode',
        description:
          'Internal checker for configuration-checked-reviewer. Requires an active assigned specialist call and its exact ordered snapshot pair; direct use is rejected. Strict bounded JSON object observations, safe integer literals, positional arrays. Returned observations do not establish physical provenance, freshness or impact.',
        parameters: SnapshotPathsSchema,
        async execute(id, args, signal, _update, ctx) {
          signal?.throwIfAborted();
          const parent = id.slice(0, id.lastIndexOf('/'));
          const assignment = assignments.get(
            key(ctx.sessionManager.getSessionId(), parent),
          );
          if (!assignment || ++assignment.attempts !== 1)
            throw new Error(
              'No unused active snapshot assignment for this call.',
            );
          const paths = resolveSnapshotPaths(args, ctx.cwd);
          if (
            paths.before !== assignment.paths.before ||
            paths.after !== assignment.paths.after
          )
            throw new Error(
              'Snapshot paths do not match the assigned ordered pair.',
            );
          const observe = async (side: 'before' | 'after') => {
            let result: ToolOutcome;
            try {
              result = await ctx.executeTool(
                'read',
                {path: paths[side]},
                {signal},
              );
            } catch {
              return {
                reason: `${side} snapshot read unavailable; expected one complete text observation.`,
              };
            }
            const content = result.result.content;
            if (
              result.isError ||
              content.length !== 1 ||
              content[0].type !== 'text'
            )
              return {
                reason: `${side} snapshot read unavailable; expected one complete text observation.`,
              };
            const details = result.result.details as
              | {truncation?: {truncated?: boolean}}
              | undefined;
            if (details?.truncation?.truncated)
              return {reason: `${side} snapshot observation was truncated.`};
            return {text: content[0].text};
          };
          const [before, after] = await Promise.all([
            observe('before'),
            observe('after'),
          ]);
          signal?.throwIfAborted();
          let reason = before.reason ?? after.reason;
          let report: SnapshotReport | undefined;
          if (!reason) {
            try {
              report = compareSnapshots(
                before.text!,
                after.text!,
                paths.before,
                paths.after,
              );
            } catch (error) {
              reason =
                error instanceof Error && reasons.has(error.message)
                  ? error.message
                  : 'Snapshot comparison unavailable.';
            }
          }
          const outcome: SnapshotOutcome = report ?? {
            status: 'unavailable',
            scope: 'returned-read-observations-only',
            paths,
            reason: reason ?? 'Snapshot comparison unavailable.',
          };
          const text = JSON.stringify(outcome),
            failed = !report;
          assignment.receipt = {call: id, text, failed};
          return {
            content: [{type: 'text' as const, text}],
            details: undefined,
            isError: failed,
          };
        },
      });
      pi.on('session_shutdown', (_event, ctx) => {
        const prefix = `${ctx.sessionManager.getSessionId()}\0`;
        for (const id of assignments.keys())
          if (id.startsWith(prefix)) assignments.delete(id);
      });
    },
  };
}
export type SnapshotChecker = ReturnType<typeof createSnapshotChecker>;
