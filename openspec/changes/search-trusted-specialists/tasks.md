# Implementation and acceptance

Status: 23/23 tasks complete. H1–H4 passed for this bounded synthetic pilot, including both real-model sweeps with Sol/medium children. Ready for sync/archive; neither has been performed. Production repair/application acceptance remains separate. Clean installation and repository validation now pass; normal installed-session acceptance still requires an approved rollout. Historical baseline evidence is in [the existing design](../../../profile-subagent/DESIGN.md).

## 1. Freeze the evaluation contract

- [x] 1.1 Add the 18 labeled tasks from [design.md](design.md): 12 clear (four per family), three ambiguous, three unsupported; mark six clear cases development and six held-out before tuning.
- [x] 1.2 Add synthetic evidence and human-readable answer keys for six evidence-complete and three evidence-gap cases; include postfix planner/reviewer routing, configuration changes, and documentation contradictions.
- [x] 1.3 Define the real-model evaluation harness and rubric, keeping expected labels/answer keys outside model-accessible evidence. Record fixed model/reasoning settings, corpus hashes, two-sweep results, usage, and repeatable invocation.

## 2. Add trusted metadata discovery

- [x] 2.1 Add optional tags without changing existing required manifest fields; share definition/resource validation and conflict checks across search and execution, preserving containment and content digests.
- [x] 2.2 Implement per-entry diagnostics for invalid/missing/escaping resources and duplicate declared IDs, while preserving unrelated valid entries; fail visibly when the registry cannot be read.
- [x] 2.3 Implement deterministic positive-match ranking, stable ties, query/limit validation, match explanations, tool-availability reporting, and the 24,000-character response bound.
- [x] 2.4 Register `profile_subagent_search` without domain-tool/model/launch side effects; preserve list and named-run compatibility, and revalidate current profiles/tools before execution.

## 3. Add narrow roles and neutral guidance

- [x] 3.1 Add reviewed `configuration-drift-reviewer` and `documentation-consistency-reviewer` profiles using only `read`, `grep`, `find`, and `ls`; include evidence-gap handling and explicit non-goals.
- [x] 3.2 Add routing metadata to the existing postfix profiles using development cases only; keep site/environment and repair requirements inside those profiles.
- [x] 3.3 Make shared tool guidance domain-neutral, with explicit role-fit/availability checks and clarification/no-delegation guidance.
- [x] 3.4 Reject broad `codemode` dispatch and recursive profile tools at validation; retain the all-tools parent bridge and fail-closed startup.
- [x] 3.5 Set the user-requested child default to catalog ID `openai-codex/gpt-6.1-sol` / medium independently of the parent. Verify model/thinking, matching-provider auth inheritance and cross-provider credential separation; preserve actual settings in evidence and validate one live child.

## 4. Verify mechanics and permission inheritance

- [x] 4.1 Extend the real-CLI/SDK E2E suite for ranking/ties/limits/no matches, bounded metadata/diagnostics, registry errors/conflicts, source containment, unavailable tools, and no search side effects.
- [x] 4.2 Add search-to-run cases for current profile digest and tools changed after search, parent denial/redaction, leaf-dispatch rejection, fresh context without generated OpenSpec resources, and direct named execution compatibility.
- [x] 4.3 Run `npm run verify --workspace profile-subagent` from the repository root. All 27 baseline scenarios and new cases must pass; record counts and evidence path for H4.
- [x] 4.4 Evaluate the frozen 12 clear queries: H1 requires top-three success of at least 11/12 overall, 3/4 per family, and 5/6 held-out. Record ranks and all misses, not only an aggregate.

## 5. Verify real-model decisions and work quality

- [x] 5.1 Run both 18-task sweeps in fresh parents using real model responses and synthetic read-only tools. No production data, writes, or repairs; do not script parent choices.
- [x] 5.2 Score H2 separately for each sweep: at least 11/12 correct clear-task discovery/selection, at least 3/4 per family, all ambiguous cases clarify without launch, and all unsupported cases avoid launch.
- [x] 5.3 Review H3 against answer keys in both sweeps: all six complete cases have correct material findings/evidence and no invented checks; all three gap cases preserve the missing prerequisite. A wrong selected role fails that end-to-end case.
- [x] 5.4 Preserve failures, usage, model/version/context details, and artifact references in a repeatable report. Leave failed gates unchecked; do not tune on held-out failures without a new held-out evaluation revision.

