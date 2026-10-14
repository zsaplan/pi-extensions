# Checked Luna pilot — implementation and acceptance

## Scope

Add an opt-in `configuration-checked-reviewer` pilot to the current runtime. Preserve all five existing profiles, their default availability, resources/digests and Sol/medium execution. Do not merge the experimental lifecycle framework or adopt the direct-tool workflow. Normal parent model/settings stay unchanged.

Operator opt-in: start Pi with `--profile-subagent-checked-pilot`. Without it, the new role is absent from discovery/listing and direct invocation is rejected; the checker is not registered. Restart without the flag to roll back. No task/model-callable configuration or fallback. The separately approved three-case live acceptance batch is complete below. Merge/installation still require separate approval; no normal installation or activation has occurred.

The new role uses `openai-codex/gpt-6-luna`, medium, **priority requested**. Only its child runtime uses the native-stream bridge required by Pi 0.99.2. Preserve SDK authentication, callbacks, cancellation and native pricing. Record bounded request/terminal model/tier metadata; default/missing service tier is not proof of priority delivery. Wrong/missing terminal model identity or outgoing settings prevents acceptance. No claim of confirmed fast service.

Require explicit `snapshots: {before, after}` arguments for this role. Bind the checker to that resolved ordered pair and the active parent call/session; exactly one comparison, no parent/source authority expansion through child task text. Relative and absolute spellings resolving to the same target are equivalent. This is lexical request binding, not physical/symlink isolation or a security sandbox. Other trusted extensions retain host authority, and read hooks can change returned observations.

Use the existing strict JSON contract and delivered-result checks. Add an intact, call-bound failure receipt with a bounded checker-owned reason and requested paths, rather than trusting child-written error prose. Never recover a redacted/changed cached result. Runtime-owned summaries retain both paths even if the child omits them; raw child prose remains separately unverified. Counts/changes exist only for a complete intact inventory, never on failure.

## Evidence and limits

E030 (`b1564c0`) completed five paired synthetic cases: Luna whole-handoff reported cost 28.9% lower, CLI time only 0.9% lower; child cost/time 91.1%/53.5% lower. Supported facts and abstentions were correct, but child path reporting and parent failure explanations had gaps. All terminal child responses reported default. This is a narrow pilot, not independent reliability qualification, broader investigation acceptance or supported-stage promotion. Changes to integration/failure reporting need their own acceptance; E030 does not certify this new build.

## Plausible failures to test before release

- Accidental opt-in, model-callable enablement, or changes to existing five profiles/models/tools.
- Missing Luna, wrong outgoing settings or response model, swallowed callback failures, falsified priority fulfillment or incorrect local pricing; no fallback.
- Wrong/swapped/same/outside paths, hook-rewritten comparison arguments, repeated calls, direct checker use without an active assignment, or profile mutation after queue admission.
- Denied/redacted/truncated reads, unsupported JSON, oversized reports, forged/redacted success or failure receipts, receipt reuse/session/call mix-ups.
- Child omission or invented prose hiding known errors; failure must have no counts or clean status.
- Cancellation, queued work, incomplete metadata, artifact leakage or duplicated usage.
- Packaged install/disable/remove and fresh-session rollback, without changing actual user settings.

## Acceptance checklist

- [x] Implement the additive opt-in role and profile-specific Luna transport.
- [x] Preserve ordered-pair/read permissions and complete delivered inventories in scripted checks.
- [x] Preserve safe, intact failure reasons and paths without certifying prose in scripted checks.
- [x] Run real-CLI scripted E2E failure cases; retain repeatable private evidence.
- [x] Compare original profile resources/digests and scripted behavior with the release base.
- [x] Run package verification, then repository verification; review packaging and diff.
- [x] Review implementation locally and resolve identified material findings. This is not independent human acceptance.
- [x] Separately authorize/run bounded live acceptance of this exact integration (E031; functional criteria passed, instruction-fidelity gap retained below).
- [ ] Separately approve merge/installation; record installed revision and fresh-session checks.
- [ ] Verify rollback in the intended installation. No rollout is recorded until these checks are actually complete.

