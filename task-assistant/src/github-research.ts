import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionToolContext,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  absent,
  atomicJson,
  digest,
  record,
  StoreError,
  type TaskStore,
  type Task,
} from './store.ts';
import {isOwnerThreadReply} from './owner-references.ts';
import type {Receipt} from './intake.ts';

type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;
interface Binding {
  taskId: string;
  sessionId: string;
  threadKey: string;
  reservationId: string;
  deadlineAt: number;
}
interface ResearchModule {
  registerGithubResearch(
    pi: ExtensionAPI,
    options: {
      token(): Promise<string>;
      standardPilot: {artifactRoot: string; authPath: string};
      getBinding(
        ctx: ExtensionToolContext,
        callId: string,
      ): Binding | undefined;
    },
  ): void;
}
interface Manifest {
  schema_version: 1;
  root: string;
  package_dir: string;
  profile_digest: string;
  files: Record<string, string>;
  dependency_lock: {file: string; hash: string};
  auth_path: string;
}

const hashPattern = /^[a-f0-9]{64}$/;
async function privateText(file: string, maxBytes = 2 * 1024 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.mode & 0o077 || info.size > maxBytes)
    throw new StoreError('invalid_research_file');
  return readFile(file, 'utf8');
}

// One inline native researcher, inside the existing worker slots/deadlines.
// Waiting does not create a task, worker, model reservation or fresh timeout.
let occupied: Promise<void> | undefined;
async function acquire(signal: AbortSignal) {
  while (occupied) {
    const current = occupied;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new StoreError('research_cancelled'));
      signal.addEventListener('abort', abort, {once: true});
      void current
        .then(resolve)
        .finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  signal.throwIfAborted();
  let release!: () => void;
  const mine = new Promise<void>(resolve => {
    release = resolve;
  });
  occupied = mine;
  return () => {
    if (occupied === mine) occupied = undefined;
    release();
  };
}

export class TaskGithubResearch {
  private constructor(
    private readonly store: TaskStore,
    private readonly manifest: Manifest,
    private readonly manifestHash: string,
    private readonly token: string,
    private readonly module: ResearchModule,
  ) {}

  static async open(store: TaskStore, file?: string) {
    if (!file) {
      try {
        await lstat(path.join(store.root, 'intake', 'github-research.json'));
      } catch (error) {
        if (absent(error)) return;
        throw error;
      }
      throw new StoreError('research_config_required');
    }
    const raw = await privateText(file, 128 * 1024);
    const data = record(JSON.parse(raw));
    if (
      data.schema_version !== 1 ||
      data.root !== store.root ||
      typeof data.package_dir !== 'string' ||
      typeof data.auth_path !== 'string' ||
      typeof data.profile_digest !== 'string' ||
      !hashPattern.test(data.profile_digest)
    )
      throw new StoreError('invalid_research_config');
    const manifest = data as unknown as Manifest;
    const token = (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)?.trim();
    if (!token) throw new StoreError('research_credentials_unavailable');
    const state = new TaskGithubResearch(
      store,
      manifest,
      digest(raw),
      token,
      {} as ResearchModule,
    );
    await state.verify();
    await privateText(manifest.auth_path);
    const scopeFile = path.join(store.root, 'intake', 'github-research.json');
    const scope = {schema_version: 1, manifest_hash: state.manifestHash};
    try {
      if (
        record(JSON.parse(await privateText(scopeFile))).manifest_hash !==
        scope.manifest_hash
      )
        throw new StoreError('research_scope_changed');
    } catch (error) {
      if (!absent(error)) throw error;
      await atomicJson(scopeFile, scope);
    }
    const module = (await import(
      pathToFileURL(path.join(manifest.package_dir, 'dist/github-research.js'))
        .href
    )) as ResearchModule;
    if (typeof module.registerGithubResearch !== 'function')
      throw new StoreError('research_extension_unavailable');
    return new TaskGithubResearch(
      store,
      manifest,
      state.manifestHash,
      token,
      module,
    );
  }

