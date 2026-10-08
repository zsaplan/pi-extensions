# Parent orchestration

## Contract

The parent may invoke `profile_subagent_run` directly or through codemode while enabled. Use direct exposure so a disabled runner remains unavailable; do not make hidden codemode exposure a permission bypass.

A `RunQueue` shared by the loaded extension admits at most **three** children. Waiting calls are FIFO and cancellable. Timeout begins after admission, not during queue wait. Cancelled waiters create no model request or child artifacts. Admission reloads the profile and current parent tools; earlier search results are not grants.

Slots remain held through cooperative shutdown and artifact persistence. A new caller cannot take a reserved slot from an awakened waiter. There is no machine-wide queue across Pi processes or terminals.

This does not change child models, role capabilities, authentication, approval requirements, result limits or parent tool serialization. Child codemode and recursive delegation remain disabled.

## Cancellation and accounting

Pi 0.99.2 may finalize a cancelled codemode result before its nested calls finish. The extension tracks its own nested runner calls through `tool_execution_start`/`tool_execution_end`, then waits for descendants of the enclosing `tool_result` before Pi captures nested usage.

Descendant IDs follow Pi's `<parent id>/<n>` lineage. The extension does not calculate or manually add that nested usage. Parent and child request usage must each be counted once; parent tool totals are a reconciliation source, not extra model cost.

The initial cancellation test exposed children with usage in their artifacts but none in the enclosing result. The descendant-drain fix and failing evidence were retained. Cooperative tools can still delay cleanup; this is not hard process termination.

## Caller behavior

Await all work. Use `Promise.allSettled` for independent assignments so one failure does not erase other outcomes. Parse successful JSON-text results; inspect status/truncation and preserved failures. Do not start dependent work before prerequisites.

Parallelism is optional. Keep simple work direct and substantial shared-context work combined when an existing role and budget fit. See [DELEGATION.md](DELEGATION.md). A forced many-child diagnostic is not normal routing policy or a fair substitute for optional delegation.

## Acceptance

Seventeen actual CLI/built-in codemode scenarios exercise:
- Bounded direct/nested overlap and FIFO recovery after failures.
- Disabled runner, missing tools, invalid arguments and current-profile/tool revalidation.
- Parent runner/evidence/file denial and redaction.
- Child isolation and serialized parent evidence tools.
- Cancellation, timeout, script errors and early return without losing descendant usage.

The wider suite covers discovery, credentials, role/context isolation and package lifecycle. Generate repeatable private evidence with `npm run verify --workspace profile-subagent`; orchestration records are in `profile-subagent/tmp/e2e/orchestration-evidence.json`.

Clean installation and repository checks pass; see [RELEASE.md](RELEASE.md). Live workload trials showed that concurrency alone did not eliminate duplicated setup or guarantee lower time/cost/context. Later combined delegation was more useful on one shared-context workload. Aggregate results and limitations are in [DELEGATION.md](DELEGATION.md); raw operational evidence stays private. Different-context usefulness, live cancellation and production repair acceptance remain unproven.
