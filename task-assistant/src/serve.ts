import path from 'node:path';
import {TaskGithubResearch} from './github-research.ts';
import {AutoTrial, requireAutoTrialScope} from './auto-trial.ts';
import {RegularUse} from './regular-use.ts';
import {associatedSources} from './related-work.ts';
import {BACKLOG_THREAD_FEEDS_PER_POLL, modelBudget} from './backlog.ts';
import {requireSessionLibrary} from './owner-references.ts';
import {parseConfig, POLL_INTERVAL_MS} from './config.ts';
import {discoveryOptions, requireDiscoveryOptions} from './discovery.ts';
import {pollOnCadence} from './cadence.ts';
import {pollIntake, receipts, type IntakeReport} from './intake.ts';
import {
  classifyPending,
  scopedTaskIds,
  type TaskScope,
  recoverRuns,
  taskPublication,
  prepareTaskSession,
  type ModelConfig,
} from './worker.ts';
import {options, output, required} from './queue-cli.ts';
import {ReadonlySlackClient, SlackError, transientSlackRead} from './slack.ts';
import {updateJson, atomicJson, StoreError, TaskStore} from './store.ts';
import {TaskMessenger} from './task-slack.ts';
import {capacityPayload} from './slack-payload.ts';
import {runTaskBatch, workerLimit} from './worker-pool.ts';
import {TaskLogFeed, requireLogCapability, type LogScope} from './task-logs.ts';
import {
  TaskInvestigation,
  requireInvestigationCapability,
} from './task-investigation.ts';