  private async verify() {
    const config = this.manifest;
    if (
      !path.isAbsolute(config.package_dir) ||
      (await realpath(config.package_dir)) !== config.package_dir
    )
      throw new StoreError('invalid_research_package');
    const files = record(config.files);
    if (
      !files['package.json'] ||
      !files['dist/github-research.js'] ||
      !files['dist/profiles.js'] ||
      !files['profiles/github-researcher/AGENTS.md'] ||
      Object.keys(files).length > 1000
    )
      throw new StoreError('invalid_research_package');
    for (const file of await readdir(path.join(config.package_dir, 'dist'))) {
      if (file.endsWith('.js') && !files[`dist/${file}`])
        throw new StoreError('invalid_research_package');
    }
    for (const [file, hash] of Object.entries(files)) {
      if (
        (file !== 'package.json' &&
          !/^(dist|profiles)\/[A-Za-z0-9_./-]+$/.test(file)) ||
        file.split('/').includes('..') ||
        typeof hash !== 'string' ||
        !hashPattern.test(hash)
      )
        throw new StoreError('invalid_research_package');
      const target = path.join(config.package_dir, file);
      if (
        !(await lstat(target)).isFile() ||
        digest(await readFile(target, 'utf8')) !== hash
      )
        throw new StoreError('research_package_changed');
    }
    const lock = record(config.dependency_lock);
    if (
      typeof lock.file !== 'string' ||
      !path.isAbsolute(lock.file) ||
      typeof lock.hash !== 'string' ||
      !hashPattern.test(lock.hash) ||
      digest(await readFile(lock.file, 'utf8')) !== lock.hash
    )
      throw new StoreError('research_dependencies_changed');
    const {loadProfile} = (await import(
      pathToFileURL(path.join(config.package_dir, 'dist/profiles.js')).href
    )) as {
      loadProfile(
        id: string,
        checked: boolean,
        github: boolean,
      ): Promise<{digest: string}>;
    };
    if (
      (await loadProfile('github-researcher', false, true)).digest !==
      config.profile_digest
    )
      throw new StoreError('research_profile_changed');
  }

