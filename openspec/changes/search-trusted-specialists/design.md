## Context

See [proposal.md](proposal.md) for motivation and the [behavior contract](specs/trusted-specialist-discovery/spec.md). The existing [runner design](../../../profile-subagent/DESIGN.md) and [architecture research](../../../profile-subagent/RESEARCH.md) remain authoritative for the baseline and source comparisons; this document covers only the next increment.

The branch already has named execution, two postfix roles, 27 deterministic E2E scenarios, and a limited live read-only smoke check. These do not prove task retrieval, model selection, or specialist quality. OpenSpec 1.7.0 is installed locally; its default `spec-driven` schema and generated Pi core workflows are development aids, not extension dependencies.

## Goals / Non-Goals

**Goals:** add the smallest metadata-search layer and demonstrate useful bounded delegation across three task families while preserving existing authority and lifecycle behavior.

**Non-goals:** no new execution framework or manifest-format migration. An independently installed operator catalog is deferred until needed; this pilot does not introduce source precedence or configuration for it. Other exclusions are in the proposal. Existing repair-workflow acceptance remains separate and unresolved.

## Decisions

### Keep discovery separate from execution

Extend profile metadata with optional `tags` (omitted means none), retaining existing IDs and required fields. Search the bundled registry on demand: four reviewed profiles need neither an index service nor persistent cache.

Validate each entry independently and return bounded diagnostics; identify conflicting declared IDs before choosing valid candidates. Reuse the current resource containment checks and content digest. Resources may be read locally to validate/hash them, but only metadata enters the parent's search response. An unreadable registry is a tool error. Keep direct named execution and list output compatible; execute the selected current profile, never a cached search object.

This is less machinery than external catalogs, search receipts, or embedding storage. It also means a search digest is evidence of what was examined, not a lock on future content.

### Use transparent deterministic ranking first

Normalize case and split IDs/descriptions/tags and queries into letter/number tokens. Ignore a small documented set of generic routing words (for example, “please”, “task”, “review”, “help”) for token scoring. Count each distinct query term once per field. Start with exact full-ID match first, then weighted token overlap (ID 4, tags 2, description 1), then lexical ID as the tie-breaker. Return only positive matches.

Return matching terms/fields, not probability claims. These weights are an initial implementation choice, not a correctness claim; adjust only against the development cases below. Do not silently add semantic expansion if held-out retrieval fails. Record misses and decide whether metadata changes suffice.

Apply the spec's input and output bounds; reserve space for explicit truncation indicators and diagnostic counts. Candidate availability means “all required tools currently callable,” not “the service will respond.” Missing-tool candidates remain visible rather than being hidden.

### Keep domain knowledge in profiles

Use the existing postfix planner/reviewer as one family, and add two read-only specialists:

| Family | Profiles | Narrow assignment | Capabilities |
|---|---|---|---|
| Postfix repair | Existing `postfix-repair-planner`, `postfix-repair-reviewer` | Plan or independently review one missing outcome; never execute repairs | Existing file tools and read-only DB tools |
| Configuration drift | New `configuration-drift-reviewer` | Compare two supplied, already rendered configuration snapshots; cite changed values and unresolved runtime impact | `read`, `grep`, `find`, `ls` only |
| Documentation consistency | New `documentation-consistency-reviewer` | Compare documented claims against supplied source/configuration; cite contradictions and evidence gaps | `read`, `grep`, `find`, `ls` only |

Configuration review does not render Helm or connect to clusters. Documentation review does not edit files, browse the web, or claim tests were run. Use existing turn/time defaults. Shared runner descriptions request task, scope, evidence, and expected output; exact site/environment requirements stay in postfix profiles.

For these leaf profiles, reject the existing recursive `profile_subagent_*` tools and the known broad `codemode` dispatcher. Review any future tool additions for equivalent indirect authority before admitting them. Do not pretend tool-name checks constitute a filesystem or OS sandbox.

### Child model default (user update)

Use the exact catalog model `openai-codex/gpt-6.1-sol` with medium thinking for every child, not the parent's selected model/thinking. The user's `gpt-6-1-sol` spelling resolves to this catalog ID. Keep this small fixed default in the runner; do not add per-task overrides, model routing, or a fallback. Copy provider registrations and runtime authentication only for the selected child provider. Preserve stored OAuth refresh and never send another provider's key. Save parent and child settings separately in input evidence and expose child model/thinking in results. Model or thinking mismatches fail before a child request.

Subsequent real-model evaluation must record both parent and child settings. Prior Astra/low evidence remains historical and does not satisfy acceptance for Sol/medium children.

### Preserve the runner boundary

Retain the SDK resource loader, all-tools parent bridge, auth inheritance, cancellation/limits, and private artifacts. No parent-history forwarding, ambient resource discovery, automatic tool activation, or local tool fallback is added. Run startup revalidates the profile and dependencies after search. Runtime completion and substantive quality remain separate; no new structured “repair approved” status is introduced.

### Evaluate hypotheses, not just plumbing

Before tuning metadata/ranking, freeze a small, labeled fixture corpus and human-readable answer keys. Use synthetic files and fake read-only DB responses, never production records. Fixtures should contain known discrepancies, clean comparisons, and evidence gaps. Expected labels and answer keys must not enter parent/child prompts.

Use 18 parent tasks: 12 clear tasks (four per family), three ambiguous tasks, and three unsupported tasks. Per family, two clear phrasings are development cases and two are held-out. Freeze the held-out texts before tuning. Include at least one paraphrase without a profile ID in each family. An ID-only query can test mechanics but cannot count toward task retrieval quality.

