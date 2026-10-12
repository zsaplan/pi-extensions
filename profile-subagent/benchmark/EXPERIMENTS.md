# Reusable experiments

Start with the [hypothesis ledger](LEDGER.md). A new experiment is a JSON plan, not a new launcher or an automatic regression schedule. This tooling invokes the native Pi CLI and reuses the existing context extractor. It does not change the installed extension, add routing guidance, execute repairs, or decide which hypothesis won.

## Commands (from the repository root)

Uses Python 3's standard library and the installed Pi CLI. Process-group cancellation is POSIX-only; validation used macOS, Python 3.14, Node 26.10 and Pi 0.99.2.

```bash
# Read/validate/freeze only: no model calls or Pi execution.
python3 profile-subagent/benchmark/experiments.py prepare \
  profile-subagent/benchmark/examples/configuration/plan.json \
  profile-subagent/tmp/experiments/config-001

# Inspect plan.json, source-plan.json and review.md first.
# These commands make model calls using normal provider authentication.
python3 profile-subagent/benchmark/experiments.py run \
  profile-subagent/tmp/experiments/config-001 direct-1
python3 profile-subagent/benchmark/experiments.py run \
  profile-subagent/tmp/experiments/config-001 optional-1

# No model calls; creates a new private summary directory each time.
python3 profile-subagent/benchmark/experiments.py summarize \
  profile-subagent/tmp/experiments/config-001
```

The shipped example is a **mechanical/local smoke**, not an expected delegation win: its tiny task should normally stay direct. It is not run automatically. For a cue experiment, use pre-cue and candidate extension paths as variants and enable specialists in **both** arms. Disabling them in one arm asks a different question.

Existing manual sessions use the same measurement path without relaunching anything:

```bash
python3 profile-subagent/benchmark/experiments.py measure \
  /private/completed-session.jsonl /private/new-measurement-directory
# Optional: --events /private/events.jsonl
# Optional: --child-root /private/agent/profile-subagent-runs
```

For codemode-nested children, include the JSON event stream so their actual result envelopes can be located. Without it, missing child evidence is explicit/unknown, not zero. Direct child results can be resolved from the saved session. Artifacts are accepted only inside the approved child root and only when their parent session ID matches. No broad scan of unrelated sessions or child directories is performed.

## Compose a plan

Paths are relative to the plan file. Plans are **trusted operator inputs**, not instructions scraped from task evidence. Keep operational plans under an ignored/private directory; never include credentials. JSON fields are strict: spelling mistakes fail rather than silently changing the experiment.

- `version`: 1.
- `id`, `hypothesis`, `criterion`: experiment identifier, ledger hypothesis ID/claim and predeclared success/failure criteria. Criteria are descriptive, not an auto-grader.
- `cli`: optional executable array, either `["pi"]` or `["/path/to/node", "/path/to/pi/dist/cli.js"]`. No arbitrary extra CLI flags.
- `common`: shared variant configuration.
- `cases`: named `{cwd, prompt, authorization, inputs?}`. Prompt/authorization are file paths. `inputs` is a list of additional files/directories to hash, including immutable evidence and relevant source. Same case means the same prompt/cwd/authorization across variants.
- `variants`: named configurations. Scalar fields override `common`; `extensions` and `inputs` concatenate; `environment` merges by key. Explicit `tools` replaces the shared selection.
- `trials`: ordered `{id, case, variant}` entries. Repetitions are additional unique trial IDs. There is no automatic matrix expansion, retry, resume or parallel scheduler.

Variant fields:

| Field | Meaning |
|---|---|
| `extensions` | Explicit local extension files/directories or `builtin:*`. Autoloaded extensions are disabled; list every required integration, provider and approval extension. Do not load a root package and its same individual extensions. Remote/npm installation is not performed. |
| `tools` | Optional full tool-name list; `[]` disables tools. If omitted, normal defaults apply. Explicit tools are a deliberate experimental change, not an additive setting. |
| `provider`, `model`, `thinking` | Parent defaults are openai-codex / gpt-6.1-sol / medium. Child defaults remain independently fixed by the tested runtime. The runner does not rewrite children or provide fallbacks. |
| `timeoutSeconds` | Whole CLI wall-time budget, integer 1–3600; default 600. Cancellation attempts graceful SIGINT, then kills the process group after 10 seconds. Interrupted usage may be incomplete. No hard dollar-cap mechanism is claimed. |
| `resources` | `isolated` (default) disables ambient skills/context/templates/themes/project trust; it does not isolate the OS, credentials or all settings. `ambient` preserves normal resources and trust choices. Never compare modes accidentally. |
| `inputs` | Additional source, instructions, dependency locks and settings to hash. Explicit extension paths, prompt/authorization, executable files, runner/metrics code and relevant settings paths are included automatically. Imported modules outside listed trees must be supplied here. |
| `environment` | Non-secret string overrides. Defaults suppress automatic Pi discovery and Discord notification. Credentials stay inherited/on Pi's normal auth path; secret-like override names are rejected. Do not hide secrets under other names. No full environment dump is stored. |

