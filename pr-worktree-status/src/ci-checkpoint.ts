import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';

type Target = {
  repository: string;
  runId: string;
  deadline: string;
};

type Run = {
  status: string;
  conclusion: string;
  url: string;
  attempt: number;
};

type CiCheckpoint =
  | {kind: 'deadline-reached'; checkpoint: Target}
  | {kind: 'unavailable'; checkpoint: Target; message: string}
  | {
      kind: 'completed' | 'pending';
      checkpoint: Target;
      observedAt: string;
      run: Run;
    };

export async function readCiCheckpoint(
  target: Target,
  exec: ExtensionAPI['exec'],
  cwd: string,
  signal?: AbortSignal,
  now = () => new Date(),
): Promise<CiCheckpoint> {
  const {repository, runId, deadline} = target;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[1-9]\d*$/.test(runId)
  ) {
    throw new Error('Use a GitHub owner/repo and a numeric Actions run ID.');
  }
  const deadlineMs = Date.parse(deadline);
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(deadline) || !Number.isFinite(deadlineMs)) {
    throw new Error('Use an absolute ISO 8601 deadline with a timezone.');
  }
  const remaining = deadlineMs - now().getTime();
  if (remaining <= 0) return {kind: 'deadline-reached', checkpoint: target};

  try {
    const result = await exec(
      'gh',
      [
        'run',
        'view',
        runId,
        '--repo',
        repository,
        '--json',
        'status,conclusion,url,attempt',
      ],
      {
        cwd,
        signal,
        timeout: Math.min(10_000, remaining),
      },
    );
    signal?.throwIfAborted();
    if (result.code !== 0)
      return {
        kind: 'unavailable',
        checkpoint: target,
        message: (result.stderr || 'gh run view failed')
          .trim()
          .split('\n')[0]
          .slice(0, 240),
      };
    const run: Partial<Run> | null = JSON.parse(result.stdout);
    if (
      !run ||
      typeof run.status !== 'string' ||
      !run.status ||
      typeof run.conclusion !== 'string' ||
      typeof run.url !== 'string' ||
      typeof run.attempt !== 'number'
    ) {
      return {
        kind: 'unavailable',
        checkpoint: target,
        message: 'GitHub did not return a complete Actions run record.',
      };
    }
    return {
      kind: run.status === 'completed' ? 'completed' : 'pending',
      checkpoint: target,
      observedAt: now().toISOString(),
      run: {
        status: run.status,
        conclusion: run.conclusion,
        url: run.url,
        attempt: run.attempt,
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      kind: 'unavailable',
      checkpoint: target,
      message:
        error instanceof SyntaxError
          ? 'GitHub CLI did not return valid JSON.'
          : 'GitHub CLI could not be executed.',
    };
  }
}

export function registerCiCheckpoint(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'github_ci_run_checkpoint',
    label: 'GitHub CI Run Checkpoint',
    description:
      'Read one GitHub Actions run without waiting. Preserve the returned checkpoint (repository, runId and original deadline) for a later check.',
    promptSnippet:
      'Check a known GitHub Actions run once instead of blocking on gh run watch.',
    promptGuidelines: [
      'Return a pending checkpoint to the user or use a subsequent authorized poll with the same deadline. Never busy-loop or reset the deadline. Only kind=completed is evidence of completion; inspect the conclusion.',
    ],
    parameters: Type.Object({
      repository: Type.String(),
      runId: Type.String(),
      deadline: Type.String(),
    }),
    outputSchema: Type.Object({
      kind: Type.Union([
        Type.Literal('deadline-reached'),
        Type.Literal('unavailable'),
        Type.Literal('completed'),
        Type.Literal('pending'),
      ]),
      checkpoint: Type.Object({
        repository: Type.String(),
        runId: Type.String(),
        deadline: Type.String(),
      }),
      observedAt: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      run: Type.Optional(
        Type.Object({
          status: Type.String(),
          conclusion: Type.String(),
          url: Type.String(),
          attempt: Type.Number(),
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const checkpoint = await readCiCheckpoint(
        params,
        pi.exec,
        ctx.cwd,
        signal,
      );
      return {
        content: [{type: 'text', text: JSON.stringify(checkpoint)}],
        details: checkpoint,
        structuredContent: checkpoint,
      };
    },
  });
}