## 6. Complete documentation and acceptance

- [x] 6.1 Update package README/design for implemented search, bundled roles, result limits, and explicit parent tool activation; keep deferred catalog support and repair acceptance separate.
- [x] 6.2 Run root `npm run verify`, strict OpenSpec validation, and whitespace/reference checks. Record fresh evidence and retain the clean-install limitation until a clean install actually succeeds.
- [x] 6.3 Summarize H1–H4 pass/fail results and remaining limitations here. Archive/sync only after implementation and all required gates pass; OpenSpec artifact completeness is not acceptance.

## Sanitized acceptance record

Validated on Pi 0.99.2 / Node 26.10.0. The original discovery increment passed 27 baseline plus 20 discovery scenarios, followed by independent child-default and orchestration checks. The current suite has 80 scenarios (84 Node tests including containers); see [release readiness](../../../profile-subagent/RELEASE.md).

- H1: all 12 frozen clear queries ranked the expected role first, including all six held-out cases. Corpus SHA-256: `2a37904a850578167d3a9d740d06973914e05db0042d275c84594a6f5037e19f`. No held-out retuning.
- H4: scripted permission/isolation and search-to-run checks passed, including pre-coercion fractional-limit rejection, disabled/current tools, changed profiles and broad-dispatch rejection.
- Parent and child models/thinking were recorded independently. Child defaults are fixed at `openai-codex/gpt-6.1-sol` / medium; no substitution on failure.
- Package/root verification and strict OpenSpec validation passed. Clean public-registry dependency installation and real packed-package Pi lifecycle checks subsequently passed in isolated environments.
- Full session/model/tool records, original failures and review evidence remain private. Only synthetic fixtures and sanitized summaries are committed.

### Interrupted attempt retained

An earlier attempt ended with provider processing errors: one child returned empty output, then a parent failed before selection. Seven completed selections were correct and five scored child reports met their rubrics, but the run did **not** satisfy H2/H3. Parent fallback did not count as specialist quality. Controls and the second sweep did not run. No automatic model switch, threshold reduction or discarded failure was used to claim success.

### Completed real-model sweeps

Both fresh 18-task sweeps used an Astra/low parent and independent Sol/medium children with synthetic read-only tools. Runtime/profile/corpus/fixture hashes were unchanged during the run; there was no retuning or provider failure.

| Gate | Sweep 1 | Sweep 2 |
|---|---|---|
| H2 clear-task selection | 12/12; 4/4 per family | 12/12; 4/4 per family |
| H2 ambiguous clarification, no launch | 3/3 | 3/3 |
| H2 unsupported, no launch | 3/3 | 3/3 |
| H3 complete-case evidence review | 6/6 | 6/6 |
| H3 evidence-gap preservation | 3/3 | 3/3 |

All 24 children received exactly one explicit assignment without parent history. Reports were reviewed against rubrics by the assistant, not an independent blinded human reviewer. A separate cross-model smoke also passed.

A supplemental offline SQL-validator check accepted seven of eight synthetic requests. The rejected request combined two SELECT statements; synthetic transport had accepted it without executing SQL. That limits live SQL compatibility claims even though the defined evidence-handling rubric passed. Preserve live rejection/recovery and production repair acceptance as separate unchecked work in [DESIGN.md](../../../profile-subagent/DESIGN.md).

No production database, repair, site provisioning or threshold change was needed for the synthetic sweeps. Any future live-site test needs its own authorized target, isolation, scope and cleanup; none is authorized by these results.

## Development workflow status

OpenSpec 1.7.0 uses the standard `spec-driven` schema. Six project-local skills and prompts were generated without replacing the existing prompt or changing global settings. Interactive workflow discovery after reload remains unverified. Implementation/pilot tasks are complete; proposed behavior has not been synced or archived.

From the repository root:

```bash
OPENSPEC_TELEMETRY=0 openspec status --change search-trusted-specialists
OPENSPEC_TELEMETRY=0 openspec validate search-trusted-specialists --strict --no-interactive
```

Project resources require review/trust before loading. OpenSpec task completion is neither production acceptance nor approval to publish private evidence, execute a repair, merge or install globally.