An authorization file names allowed targets, access and output boundaries. Literal `{{run}}` expands to that trial's private evidence directory. Do not add allocation coaching unless it is the declared intervention. A prompt boundary is **not** an enforcement sandbox; use suitable permissions/approval hooks or local fixtures. Offline mode does not disable model or tool networking. Disable any other notification integrations explicitly if necessary.

## Freeze, execution and evidence

Preparation creates an exclusive group directory with normalized plan, source plan, hashes and a review template. Directory snapshots exclude `.git`, `node_modules`, `tmp` and `__pycache__`; use locked dependencies and include relevant lock/version files. Symlinks inside frozen directory trees are rejected; use explicit resolved paths. Hashes are drift checks, not an adversarial tamper-proof signing system. Settings are hashed, not copied; auth files are neither read nor exported by this tooling.

Before and after a trial, frozen inputs are checked, including new/deleted files. A changed input invalidates the trial; it does not authorize restoring/overwriting that input. Runtime source is not copied or installed. Use committed source versions and retain the original input files: hashes detect changes but cannot reconstruct deleted or edited inputs. Live DB/Slack state, provider load, caches, undeclared resources and inherited environment remain uncontrolled; record them in the review. The engine cannot make mutable live evidence a matched workload.

Each trial directory is create-once. A failed or cancelled run cannot be silently retried under the same ID. Start a new group for a changed intervention or repeat after infrastructure failure, retaining the original failure. A group lock prevents concurrent arms in this group, not other sessions/machines. If the runner itself is forcibly killed, retain the incomplete evidence and confirm all descendants stopped before manually removing a stale `.running` lock. Never automatically clear a lock.

Artifacts include launch arguments, authorization, raw stdout/events, stderr, parent session, process outcome and hashes. Summaries reject changed recorded run files and copy the parent and identified child evidence into a fresh private directory, with metrics and calls. Individual imported evidence files are limited to 128 MiB; oversized or malformed evidence is retained at its source and reported as unmeasured, not silently clipped. Files are private (0600), directories 0700; no automatic deletion/retention policy. Keep raw operational evidence out of Git and Slack. `tmp/` is ignored and excluded from packaging.

## Measurement and decisions

- Elapsed time is the first fresh user request through the last active-branch assistant response, matching the historical measurements. Launcher start/finish timestamps also retain setup and cleanup time.
- Context uses the existing **parent-input-context-v1** metric: input + cacheRead + cacheWrite per fresh request, active branch only; first/last/peak/growth, coverage and context changes retained. Traffic is not context size.
- Costs count all fresh parent requests (including abandoned attempts), top-level tool usage and standalone helper/compaction usage once. Child artifacts reconcile the enclosed tool usage; they are **not added a second time**. Other model-using tools remain in the tool subtotal.
- Missing/zero-token usage, unfinished work or unreconciled child accounting leaves `totalReportedCost` unknown. `recordedCostKnown` preserves the known sum, not a claim that nothing else was charged. Costs are reported estimates, not verified billing.
- Summaries expose tool calls/failures, child defaults/digests, models and prompt/tool metadata hashes for setup comparisons. Child counts are run-call attempts, not successful children. Omitted nested argument bodies alone do not mean usage is missing; capped call inventories need the event stream. Human review still checks required coverage, material correctness, scope, duplication, actual writes, source freshness and uncertainties. A process exit code or completed response is not quality.
- Compare the same required coverage. If scope diverges, retain that as an allocation result and do not claim the narrower answer delivered the same work more efficiently. No automatic winner or release action is implemented.
- Fill `review.md`, then add an authorized sanitized result/decision to the ledger. Do not rewrite the hypothesis after seeing results. Merge/install/live changes remain separate approvals.

## Acceptance and failure cases

Before this tooling is used for a paid/live experiment, verify these plausible failures through the actual CLI where applicable:

- [x] Composing two cases and variants requires plan changes only; exact args/cwd/prompts/model/tool choices survive CLI execution.
- [x] Parent/child usage through direct and codemode calls is counted once; original evidence and scoped child artifacts reconcile.
- [x] Frozen-plan/input drift, newly added files, duplicate IDs, unknown fields, unsafe IDs and attempted reruns are rejected before new model work.
- [x] Timeout/cancellation and model/tool failure retain original evidence; missing/truncated evidence is unknown, not a fabricated zero or pass.
- [x] Inherited/abandoned requests, helper usage, Unicode JSONL text and child evidence outside the approved root cannot silently corrupt accounting.
- [x] Private permissions, original-input preservation, package/root verification and public-content review pass.
- [ ] A separately authorized real experiment confirms operator usability. Scripted transport is not live acceptance.

Evidence: `test/experiments-e2e.test.ts` (relative to `profile-subagent/`) runs eight scripted-transport checks; the package suite reports 93 passing Node tests, and repository-root verification passed. One existing `pr-worktree-status` cache-timing test failed on a later root run; its log was retained, and a targeted check plus one root retry passed without changing that code. Repeatable local artifact: `profile-subagent/tmp/e2e/experiments-evidence.json`, pointing to retained unique run directories. Offline remeasurement reproduced E007's recorded time/cost/context exactly; it did not repeat either investigation. Neither this acceptance nor E007 establishes future real-experiment usability.

Only these consequential measurement/execution failure paths need infrastructure regression tests. Ordinary hypotheses stay as plans plus reviewed results—not new always-on model tests.
