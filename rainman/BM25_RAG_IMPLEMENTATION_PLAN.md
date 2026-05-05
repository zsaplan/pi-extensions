# Rainman BM25-First Retrieval Implementation Plan

## Mission

Add deterministic BM25 retrieval to `rainman` so stable Raincatcher knowledge lookups become faster, cheaper, and easier to evaluate while preserving Rainman's core correctness contract: answers must be grounded in lint-clean fact files with exact, validated citations.

This is a planning document only. It intentionally does not implement the solution.

## Starting context

- Package: `@zsaplan/pi-rainman`
- Runtime entry: `rainman/src/index.ts`
- Current lookup tool: `rainman_lookup(question)`
- Current evidence corpus: lint-clean Raincatcher markdown fact files under the resolved KB root.
- Current isolated lookup tools: `find`, `grep`, `read`, and `submit_result`.
- Current deterministic ranking: `rankCandidateFactFiles()` scores filenames using token matching and suffix boosts.
- Current validation strengths:
  - malformed fact files are excluded from evidence;
  - citation files must be lint-clean;
  - citation line ranges must be valid;
  - citation quotes must exactly match source file contents;
  - every populated answer field must be cited.

## Desired end state

Rainman should use BM25 as the default deterministic retrieval layer and keep exact citation validation. The implementation should support a staged rollout:

1. **BM25 prefetch mode**: BM25 ranks candidate fact lines/files before the existing isolated agent runs. The agent still uses `read` and `submit_result`, but starts from better candidate evidence.
2. **BM25-only synthesis mode**: BM25 retrieves top evidence snippets deterministically, then a single constrained synthesis step produces a `VerificationResult` that is validated with the existing citation checks. No agentic `find`/`grep` navigation is required in this mode.
3. **Fallback mode**: when BM25-only synthesis returns `insufficient_evidence`, conflict uncertainty, or malformed output, Rainman can optionally fall back to the current agentic lookup loop.

## Scope

- Add package-local deterministic BM25 retrieval for Rainman over lint-clean fact files.
- Preserve current citation and field-coverage validation.
- Preserve current `rainman_lookup` response shape.
- Add tests for retrieval ranking, citation-safe snippet construction, and rollout behavior.
- Extend eval coverage to compare current agentic lookup, BM25 prefetch, and BM25-only synthesis.

## Non-goals

- Do not add embeddings, a vector database, or external search service.
- Do not remove the current agentic lookup path in the first implementation pass.
- Do not weaken exact quote or line-range validation.
- Do not make `rain-core` own BM25 until another package has a concrete reuse need.
- Do not treat filename matches, grep hits, or BM25 scores as evidence unless the source lines are read from lint-clean files and validated.

## Proposed architecture

### 1. Retrieval document model

Create a Rainman-local retrieval layer that indexes lint-clean files from `buildFactFileIndex(kbRoot)`.

Recommended initial retrieval unit:

- one structured fact bullet as the primary document;
- include heading, subject/topic filename tokens, relation, object, qualifiers, and raw bullet text in the indexed text;
- preserve `file`, `startLine`, `endLine`, `quote`, `heading`, and parsed structured fact metadata for citation construction;
- optionally create a small file-level aggregate view for tie-breaking and candidate file summaries.

Rationale: bullet-level retrieval keeps snippets small and citation-ready, while filename and heading tokens preserve the benefits of the current candidate ranking.

### 2. Tokenization and BM25 scoring

Implement a deterministic tokenizer with no runtime dependency unless a dependency clearly pays for itself.

Initial tokenizer rules:

- lowercase;
- split on non-alphanumeric boundaries;
- split camelCase/PascalCase and snake/kebab file tokens;
- drop a small stopword list;
- keep tokens longer than two characters;
- do not use semantic expansion in the first pass.

Scoring:

- implement Okapi BM25 with fixed defaults such as `k1 = 1.2` and `b = 0.75`;
- compute IDF from the lint-clean retrieval document set;
- expose matched query terms for diagnostics;
- use deterministic tie-breaking by score, file path, then line number.

Keep the existing suffix preference idea as explicit boosts only after baseline BM25 tests exist. If used, make boosts small and visible in diagnostics.

### 3. Retrieval API

Add a small internal API, likely in a new Rainman source module once package structure allows it:

```ts
type Bm25EvidenceCandidate = {
  file: string;
  startLine: number;
  endLine: number;
  quote: string;
  score: number;
  matchedTerms: string[];
  heading: string | null;
};

function retrieveBm25Evidence(
  question: string,
  kbRoot: string,
  fileIndex: FactFileIndex,
  options?: { limit?: number; perFileLimit?: number },
): Bm25EvidenceCandidate[];
```

The retrieval function should never include malformed files and should never synthesize quote text. Quotes must come from source file lines.

### 4. BM25 prefetch integration

Update the existing agent prompt construction so BM25 candidates replace or augment `rankCandidateFactFiles()`.

Important guardrail:

- candidate snippets in the prompt are navigation hints unless the implementation explicitly updates the evidence model;
- the existing agent should still call `read` before citing evidence in prefetch mode.

This gives a low-risk first milestone: faster/better candidate selection without changing the final validation model.

### 5. BM25-only synthesis path

After prefetch mode is covered by tests and evals, add an optional BM25-only path:

1. Build the lint-clean file index.
2. Retrieve top BM25 candidates.
3. If no candidate crosses a conservative threshold, return `insufficient_evidence` without a model call.
4. Send only the top retrieved snippets plus citation metadata to a constrained one-shot synthesis prompt.
5. Require the model to return the same `VerificationResult` structure used by `submit_result`.
6. Validate with the existing `validateResult()` path.
7. If validation fails, retry once with validation error context or return/fallback safely.

The synthesis prompt should be explicit that it may only cite provided snippets and should prefer `insufficient_evidence` over guessing.

### 6. Rollout controls

Add a retrieval mode control so behavior can be tested safely:

- `agent`: current behavior;
- `bm25_prefetch`: BM25 candidate ranking plus current agentic `read`/`submit_result` path;
- `bm25_only`: deterministic BM25 retrieval plus one-shot synthesis;
- `bm25_then_agent`: BM25-only first, fallback to current agentic lookup when needed.

The default should initially remain the current behavior or `bm25_prefetch` only after tests/evals demonstrate no regressions.

Expose the active mode in `/rainman` diagnostics and lookup execution metadata.

### 7. Evaluation plan

Extend `rainman/evals/default.json` or add a BM25-specific eval suite with cases for:

- exact filename/topic matches;
- vocabulary mismatch where BM25 may struggle;
- source-of-truth path questions;
- known insufficient-evidence nonces;
- conflicting evidence when the KB contains competing facts;
- expected citation files and quote substrings.

Track at least:

- lookup status accuracy;
- expected citation file hit rate;
- answer required concepts;
- elapsed time;
- token usage;
- fallback rate;
- validation failure rate.

### 8. Test plan

Add deterministic unit tests before enabling any new default behavior:

- tokenizer handles prose, paths, snake case, kebab case, and camel case;
- BM25 ranks an exact subject/topic match above noisy related files;
- bullet-level candidates include exact source quotes and valid line ranges;
- malformed files are excluded from the BM25 corpus;
- tie-breaking is deterministic;
- empty or stopword-only queries return no candidates safely;
- prefetch prompt includes candidate files in expected order;
- BM25-only synthesis validates citations and rejects quote mismatch/uncited fields;
- mode parsing defaults safely for unknown environment values.

### 9. Validation commands

For implementation PRs, run from the repository root:

```bash
npm run verify --workspace rainman
npm run verify
```

If retrieval code is later moved to `rain-core`, also run:

```bash
npm run verify --workspace rain-core
npm run verify --workspace rainman
```

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| BM25 misses semantically equivalent facts | Keep fallback mode, add eval cases for vocabulary mismatch, consider deterministic alias expansion only after measuring failures. |
| Top-k retrieves one side of a conflict | Retrieve enough per-file diversity and add conflict-specific evals. |
| Snippet-level retrieval loses heading/context | Include heading and filename tokens in retrieval metadata and synthesis input. |
| Citation validation weakens during refactor | Reuse `validateResult()`, `validateCitations()`, and exact quote checks unchanged. |
| New default behavior regresses answers | Ship behind a mode flag, compare eval results, and switch defaults only after evidence. |
| BM25 implementation grows into shared infrastructure too early | Keep Rainman-local until another package needs the same API. |

## Suggested implementation milestones

### Milestone 1: deterministic retrieval foundation

- Add tokenizer, BM25 scorer, retrieval document builder, and candidate API.
- Add deterministic tests for ranking and source-line preservation.
- No runtime behavior change.

### Milestone 2: BM25 prefetch mode

- Add retrieval mode parsing.
- Feed BM25-ranked candidate files into the current isolated agent prompt.
- Keep `read`/`submit_result` validation unchanged.
- Add eval comparison against current behavior.

### Milestone 3: BM25-only synthesis experiment

- Add one-shot synthesis path using retrieved snippets.
- Validate with existing result validators.
- Add fallback behavior and diagnostics.
- Keep mode opt-in.

### Milestone 4: default-mode decision

- Compare eval data across modes.
- If BM25 prefetch improves or preserves accuracy while reducing latency, make it default.
- Consider BM25-only default only if validation failure and fallback rates are acceptably low.

## Acceptance criteria for the future implementation

- Rainman can run in current agentic mode unchanged.
- BM25 retrieval excludes malformed fact files.
- BM25 candidates carry exact source quote and line metadata.
- Existing citation validation remains the final authority for answered/conflict results.
- Tests cover tokenizer, ranking, candidate construction, modes, and validation failure paths.
- Evals report enough data to decide whether BM25 prefetch or BM25-only should become default.
- `/rainman` surfaces active retrieval mode and recent fallback/validation diagnostics.