export async function serveCommand(args: string[]): Promise<void> {
  const flags = ['--once', '--allow-slack-writes', '--inbox-only'];
  for (const flag of flags)
    if (args.filter(arg => arg === flag).length > 1)
      throw new StoreError('invalid_arguments');
  const values = options(
    args.filter(arg => !flags.includes(arg)),
    [
      '--root',
      '--provider',
      '--model',
      '--agent-dir',
      '--session-library',
      '--conversation',
      '--search-api',
      '--task-id',
      '--task-ids',
      '--discover-tasks',
      '--continue-trial',
      '--regular-use',
      '--backlog-approval',
      '--github-research-config',
      '--exclude-threads',
      '--workers',
      '--mention-group',
      '--watch-channel',
      '--pilot-seconds',
      '--log-site',
      '--log-environment',
      '--site-manifest',
      '--bundle-chart',
    ],
  );
  if (required(values, '--search-api') !== 'legacy')
    throw new StoreError('intake_requires_legacy');
  const discovery = discoveryOptions(values);
  if (
    args.includes('--inbox-only') &&
    (discovery.mentionGroup || discovery.watchChannel)
  )
    throw new StoreError('discovery_requires_full_intake');
  const workers = workerLimit(values.get('--workers'));
  const taskId = values.get('--task-id');
  const taskIds = values.get('--task-ids')?.split(',');
  if (
    taskIds &&
    (taskId ||
      taskIds.length > 3 ||
      new Set(taskIds).size !== taskIds.length ||
      taskIds.some(id => !/^task-[a-f0-9]{32}$/.test(id)))
  )
    throw new StoreError('invalid_task_scope');
  const regularFile = values.get('--regular-use');
  const backlogApproval = values.get('--backlog-approval');
  if (backlogApproval && !regularFile)
    throw new StoreError('backlog_requires_regular_use');
  if (
    regularFile &&
    ([
      '--discover-tasks',
      '--continue-trial',
      '--exclude-threads',
      '--pilot-seconds',
      '--task-id',
      '--task-ids',
      '--log-site',
      '--log-environment',
      '--site-manifest',
      '--bundle-chart',
    ].some(flag => values.has(flag)) ||
      args.includes('--inbox-only') ||
      !args.includes('--allow-slack-writes') ||
      !discovery.mentionGroup ||
      !discovery.watchChannel)
  )
    throw new StoreError('invalid_regular_mode');
  const automatic = values.get('--discover-tasks');
  const continuation = values.get('--continue-trial');
  if (continuation && !automatic)
    throw new StoreError('continuation_requires_auto_trial');
  const exclusionFile = values.get('--exclude-threads');
  if (
    (automatic !== undefined &&
      (!/^[1-3]$/.test(automatic) ||
        taskId ||
        taskIds ||
        !exclusionFile ||
        !discovery.mentionGroup ||
        !discovery.watchChannel ||
        !values.has('--pilot-seconds') ||
        args.includes('--once') ||
        args.includes('--inbox-only') ||
        [
          '--log-site',
          '--log-environment',
          '--site-manifest',
          '--bundle-chart',
        ].some(flag => values.has(flag)))) ||
    (exclusionFile && automatic === undefined)
  )
    throw new StoreError('invalid_auto_trial');
  const selectedIds = taskIds ?? (taskId ? [taskId] : undefined);
  if (selectedIds && !args.includes('--inbox-only'))
    throw new StoreError('task_scope_requires_inbox_only');
  let autoTrial: AutoTrial | undefined;
  let regular: RegularUse | undefined;
  let admission: AutoTrial | RegularUse | undefined;
  const allowed = (id: string) =>
    admission
      ? admission.ids.includes(id)
      : !selectedIds || selectedIds.includes(id);
  if (
    workers === 2 &&
    ([
      '--task-id',
      '--log-site',
      '--log-environment',
      '--site-manifest',
      '--bundle-chart',
    ].some(flag => values.has(flag)) ||
      (values.has('--pilot-seconds') && !taskIds && !automatic))
  )
    throw new StoreError('parallel_scope_unsupported');
  const duration = values.get('--pilot-seconds');
  if (taskIds && !duration && !args.includes('--once'))
    throw new StoreError('task_scope_requires_bounded_run');
  const pilotSeconds = duration === undefined ? undefined : Number(duration);
  if (
    duration !== undefined &&
    (!/^\d+$/.test(duration) ||
      !Number.isInteger(pilotSeconds) ||
      pilotSeconds! < 1 ||
      pilotSeconds! > 600 ||
      (!selectedIds && !automatic) ||
      args.includes('--once'))
  )
    throw new StoreError('invalid_pilot_duration');
  const logSite = values.get('--log-site');
  const logEnvironment = values.get('--log-environment');
  if (
    (logSite || logEnvironment) &&
    (!logSite ||
      !logEnvironment ||
      !taskId ||
      (!duration && !args.includes('--once')))
  )
    throw new StoreError('log_scope_requires_bounded_task_run');
  const manifest = values.get('--site-manifest');
  const chart = values.get('--bundle-chart');
  if ((manifest || chart) && (!manifest || !chart || !logSite))
    throw new StoreError('investigation_requires_log_scope_and_sources');
  const conversation = required(values, '--conversation');
  if (automatic && !/^D[A-Z0-9]+$/.test(conversation))
    throw new StoreError('invalid_auto_trial');
  const config = parseConfig(
    ['preflight', '--search-api', 'legacy', '--conversation', conversation],
    process.env,
  );
  const model: ModelConfig = {
    provider: required(values, '--provider'),
    model: required(values, '--model'),
    agentDir: values.get('--agent-dir'),
    sessionLibrary: values.get('--session-library'),
  };
  const store = await TaskStore.acquire(required(values, '--root'));
  const client = new ReadonlySlackClient(
    {user: config.userToken, bot: config.botToken},
    path.join(store.root, 'runs', 'slack', 'cooldowns.json'),
  );
  const allowWrites = args.includes('--allow-slack-writes');
  const messenger = new TaskMessenger(
    store,
    {user: config.userToken, bot: config.botToken},
    allowWrites,
  );
  const controller = new AbortController();
  let intakeHealthy = true;
  const guardedCommunication = {
    sync: (id: string) =>
      intakeHealthy
        ? messenger.sync(id)
        : Promise.resolve({held_for: 'slack_read_unavailable'}),
    reply: (...parameters: Parameters<TaskMessenger['reply']>) =>
      intakeHealthy
        ? messenger.reply(...parameters)
        : Promise.resolve({held_for: 'slack_read_unavailable'}),
  };
  let interrupted = false;
  let stopped = false;
  const stop = () => {
    stopped = true;
    controller.abort();
  };
  const interrupt = () => {
    interrupted = true;
    stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', interrupt);

  let scope: TaskScope | undefined;
  let logs: TaskLogFeed | undefined;
  let investigation: TaskInvestigation | undefined;
  let pilot:
    | {
        schema_version: number;
        stage: string;
        state: string;
        pid: number;
        started_at: string;
        expires_at: string;
        task_id?: string;
        task_ids?: string[];
        automatic_task_limit?: number;
        continuation_id?: string;
        finished_at?: string;
        stop_reason?: string;
        exit_code?: number;
      }
    | undefined;
  const pilotFile = path.join(store.root, 'runs', 'pilot.json');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const recordReadHealth = async (report: IntakeReport) => {
    intakeHealthy = report.status === 'passed';
    if (!regular) return report;
    const healthy = intakeHealthy;
    const failures = report.feeds.filter(f => f.status === 'failed');
    await updateJson(
      path.join(store.root, 'runs', 'slack-read-health.json'),
      current => {
        const prior = (current ?? {}) as Record<string, unknown>;
        return {
          schema_version: 1,
          state: healthy
            ? 'monitoring'
            : failures.length &&
                failures.every(f => transientSlackRead(f.error ?? ''))
              ? 'waiting_for_slack'
              : 'blocked',
          checked_at: new Date().toISOString(),
          last_success_at: healthy
            ? report.at
            : (prior.last_success_at ?? null),
          outage_since: healthy ? null : (prior.outage_since ?? report.at),
          consecutive_failures: healthy
            ? 0
            : Number(prior.consecutive_failures ?? 0) + 1,
          failures,
          retry_after_seconds: report.retry_after_seconds,
          poll_interval_ms: POLL_INTERVAL_MS,
        };
      },
    );
    return report;
  };
  // One coordinator classifies between bounded worker batches. Intake only persists observations.
  const work = async (intake: IntakeReport): Promise<boolean> => {
    if (admission) {
      await admission.validate();
      if (intake.status !== 'passed') {
        if (
          regular &&
          intake.feeds.some(f => f.status === 'failed') &&
          intake.feeds
            .filter(f => f.status === 'failed')
            .every(f => transientSlackRead(f.error ?? ''))
        ) {
          // Wait for the next normal poll, without model dispatch or immediate
          // retries. Identity/permission/state failures and writes still stop.
          const report = {
            schema_version: 1,
            stage: 'task-cycle',
            finished_at: new Date().toISOString(),
            intake,
            workers: [],
            held_for: 'slack_read_unavailable',
            regular_use: regular.usage,
          };
          await atomicJson(
            path.join(store.root, 'runs', 'last-cycle.json'),
            report,
          );
          output(report);
          return false;
        }
        throw new StoreError('pilot_intake_incomplete');
      }
    }
    const started = new Date().toISOString();
    const errors: {task_id: string; error: string}[] = [];
    // Flush explicit settled answers before another run can replace its journal.
    // The intent key makes an already delivered answer a no-op after restart.
    if (allowWrites && !controller.signal.aborted) {
      for (const item of await store.list()) {
        if (!allowed(item.task.id)) continue;
        try {
          const pending = await taskPublication(store, item.task);
          if (pending?.key && intakeHealthy)
            await messenger.reply(
              item.task.id,
              pending.text,
              pending.needsResponse,
              pending.key,
              pending.markdown,
            );
        } catch (error) {
          errors.push({
            task_id: item.task.id,
            error:
              error instanceof StoreError || error instanceof SlackError
                ? error.code
                : 'slack_update_failed',
          });
        }
      }
    }
    // Only the work lane changes task status. Waiting/done tasks need owner input, not log-driven reopening.
    if (
      !errors.length &&
      logs &&
      ((await logs.pending()) ||
        (await investigation?.needsInitialCheck()) ||
        (await investigation?.needsFollowup()))
    ) {
      const current = await store.locate(logs.scope.task_id);
      if (current.status === 'review')
        await store.move(current.task.id, 'queued');
    }
    const triage = errors.length
      ? null
      : await classifyPending(
          store,
          model,
          controller.signal,
          scope,
          admission,
          () => intakeHealthy,
          client,
        );
    if (triage?.read_wait) {
      intakeHealthy = false;
      return work(
        await recordReadHealth({
          ...intake,
          status: 'partial',
          feeds: [
            ...intake.feeds,
            {id: 'related_context', status: 'failed', error: triage.read_wait},
          ],
        }),
      );
    }
    const published = new Set<string>();
    const publish = async (taskId: string): Promise<boolean> => {
      if (
        controller.signal.aborted ||
        !intakeHealthy ||
        errors.length ||
        !allowed(taskId)
      )
        return false;
      if (!allowWrites) return true;
      const item = await store.locate(taskId);
      if (!item.task.session.id) {
        if (!regular?.backlog) return true;
        // Tracking and its Slack acknowledgement do not require model work.
        await prepareTaskSession(store, item.task);
      }
      try {
        await messenger.sync(item.task.id);
        if (controller.signal.aborted) return false;
        const publication = await taskPublication(store, item.task);
        if (publication && ['waiting', 'review', 'done'].includes(item.status))
          await messenger.reply(
            item.task.id,
            publication.text,
            publication.needsResponse,
            publication.key,
            publication.markdown,
          );
      } catch (error) {
        errors.push({
          task_id: item.task.id,
          error:
            error instanceof StoreError || error instanceof SlackError
              ? error.code
              : 'slack_update_failed',
        });
      }
      return errors.length === 0;
    };
    const batch =
      controller.signal.aborted || errors.length || !intakeHealthy
        ? []
        : await runTaskBatch(store, model, controller.signal, {
            workers,
            taskIds: admission?.ids ?? selectedIds,
            communication: allowWrites ? guardedCommunication : undefined,
            sourceClient: client,
            logs,
            investigation,
            budget: regular,
            canDispatch: () => intakeHealthy,
            onSettled: async result => {
              if (!result.task_id) return true;
              published.add(result.task_id);
              return publish(result.task_id);
            },
          });
    // Recover/sync existing tasks too, without delaying a fast task's answer behind a slow peer.
    for (const item of await store.list()) {
      if (controller.signal.aborted || errors.length) break;
      if (!published.has(item.task.id)) await publish(item.task.id);
    }
    await regular?.validate();
    const observed = await receipts(store);
    let backlog:
      | {
          captured_pending: number;
          queued_tasks: number;
          capacity_deferred: number;
          model_deferred: boolean;
          reasons: string[];
        }
      | undefined;
    if (regular?.backlog) {
      const tasks = (await store.list()).map(item => item.task);
      const selected = tasks[0].inbox;
      const associations = await associatedSources(store, tasks, observed);
      const pending = observed.filter(
        r =>
          r.disposition === 'pending' &&
          regular!.eligible(
            r,
            selected,
            scopedTaskIds(tasks, r, associations).length > 0,
            true,
          ),
      );
      const ready = pending.filter(r =>
        regular!.eligible(
          r,
          selected,
          scopedTaskIds(tasks, r, associations).length > 0,
        ),
      );
      const queued = (await store.list()).filter(
        t => t.status === 'queued',
      ).length;
      const remaining = modelBudget(regular.backlog).remaining_seconds;
      const capacityDeferred = pending.length - ready.length;
      const modelDeferred =
        (ready.length > 0 && remaining < 60) || (queued > 0 && remaining < 120);
      const reasons = [
        ...(capacityDeferred ? ['tracked_task_limit'] : []),
        ...(modelDeferred ? ['model_effort_budget'] : []),
      ];
      backlog = {
        captured_pending: pending.length,
        queued_tasks: queued,
        capacity_deferred: capacityDeferred,
        model_deferred: modelDeferred,
        reasons,
      };
      if (
        allowWrites &&
        intakeHealthy &&
        !controller.signal.aborted &&
        !errors.length
      ) {
        const text = reasons.length
          ? capacityPayload(pending.length, queued, [
              ...(capacityDeferred
                ? [
                    `The ${regular.limits.max_open_tasks}-task tracking limit is full; new requests stay saved until a slot opens.`,
                  ]
                : []),
              ...(modelDeferred
                ? [
                    'The rolling model-work budget is holding further assessment or investigation until budget becomes available.',
                  ]
                : []),
            ])
          : null;
        await messenger.capacity(tasks[0].id, text);
      }
    }
    const held = observed.filter(
      receipt => receipt.disposition === 'blocked',
    ).length;
    const deferred = scope
      ? observed.filter(
          receipt =>
            receipt.disposition === 'pending' &&
            scopedTaskIds(scope!, receipt).length === 0,
        ).length
      : 0;
    const report = {
      schema_version: 1,
      stage: 'task-cycle',
      started_at: started,
      finished_at: new Date().toISOString(),
      intake,
      triage,
      worker: workers === 1 ? (batch[0] ?? {status: 'idle'}) : undefined,
      workers: batch,
      worker_limit: workers,
      slack_errors: errors,
      held_receipts: held,
      task_scope: taskId,
      task_scopes: admission?.ids ?? taskIds,
      regular_use: regular
        ? {
            approval_id: regular.approvalId,
            ...regular.usage,
            ...(backlog ? {backlog} : {}),
          }
        : undefined,
      automatic_task_limit: autoTrial?.state.scope.limit,
      automatic_deferred_receipts: admission
        ? observed.filter(receipt => receipt.disposition === 'pending').length
        : undefined,
      deferred_receipts: deferred,
      slack_writes_enabled: allowWrites,
      interval_ms: POLL_INTERVAL_MS,
      log_intake: logs?.report,
    };
    await atomicJson(path.join(store.root, 'runs', 'last-cycle.json'), report);
    output(report);
    const incomplete = Boolean(
      errors.length ||
      held ||
      deferred ||
      batch.some(worker => worker.error) ||
      intake.status === 'partial',
    );
    if (
      pilot &&
      !controller.signal.aborted &&
      !incomplete &&
      (pilot.state === 'starting' || autoTrial)
    ) {
      pilot.state = 'running';
      pilot.task_ids = autoTrial?.ids ?? pilot.task_ids;
      await atomicJson(pilotFile, pilot);
    }
    return incomplete;
  };
  let active: Promise<void> | undefined;
  let requested: IntakeReport | undefined;
  let failed = false;
  let failure: unknown;
  const requestWork = (intake: IntakeReport) => {
    requested = intake;
    if (active) return;
    active = (async () => {
      // Multiple polls coalesce into one subsequent batch; batches never overlap.
      while (requested && !controller.signal.aborted) {
        const latest = requested;
        requested = undefined;
        if (await work(latest)) {
          if ((pilot || regular) && !controller.signal.aborted)
            throw new StoreError('pilot_cycle_incomplete');
        }
      }
    })()
      .catch(error => {
        failed = true;
        failure = error;
        controller.abort();
      })
      .finally(() => {
        active = undefined;
        if (requested && !controller.signal.aborted) requestWork(requested);
      });
  };
  const poll = async () => {
    // Cancel active work promptly on a failed read, but await both reads before unlocking.
    const guard = async <T>(operation: Promise<T>): Promise<T> => {
      try {
        return await operation;
      } catch (error) {
        if (!controller.signal.aborted) {
          failed = true;
          failure = error;
          controller.abort();
          await recordReadHealth({
            schema_version: 1,
            stage: 'intake',
            at: new Date().toISOString(),
            status: 'partial',
            feeds: [
              {
                id: 'preflight',
                status: 'failed',
                error:
                  error instanceof SlackError || error instanceof StoreError
                    ? error.code
                    : 'intake_failed',
              },
            ],
            retry_after_seconds: 0,
            writes_performed: 0,
          });
        }
        throw error;
      }
    };
    const [slack, logResult] = await Promise.allSettled([
      guard(
        pollIntake(
          store,
          client,
          conversation,
          controller.signal,
          args.includes('--inbox-only'),
          discovery,
          regular?.backlog ? BACKLOG_THREAD_FEEDS_PER_POLL : undefined,
          Boolean(regular),
          () => {
            intakeHealthy = false;
          },
        ).then(recordReadHealth),
      ),
      guard(
        (async () => {
          const report = await logs?.poll(controller.signal);
          if (report) {
            output(report);
            if (report.status !== 'passed' && !controller.signal.aborted)
              throw new StoreError(report.error ?? 'log_poll_failed');
          }
          return report;
        })(),
      ),
    ]);
    if (slack.status === 'rejected') throw slack.reason;
    if (logResult.status === 'rejected') throw logResult.reason;
    return slack.value;
  };
  try {
    await requireAutoTrialScope(
      store,
      Boolean(automatic),
      Boolean(regularFile),
    );
    await requireSessionLibrary(store, model.sessionLibrary);
    const researchConfig = values.get('--github-research-config');
    model.githubResearch = await TaskGithubResearch.open(store, researchConfig);
    await requireDiscoveryOptions(store, discovery);
    if (automatic)
      autoTrial = await AutoTrial.open(
        store,
        Number(automatic),
        pilotSeconds!,
        conversation,
        discovery,
        exclusionFile!,
        continuation
          ? {file: continuation, workers, sessionLibrary: model.sessionLibrary}
          : undefined,
      );
    if (regularFile)
      regular = await RegularUse.open(store, {
        file: regularFile,
        backlogApproval,
        workers,
        provider: model.provider,
        model: model.model,
        sessionLibrary: model.sessionLibrary,
        conversation,
        discovery,
      });
    admission = regular ?? autoTrial;
    for (const item of await store.list()) {
      await requireLogCapability(store, item.task.id, Boolean(logSite));
      await requireInvestigationCapability(
        store,
        item.task.id,
        Boolean(manifest),
      );
    }
    if (selectedIds) {
      const selected = await store.list();
      if (
        selected.length !== selectedIds.length ||
        selected.some(
          item =>
            !allowed(item.task.id) ||
            !item.task.slack.parent_ts ||
            !item.task.session.id ||
            !item.task.session.file ||
            item.task.inbox.channel_id !== conversation ||
            JSON.stringify(item.task.inbox) !==
              JSON.stringify(selected[0].task.inbox),
        )
      )
        throw new StoreError('invalid_task_scope');
      scope = taskIds ? selected.map(item => item.task) : selected[0].task;
    }
    if (logSite && logEnvironment)
      logs = await TaskLogFeed.open(store, {
        task_id: taskId!,
        site: logSite,
        environment: logEnvironment as LogScope['environment'],
      });
    if (manifest && chart && logs)
      investigation = await TaskInvestigation.open(
        store,
        logs,
        manifest,
        chart,
      );
    if (pilotSeconds !== undefined) {
      const now = Date.now();
      pilot = {
        schema_version: 1,
        stage: 'pilot',
        state: 'starting',
        pid: process.pid,
        started_at: autoTrial?.state.started_at ?? new Date(now).toISOString(),
        expires_at:
          autoTrial?.state.expires_at ??
          new Date(now + pilotSeconds * 1000).toISOString(),
        task_id: taskId,
        task_ids: autoTrial?.ids ?? taskIds,
        automatic_task_limit: autoTrial?.state.scope.limit,
        continuation_id: autoTrial?.continuationId,
      };
      await atomicJson(pilotFile, pilot);
      output(pilot);
      deadline = setTimeout(
        () => {
          expired = true;
          stop();
          forceStop = setTimeout(() => {
            output({
              schema_version: 1,
              stage: 'pilot',
              state: 'forced-stop',
              reason: 'shutdown_grace_exceeded',
              task_id: taskId,
              task_ids: taskIds,
            });
            process.exit(124);
          }, 30000);
        },
        Math.max(1, Date.parse(pilot.expires_at) - Date.now()),
      );
    }
    if (!controller.signal.aborted) await recoverRuns(store);
    if (args.includes('--once')) {
      const intake = await poll();
      process.exitCode = (await work(intake)) ? 2 : 0;
    } else {
      await pollOnCadence(async () => {
        const intake = await poll();
        output({
          ...intake,
          worker_busy: Boolean(active),
          interval_ms: POLL_INTERVAL_MS,
        });
        if (!controller.signal.aborted) requestWork(intake);
      }, controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    // A failed poll or stop must not release ownership while a model/tool is still mutating state.
    controller.abort();
    await active;
    clearTimeout(deadline);
    if (pilot) {
      pilot = {
        ...pilot,
        state: 'stopped',
        finished_at: new Date().toISOString(),
        stop_reason: failed
          ? 'error'
          : expired
            ? 'deadline'
            : stopped
              ? 'signal'
              : 'error',
        exit_code: failed || !stopped ? 1 : interrupted ? 130 : 0,
      };
      pilot.task_ids = autoTrial?.ids ?? pilot.task_ids;
      await atomicJson(pilotFile, pilot);
      output(pilot);
    }
    await autoTrial?.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', interrupt);
    await store.close();
    clearTimeout(forceStop);
    if (stopped) process.exitCode = interrupted ? 130 : 0;
  }
  if (failed) throw failure;
}