  forTask(
    task: Task,
    observed: Receipt[],
    deadlineAt: number,
    reservationId: string,
  ) {
    if (!task.session.id || !task.slack.parent_ts || !reservationId)
      throw new StoreError('research_task_thread_required');
    const owners = observed
      .filter(
        r =>
          r.task_id === task.id &&
          r.disposition === 'routed' &&
          r.content_source === 'conversation' &&
          isOwnerThreadReply(task, r),
      )
      .sort(
        (a, b) => Number(a.source.message_ts) - Number(b.source.message_ts),
      );
    const owner = owners.at(-1);
    const context = digest(
      JSON.stringify({
        task: task.id,
        owner: owner ? [owner.id, owner.content_hash] : 'initial',
      }),
    );
    const directory = path.join(
      this.store.root,
      'runs',
      'github-research',
      task.id,
    );
    const admissionFile = path.join(directory, context + '.json');
    const resultFile = path.join(directory, context + '-result.json');
    const binding: Binding = {
      taskId: task.id,
      sessionId: task.session.id!,
      threadKey: `${task.inbox.workspace_id}:${task.inbox.channel_id}:${task.slack.parent_ts}`,
      reservationId,
      deadlineAt,
    };
    const activity = {active: 0, generation: 0};
    const bindings = new Map<string, Binding>();
    const replay = async (): Promise<ToolResult | undefined> => {
      let admission;
      try {
        admission = record(JSON.parse(await privateText(admissionFile)));
      } catch (error) {
        if (absent(error)) return;
        throw error;
      }
      if (
        admission.session_id !== binding.sessionId ||
        admission.context !== context ||
        admission.manifest_hash !== this.manifestHash
      )
        throw new StoreError('research_admission_changed');
      if (admission.state !== 'settled')
        throw new StoreError('research_already_admitted_no_retry');
      const raw = await privateText(resultFile);
      if (digest(raw) !== admission.result_hash)
        throw new StoreError('research_result_changed');
      const saved = JSON.parse(raw) as ToolResult;
      // Original result remains immutable. Cached retrieval is not new child usage.
      return {
        ...saved,
        usage: undefined,
        content: [
          {
            type: 'text',
            text:
              'Recorded research for this owner context, NOT a fresh check. Original question: ' +
              String(admission.question) +
              '\n',
          },
          ...saved.content,
        ],
      };
    };
    const factory: ExtensionFactory = pi => {
      const host = Object.create(pi, {
        registerTool: {
          value: (definition: ToolDefinition) => {
            if (definition.name !== 'github_research_run')
              return pi.registerTool(definition);
            pi.registerTool({
              ...definition,
              execute: async (id, args, signal, update, ctx) => {
                activity.active++;
                let release: (() => void) | undefined;
                try {
                  if (
                    ctx.sessionManager.getSessionId() !== binding.sessionId ||
                    !task.claim_id
                  )
                    throw new StoreError('research_binding_changed');
                  const current = await this.store.locate(task.id);
                  if (
                    current.status !== 'active' ||
                    current.task.claim_id !== task.claim_id
                  )
                    throw new StoreError('research_binding_changed');
                  await this.verify();
                  const prior = await replay();
                  if (prior) return prior;
                  const remaining = deadlineAt - Date.now() - 15000;
                  if (remaining <= 0)
                    throw new StoreError('research_deadline_exhausted');
                  const bounded = AbortSignal.any([
                    ...(signal ? [signal] : []),
                    AbortSignal.timeout(remaining),
                  ]);
                  release = await acquire(bounded);
                  const afterWait = await replay();
                  if (afterWait) return afterWait;
                  bounded.throwIfAborted();
                  this.store.assertOwner();
                  await mkdir(directory, {recursive: true, mode: 0o700});
                  const admission = {
                    schema_version: 1,
                    state: 'admitted',
                    context,
                    task_id: task.id,
                    session_id: binding.sessionId,
                    claim_id: task.claim_id,
                    binding,
                    manifest_hash: this.manifestHash,
                    question: record(args).task,
                    admitted_at: new Date().toISOString(),
                  };
                  await writeFile(
                    admissionFile,
                    JSON.stringify(admission) + '\n',
                    {flag: 'wx', mode: 0o600},
                  );
                  bindings.set(id, binding);
                  // Still the registered extension tool, with normal SDK hooks/lineage.
                  const result = await definition.execute(
                    id,
                    args,
                    signal,
                    update,
                    ctx,
                  );
                  const raw = JSON.stringify(result);
                  this.store.assertOwner();
                  await writeFile(resultFile, raw, {flag: 'wx', mode: 0o600});
                  await atomicJson(admissionFile, {
                    ...admission,
                    state: 'settled',
                    result_hash: digest(raw),
                    settled_at: new Date().toISOString(),
                  });
                  return result;
                } finally {
                  bindings.delete(id);
                  release?.();
                  activity.active--;
                  activity.generation++;
                }
              },
            });
          },
        },
      }) as ExtensionAPI;
      this.module.registerGithubResearch(host, {
        token: async () => this.token,
        standardPilot: {
          artifactRoot: path.join(directory, 'artifacts'),
          authPath: this.manifest.auth_path,
        },
        getBinding: (ctx, id) =>
          ctx.sessionManager.getSessionId() === binding.sessionId
            ? bindings.get(id)
            : undefined,
      });
    };
    return {factory, activity};
  }
}

export async function researchResourceLoader(
  base: ResourceLoader,
  cwd: string,
  factory: ExtensionFactory,
): Promise<ResourceLoader> {
  const extensionLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({packages: [], extensions: []}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory],
  });
  await extensionLoader.reload();
  const extensions = extensionLoader.getExtensions();
  if (extensions.errors.length)
    throw new StoreError('research_extension_unavailable');
  return {
    ...base,
    getExtensions: () => extensions,
    getSystemPrompt: () =>
      (base.getSystemPrompt() ?? '') + '\n' + RESEARCH_GUIDANCE,
  };
}

export const RESEARCH_GUIDANCE =
  'GitHub repository research is available through github_research_run. github_research_read is an internal assigned-child adapter; direct calls are refused. Use it for a complete bounded investigation when repository evidence can answer the task; give the question and available repository/path/ref leads, not prior conclusions. Do not ask the owner to fetch material this capability can research. One assignment is allowed per initial or genuine owner task-reply context; source/reviewer updates do not renew it. Recorded results are historical, not fresh checks. Inspect decisive retained evidence and referenceValidation separately from execution status; use host activitySummary for counts. Keep gaps, clipping and uncertainty. A capability failure is an assistant limitation, not evidence that files are absent or a request for the owner to do the investigation. Do not start another assignment to work around a failed/partial result. Wait for research results and review them before finish_task. The researcher cannot post, perform code reviews, write to systems or certify an operational outcome. You own the existing task and concise Slack reply.';
