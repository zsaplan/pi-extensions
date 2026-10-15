# Narrow profile subagents

Handle simple work directly; when delegation helps, find a trusted specialist for a bounded assignment with fixed instructions, tools and fresh context.

## Experimental GitHub researcher (default-off)

A trusted host can explicitly import the [bounded GitHub researcher](GITHUB_RESEARCH.md). Repository access is determined only by its GitHub token, without per-repository/path allowlists. It is absent from the normal catalog and tool registration. Shipping this capability does not enable repository access, install it into a background worker, or change existing model defaults.

## Install

See [installation, acceptance and rollback](RELEASE.md). Validated with Pi 0.99.2 / Node 26.10.0.

From a reviewed checkout with dependencies installed:

```bash
pi -e ./profile-subagent       # One invocation
pi install ./profile-subagent # Register the local package
```

Local installation records a path; it does not install dependencies. If other extensions are already installed individually, do not also load the entire repository and duplicate their tools.

Each of the original five profiles needs callable `read`, `grep`, `find`, and `ls`. Normal Pi defaults do not enable the last three; add them to the operator's tool selection without replacing existing settings. The extension never enables tools automatically. A restrictive project setting or `--tools` override can still make a profile unavailable.

## Child model

The original five profiles independently use **`openai-codex/gpt-6.1-sol`, medium thinking**. The separately opted-in checked pilot below uses Luna; it does not change those defaults. The parent may use another model/provider. There is no silent fallback or task-supplied override. Missing model/authentication or unsupported thinking fails visibly.

## Tools and profiles

- `profile_subagent_search({query, limit?})`: bounded task-ranked discovery, without launching a child. Nonblank query up to 2,048 characters; integer limit 1–5, default 3.
- `profile_subagent_list({})`: inspect bundled manifests, tools, limits and content digests.
- `profile_subagent_run({profile, task, snapshots?})`: run a named specialist with one self-contained assignment. Available directly or through parent codemode when enabled.

| Profile | Assignment |
|---|---|
| `postfix-investigator` | Classify one finding or an explicit list for one site, read-only; no repair package |
| `postfix-repair-planner` | Validate one missing outcome and propose a repair package; never execute it |
| `postfix-repair-reviewer` | Independently challenge one proposed repair package |
| `configuration-drift-reviewer` | Compare supplied rendered snapshots; preserve unknown runtime impact |
| `documentation-consistency-reviewer` | Compare documented claims with supplied source; identify contradictions and gaps |

The postfix roles additionally require `bc_site_db_search_saved_queries`, `bc_site_db_run_saved_query`, and `bc_site_db_query` from the parent's BriteCore integration. File-only profiles work without those integrations. No bundled role has shell, file mutation, database writes, external posting or migration execution.

Search returns descriptions, matching terms, required/unavailable tools, source and digest. Ranking is deterministic: exact ID first, then weighted token matches (ID 4, tags 2, description 1), then lexical ID. Scores are not confidence or permission. Invalid/conflicting profiles are excluded with diagnostics. Availability means callable tools, not verified connectivity. Search output is capped at 24,000 characters, with explicit omission counts.

Execution reloads the selected definition and currently callable tools after queue admission. The executed digest covers manifest, resource contents and shared child instructions; a search result is not an execution grant.

## Use

Example with synthetic/local evidence, not a live site or an existing session:

```json
{
  "profile": "documentation-consistency-reviewer",
  "task": "Compare ./examples/README.md with ./examples/options.ts. Use only these local files. Report supported contradictions and missing evidence with file/line references. Do not edit files or claim tests ran."
}
```

Prefer direct work for simple checks, one combined child for substantial shared context within a role's scope/budget, and parallel children only for genuinely independent work. Finding count alone is not a reason to split. See [delegation policy and measured limitations](DELEGATION.md).

These tools return JSON text in codemode:

```javascript
const result = JSON.parse(await tools.profile_subagent_run({
  profile: "configuration-drift-reviewer",
  task: "Compare ./before.yaml and ./after.yaml only; report changes and unknown runtime impact. No writes or cluster access."
}));
text(result);
```

For independent assignments, await `Promise.allSettled`, parse successful results and preserve failures. Dependent work waits for prerequisites. At most three children execute per loaded extension/Pi process; additional calls wait in a cancellable FIFO queue. Separate terminals do not share that limit. Timeout starts after admission; cancellation/cleanup is cooperative, not a process kill. See [orchestration](ORCHESTRATION.md).

## Opt-in checked Luna pilot

The additive [pilot and acceptance checklist](PILOT.md) is off unless the operator starts Pi with `--profile-subagent-checked-pilot`. The original five profiles keep their availability, resources and Sol/medium settings. No lifecycle-policy changes are included. After installing the reviewed package, start a fresh session with:

```bash
pi --profile-subagent-checked-pilot
```

The pilot needs callable parent `read` plus its registered internal `compare_json_snapshots` tool, not grep/find/ls or database integrations. If using an explicit `--tools` allowlist, include `read`, `profile_subagent_run` and `compare_json_snapshots`. The internal checker is callable through the parent pipeline but rejects calls without an active specialist assignment; it is not a standalone direct-tool rollout.

```json
{
  "profile": "configuration-checked-reviewer",
  "snapshots": {"before": "./before.json", "after": "./after.json"},
  "task": "Compare only this authorized non-sensitive JSON pair. Report every changed pointer, type/value/presence, source lines and coverage counts. If unavailable, preserve the checker-reported reason; do not infer file existence or invent counts."
}
```