## Local verification record — 2026-10-14

- Base: `2dc30e6` (`origin/main` at worktree creation). Work is additive; the separate experimental lifecycle branches are not merged. The original checkout remains untouched despite its non-fast-forward pull blocker.
- Pi 0.99.2, Node 26.10, macOS. `npm run verify --workspace profile-subagent`: **170 passing tests**. The new real-CLI suite contains **68 scripted scenarios** plus its enclosing test. `npm run verify`: passed across the repository.
- Repeatable fixture entry: `node --test profile-subagent/test/pilot-e2e.test.ts`. Evidence index: `profile-subagent/tmp/e2e/checked-pilot-evidence.json`; individual directories contain JSONL output, tool audit and captured native request bodies. The parent/model fixture uses localhost SSE, not live Luna.
- Verification logs: `tmp/pilot/package-third.log`, `root-second.log`; original-profile manifest/digest and Sol/medium equality: `tmp/pilot/compatibility.json`. Full root verification first exceeded a combined 240-second command deadline during unchanged task-assistant tests; the retained `root-first.log` is incomplete. A separate 900-second-bounded root run passed; the unrelated task-assistant suite reported one skipped test. No unrelated processes were stopped.
- Packed installation in a private agent directory executed the new specialist through the native adapter, restarted without the flag to recover exactly the original five roles, then removed the package. Archive assertions exclude `tmp`, tests and node_modules. These checks did not change actual user settings or install the pilot for the operator.
- Local review covered model scoping, SDK option forwarding, cancellation, ordered assignment/receipt lifetime, runtime-owned failures, privacy, legacy behavior and packaging. It checked that null/redacted payloads are not restored, added an abort check before acceptance, and removed accepted inventory fields if artifact persistence fails. Scripted coverage includes missing parent read, corrupted inventories, tampered success/failure delivery and artifact-write failure.
- A separately scoped documentation specialist found no material source/document contradiction. Original-profile equality and test outcomes were outside that child's scope and checked separately by the parent. Its report remains unverified prose; it is not independent human review or runtime certification. Review artifact: `documentation-consistency-reviewer-y0HMTz`, reported child cost **$0.0689168**, outside the historical studies. Material startup/receipt/transport claims were checked against source, not accepted solely from its citations. The child's invocation-gate citation was off: the actual enabled/snapshot check is at `src/index.ts:117–120`, not its cited `122–129`; the factual conclusion was supported by the source.
- Earlier fixture failures remain in private logs: tool allowlist omissions, hook input mutation, parallel-result ordering and initial type/lint corrections. They were fixed before the passing checks, not counted as successful trials. At this pre-live checkpoint, no live pilot acceptance calls, merge, publication, installation or promotion had occurred.

## Approved bounded live acceptance protocol — completed

This is functional acceptance of the integration, not another payoff comparison. Freeze the implementation revision, exact prompts/inputs/order, guard configuration and expected answers **before** paid execution. Use an isolated agent directory with normal credentials through the existing SDK path; do not alter actual user settings or load both installed and worktree copies.

1. Supported pair: before `{"requests":{"cpu":1},"limits":{"cpu":2},"tag/v~x":true}`; after `{"tag/v~x":false,"limits":{"cpu":3},"requests":{"cpu":1}}`. Expected changes: `/limits/cpu` 2→3 and `/tag~1v~0x` true→false; counts 6/6/2/4 and inclusive line 1 spans. Both full requested paths must survive the handoff.
2. Duplicate decoded key: before `{"x":1}`; after `{"x":1,"\u0078":2}`. Expected unavailable inventory, intact checker-reported duplicate-key reason, both paths, no invented counts.
3. Missing after: before `{"x":1}`; after path deliberately absent. Expected unavailable inventory, checker-reported after-read-unavailable reason, both paths, no claim that the receipt proves physical absence.