Representative seeds (not a substitute for the finalized corpus):

| Family/case | Example task | Expected decision |
|---|---|---|
| Postfix | “Explain the missing data-fix outcome and draft a safe correction from this audit evidence.” | Planner |
| Postfix | “Independently challenge this proposed postfix repair package.” | Reviewer |
| Configuration | “Compare these rendered deployment snapshots and identify changed resource values.” | Configuration role |
| Documentation | “Check whether these documented options agree with the supplied source.” | Documentation role |
| Ambiguous | “Review this change.” with no target or evidence | Ask a focused question; no run |
| Unsupported | “Create an original logo for this business.” | No specialist run |

The three ambiguous cases must genuinely lack information needed to choose, not merely mention two supported domains. Unsupported cases must be outside all role scopes. Parent prompts must not name the desired profile or instruct a particular tool sequence; use actual tool descriptions to observe whether discovery happens.

| Hypothesis | Evidence and pilot gate |
|---|---|
| H1: Metadata retrieval is sufficient | For the 12 clear queries, correct role appears in the top three in at least 11/12 overall, at least 3/4 per family, and at least 5/6 held-out. Report every rank/miss, including top-one results. |
| H2: The real parent chooses or abstains appropriately | Run the 18 tasks twice in fresh parent sessions with a fixed recorded model/reasoning setting. In each sweep, at least 11/12 clear tasks search and select the expected available role; at least 3/4 per family. All three ambiguous tasks ask for missing scope without launching; all three unsupported tasks avoid launching. Report both sweeps, not just the better one. |
| H3: Fresh context suffices for bounded work | Use three clear tasks per family: two evidence-complete cases and one material evidence-gap case. In both sweeps, all six complete cases must identify every answer-key material finding with correct evidence references and no invented checks; all three gap cases must explicitly preserve the missing prerequisite. Review child prompts/transcripts for hidden context. |
| H4: Delegation preserves authority | Existing 27 E2E scenarios plus new search-to-run regressions all pass, including denial/redaction of file and domain tools, missing/disabled tools after search, current digest, invalid/duplicate definitions, no-match/ambiguous guidance, broad-dispatcher rejection, and no search side effects. |

H1 and H4 use deterministic fixtures; H2 and H3 require real parent/child model runs. Scripted provider choices cannot establish H2 or H3. A wrong selection also fails that case's end-to-end H3 check; do not mask it by manually assigning the correct role. The fourth clear task per family exercises additional routing (including postfix reviewer selection); its execution still must obey the same safety rules.

These are pilot thresholds, not statistical proof of general reliability. If a gate fails, leave it unchecked and record the failure before revising the approach. Do not relabel a held-out case or lower a threshold to obtain a pass. Any tuning informed by held-out results requires a new held-out set and a reported evaluation revision.

### Make evidence repeatable

Keep the task corpus, answer keys, evaluator instructions, and invocation harness under `profile-subagent/test/`. Store generated deterministic evidence under `profile-subagent/tmp/e2e/` and real-model evidence under `profile-subagent/tmp/evaluation/`; retain the runner's normal private artifacts.

Evaluation records must include task/corpus revision, code revision plus dirty-worktree diff or content hashes, model/provider/reasoning, Pi/Node versions, run date, profile digests, candidates/ranks, parent decisions/tool calls, child artifact references, rubric outcomes, usage, and errors. Document one repeatable command for each suite. Add concise pass/fail totals and local evidence paths to tasks.md when actually run; do not commit raw sensitive transcripts.

## Risks / Trade-offs

- Keyword retrieval misses paraphrases → held-out queries and explicit misses; improve metadata before considering another retrieval mechanism.
- A small catalog or permissive prompt overstates success → separate task families, expected IDs, abstention cases, fresh sessions, and no answer-key leakage.
- Parent model chooses badly despite correct retrieval → evaluate H2 separately; no autonomous top-score launch.
- Synthetic tools do not prove production integration or repair correctness → preserve separate live/application acceptance in the baseline design.
- Broad read tools can access more than the assignment → retain parent controls and accurate limitations; instructions are not a resource sandbox.
- In-process timeouts are cooperative → retain existing tests and documentation, not a claim of hard termination.
- OpenSpec adds maintenance overhead → use one standard change and existing references; assess its usefulness after this pilot before expanding adoption.

## Migration Plan

1. Implement the additive manifest metadata and search tool; retain list and named-run interfaces.
2. Add the two reviewed profiles and domain-neutral guidance; run deterministic checks and then the explicit real-model evaluation.
3. Update runtime documentation only for implemented behavior, with acceptance evidence and unresolved work. Users with an explicit parent `--tools` selection must add `profile_subagent_search`; do not enable it automatically.
4. Archive/sync this change only after implementation and required acceptance checks pass. OpenSpec “artifacts complete” alone is not feature acceptance.
5. Roll back the search tool, additive metadata, and new profiles if needed; the existing named runner remains usable. There is no data migration or production mutation.

## Planning setup evidence

OpenSpec was initialized with `openspec init --tools pi --profile core --no-animation` in the existing feature worktree. Six standard Pi skills and six prompt templates were generated; the pre-existing prompt was preserved. No global Pi installation/settings or extension runtime dependencies were changed.

This setup does not establish H1–H4 for the proposed increment. Validation and outstanding work are recorded in [tasks.md](tasks.md).