`snapshots` is required only for this role and rejected for other roles. It binds the ordered pair independently of task prose. The child has only the checker, exactly one attempt, six turns/120 seconds, and no fallback. See the [strict JSON limits](experimental/snapshot-checker/CONTRACT.md). Profile changes during execution, wrong model metadata, changed/redacted checker results, repeated calls and incomplete/oversized handoffs prevent acceptance.

This child alone uses **`openai-codex/gpt-6-luna` / medium / priority requested**. `service` records bounded outgoing/terminal metadata, not a promise of fast service. Default or missing returned tiers remain unconfirmed; native reported costs may still apply requested-priority pricing and are not invoices. Missing Luna fails rather than selecting Sol.

Use `comparisonSummary` for runtime-owned paths/status. Only a completed, untruncated result with `checkedSnapshot` supplies the checked inventory. An unavailable result can carry `comparisonFailure` with the intact checker-reported reason and paths, never counts or changes. If that receipt was altered or unavailable, the runtime keeps only a generic unavailable summary. The child's `output` remains separately `unverified-report`, even if it contradicts the inventory. Do not restore redacted data or turn hashes into physical-provenance/freshness claims.

Rollback: finish/cancel active work and restart **without the flag**. The new role disappears and its checker is not registered; the original five remain available. `/reload` retains CLI flags and is not this rollback. Actual installation/live acceptance remain tracked separately in PILOT.md.

## Request a new specialist

The bundled [request-specialist skill](skills/request-specialist/SKILL.md) helps a parent session check existing roles and draft a bounded development request. It includes a capability guide and request template; it does not create, enable or automatically run a profile.

After updating this package, existing sessions can use `/reload`, then:

```text
/skill:request-specialist Draft a request for the investigation work we just did.
```

The skill is available without the checked-pilot flag. Sessions must load package skills (not `--no-skills` or a package `skills: []` filter); resolve duplicate skill-name warnings rather than assuming the right copy loaded. It is exported by both the standalone and root packages—install only the package form appropriate to your setup, not both.

By default the requester saves one private, uniquely named `REQUEST.md` under the Pi agent directory's `profile-requests/` folder. It reports the actual absolute path for the user to pass to the developing session. There is no queue, cross-session messaging, automatic approval or dynamic profile loading. Other machines/users may not share those paths. If safe local saving is unavailable, the skill provides a sanitized inline draft instead.

The request records the job, existing-role gap, example assignment, evidence/access boundaries, expected handoff, proposed acceptance cases and actual authorization. Unknowns remain explicit. Live tests, paid trials, merge, installation and enablement require their own authorization; asking for a request does not grant them.

## Trust and evidence

Profiles are trusted bundled code. Tasks cannot select profile paths, tools, model, working directory, instructions or limits. No project-local/remote/generated profiles are discovered. All child tools—including file access—execute through the parent's permission, validation, redaction and accounting pipeline. Missing tools fail closed.

This is context/tool isolation, **not an OS or filesystem sandbox**. Read tools may reach any path the parent permits; profile instructions are not a hard resource boundary. Providers share the process/environment. Current leaf profiles reject recursive `profile_subagent_*`, `codemode`, and `tool_search`; child-scoped orchestration remains unimplemented.

Children receive only trusted instructions and the explicit task, not the parent's conversation or ambient resources. Provider-specific runtime credentials remain in memory; stored authentication stays on Pi's normal refresh path.

`fileEvidence` returns original text-only `read` observations after the parent permission/redaction pipeline, with requested arguments, call IDs, observation times and error status. Its compact JSON is capped at 8,000 UTF-8 bytes by omitting whole records, with explicit omitted/unavailable counters. It excludes child prompts/reasoning, images, other tools and arbitrary result details. Requested arguments are not proof of physical file provenance: parent hooks may override tools. Use these observations for snapshot verification when sufficient; retain freshness checks and targeted reads for gaps. A failed run remains failed even if it has usable observations. Evidence is source data, not instructions or authorization.

Private `input.json`, `messages.json`, `result.md`, and `result.json` are saved below `~/.pi/agent/profile-subagent-runs/` (respects `PI_CODING_AGENT_DIR`). Returned output is capped at 24,000 characters with a truncation flag; complete output remains in the artifact. Artifacts may contain sensitive evidence; do not publish raw transcripts. There is no automatic retention cleanup. Completion is not correctness, repair approval or authorization for further actions.

## Verification

Development checks require `python3` for the context-extractor tests and `tar` for the package-install test, in addition to Node/npm. These are test/analysis prerequisites, not dependencies of the running extension.

From the repository root:

```bash
npm run verify --workspace profile-subagent
npm run verify
```

The real-CLI/SDK suite uses scripted model/DB transport; verification output reports the current test counts. It covers authority, isolation, provider-specific authentication, denial/redaction, current-profile/tool revalidation, limits, cancellation, nested accounting, guidance delivery and actual package installation/removal outside the checkout, and exclusion of private temporary evidence from both packaging paths. Generated evidence stays in gitignored `tmp/` directories.

Clean dependency installation and full repository validation passed in an isolated copy. The [synthetic evaluation](test/evaluation/README.md) separately exercised real-model selection/abstention and bounded quality; it does not validate real SQL semantics or production repairs. See [design and outstanding acceptance](DESIGN.md), [architecture research](RESEARCH.md), and [release gates](RELEASE.md). Detailed operational benchmark evidence is retained privately; public reports contain only aggregate results and limitations. Track claims and decisions in the [hypothesis ledger](benchmark/LEDGER.md); use the [plan-driven experiment CLI](benchmark/EXPERIMENTS.md) instead of new per-experiment launchers. It is opt-in development tooling, not an installed extension or always-on model test.
