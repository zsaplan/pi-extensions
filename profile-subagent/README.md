# Narrow profile subagents

Handle simple work directly; when delegation helps, find a trusted specialist for a bounded assignment with fixed instructions, tools and fresh context.

## Install

See [installation, acceptance and rollback](RELEASE.md). Validated with Pi 0.99.2 / Node 26.10.0.

From a reviewed checkout with dependencies installed:

```bash
pi -e ./profile-subagent       # One invocation
pi install ./profile-subagent # Register the local package
```

Local installation records a path; it does not install dependencies. If other extensions are already installed individually, do not also load the entire repository and duplicate their tools.

Every profile needs callable `read`, `grep`, `find`, and `ls`. Normal Pi defaults do not enable the last three; add them to the operator's tool selection without replacing existing settings. The extension never enables tools automatically. A restrictive project setting or `--tools` override can still make a profile unavailable.

## Child model

Children independently use **`openai-codex/gpt-6.1-sol`, medium thinking**. The parent may use another model/provider. There is no silent fallback or task-supplied override. Missing model/authentication or unsupported thinking fails visibly.

## Tools and profiles

- `profile_subagent_search({query, limit?})`: bounded task-ranked discovery, without launching a child. Nonblank query up to 2,048 characters; integer limit 1–5, default 3.
- `profile_subagent_list({})`: inspect bundled manifests, tools, limits and content digests.
- `profile_subagent_run({profile, task})`: run a named specialist with one self-contained assignment. Available directly or through parent codemode when enabled.

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

## Trust and evidence

Profiles are trusted bundled code. Tasks cannot select profile paths, tools, model, working directory, instructions or limits. No project-local/remote/generated profiles are discovered. All child tools—including file access—execute through the parent's permission, validation, redaction and accounting pipeline. Missing tools fail closed.

This is context/tool isolation, **not an OS or filesystem sandbox**. Read tools may reach any path the parent permits; profile instructions are not a hard resource boundary. Providers share the process/environment. Current leaf profiles reject recursive `profile_subagent_*`, `codemode`, and `tool_search`; child-scoped orchestration remains unimplemented.

Children receive only trusted instructions and the explicit task, not the parent's conversation or ambient resources. Provider-specific runtime credentials remain in memory; stored authentication stays on Pi's normal refresh path.

Private `input.json`, `messages.json`, `result.md`, and `result.json` are saved below `~/.pi/agent/profile-subagent-runs/` (respects `PI_CODING_AGENT_DIR`). Returned output is capped at 24,000 characters with a truncation flag; complete output remains in the artifact. Artifacts may contain sensitive evidence; do not publish raw transcripts. There is no automatic retention cleanup. Completion is not correctness, repair approval or authorization for further actions.

## Verification

From the repository root:

```bash
npm run verify --workspace profile-subagent
npm run verify
```

The real-CLI/SDK suite uses scripted model/DB transport: 33 runner, 20 discovery, 17 orchestration, 9 context-extractor and 1 packaged-install scenario (80 scenarios; Node reports 84 including containers). It covers authority, isolation, provider-specific authentication, denial/redaction, current-profile/tool revalidation, limits, cancellation, nested accounting, guidance delivery and actual package installation/removal outside the checkout, and exclusion of private temporary evidence from both packaging paths. Generated evidence stays in gitignored `tmp/` directories.

Clean dependency installation and full repository validation passed in an isolated copy. The [synthetic evaluation](test/evaluation/README.md) separately exercised real-model selection/abstention and bounded quality; it does not validate real SQL semantics or production repairs. See [design and outstanding acceptance](DESIGN.md), [architecture research](RESEARCH.md), and [release gates](RELEASE.md). Detailed operational benchmark evidence is retained privately; public reports contain only aggregate results and limitations.