Maximum three fixed Sol/medium parent runs, one Luna/medium/priority-requested child each; parent 180 seconds, child six turns/120 seconds. Restrict evidence reads to each named synthetic pair. Retain parent/child usage, errors, full CLI elapsed, provider metadata and original outputs. Review after each run; stop at **$1 known reported cost**, any unexpected scope/integrity/model/accounting/transport failure, or failed acceptance. This is a review threshold, not a hard billing cap. No retries, replacements, fallback, selected repetitions or post-launch tuning. Expected unsupported-input failures are acceptance cases, not transport failures. Default/missing returned tier alone does not fail the explicitly priority-requested configuration. Preserve every failure and leave remaining cases unrun.

The user separately approved these three runs; that authorization is now exhausted. Merge, normal installation and installed rollback checks remain separate decisions.

## Live acceptance result — E031, 2026-10-14

**All three declared functional cases passed** on implementation `b9a5eb298a36541ba341e5a667f891f9afff6d6b`. No runtime or prompt changes occurred after freezing 60 input entries. The paid order was supported → duplicate → missing, with manual review between runs, no repetitions, replacements, model fallback or observed retries. The existing experiment runner enforced input drift, create-once runs, 180-second process budgets and owned-process cleanup. A separate permission guard limited model evidence access to the assigned pair under one child/checker.

| Case | Result | Whole-handoff reported cost | Full CLI seconds |
|---|---|---:|---:|
| Supported pair | Exact two changes, types/values/presence, 1–1 spans, full paths and 6/6/2/4 coverage counts | $0.0151456 | 23.640131 |
| Duplicate decoded key | Correct unavailable result; exact reason and full paths retained; no inventory/counts | $0.0098984 | 17.751633 |
| Missing after observation | Correct unavailable result; exact after-read-unavailable reason and full paths; no physical-absence inference | $0.0100906 | 21.219536 |
| **Total** | **Three functional passes** | **$0.0351346** | **62.611300** |

Each case used one Luna child, one checker and two nested read attempts, with zero parent source rereads. Six parent and six child model requests had complete reported accounting/context. Child totals were $0.0019870 and 13.436 seconds; costs are not double-added to the enclosing tool usage. No scope, transport, cleanup, frozen-input or original-execution-hash failures occurred. Both unavailable child statuses were expected input failures, not failed transports.

The bridge recorded six priority-requested hooks and six terminal Luna identities; **all six terminal tiers were `default`**. Priority fulfillment remains unconfirmed. Native reported child pricing matched the requested-priority multiplier; hypothetical default-tier prices do not replace measured estimates. Cost excludes engineering/coordinator work and is not an invoice. This batch has no comparison arm and establishes no new cost/speed benefit.

**Retained instruction-fidelity defect:** the supported-case child repeated the inventory despite its profile instruction not to retype it. The repeated values were correct, and the final parent answer used the intact runtime-owned inventory. This did not fail the predeclared supported-case factual/binding/parent-reporting checks, but it means **complete instruction fidelity did not pass**. Correct attachments and parent output do not erase this defect. No prompt change or selected retest was made. Raw child prose remains unverified.

Evidence is private under `profile-subagent/tmp/pilot-live/E031-01/`: frozen plan, raw runs, per-case metrics/inspections/manual reviews, fresh summary copies and `audit.json`. The adjacent `guard.ts`, `prepare.py`, `inspect.py`, `run-one.sh`, oracle and protocol are retained. Five additional scripted real-CLI guard preflights passed before paid execution, using localhost model transport. The private credential export was removed afterward; normal user settings were not changed. Files/directories are 0600/0700 and excluded from packaging.

Post-run package verification again passed all 170 tests; repository verification passed with one unrelated task-assistant test skipped. Logs: `tmp/pilot-live/package-final.log` and `root-final.log`. The final archive has 76 files and no private evidence/tests; all 60 frozen entries remained unchanged after verification.

The oracle and review were assistant-authored and unblinded. These three synthetic cases establish only the stated integration behavior, not independent reliability, broader real-work coverage, optional routing, general investigation usefulness or supported-stage promotion. Remaining approvals/checks are merge, normal installation and fresh-session opt-in/rollback verification.
