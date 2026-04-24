# rainman Design

## Purpose

This document defines the package-level design for `rainman`.

It should be read alongside:

- the repo-level design in [`../DESIGN.md`](../DESIGN.md)
- the shared Rain library boundary in [`../rain-core/CODEBASE.md`](../rain-core/CODEBASE.md)

This file describes the design of the lookup package itself.

---

## Package role

`rainman` is the **knowledge lookup extension** in the Rain package family.

Its job is to turn the Rain knowledge base into a correctness-first lookup tool for stable, previously-derived understanding.

In the Rain workflow:

- `raincatcher` captures knowledge
- `raindistiller` improves corpus quality
- `rainman` retrieves validated answers from that corpus

---

## Responsibilities

This package owns:

- deciding when to nudge the primary agent toward Rainman-first lookup
- registering the `rainman_lookup` tool
- building a lint-aware view of the knowledge base
- running an isolated lookup sub-session with a very small tool surface
- validating citations and result structure before returning an answer
- reporting session-local lookup metrics, in-flight progress feedback, retained diagnostics, and self-test status
- exposing a small `/rainman` command surface
- shipping a companion skill that teaches the intended lookup/pivot workflow

This package does **not** own:

- initial knowledge capture
- deduplication or semantic cleanup of the knowledge base
- live-state incident investigation
- unrestricted repo or system exploration

---

## Design goals

### 1. Correctness over recall

If the KB cannot safely answer, `rainman` should return insufficient evidence rather than guess.

### 2. Evidence-backed results only

Returned data should be grounded in explicit citations from lint-clean knowledge files.

### 3. Strongly bounded lookup execution

The isolated lookup agent should have only a tiny tool surface and a narrow purpose.

### 4. Reuse prior durable knowledge before re-deriving it

The package should reduce repeated rediscovery of stable project knowledge.

### 5. Stay out of live-state questions

The package should avoid pretending a knowledge cache can answer current incidents or very recent changes.

---

## Extension surface

## Tool

Primary tool:

- `rainman_lookup(question)`

The tool returns:

- concise visible text
- structured details containing the evidence result plus separate execution metadata, diagnostics, and retained artifact references when available
- concise progress feedback while a lookup is running, including working/status updates for long-running isolated lookup turns
- completion summaries that include elapsed time and token usage when the isolated lookup session reports usage

Primary statuses are:

- `answered`
- `insufficient_evidence`
- `conflict`

## Prompt nudge

The package also hooks into prompt start behavior so the primary agent is reminded to consider Rainman first for likely-stable knowledge questions.

This nudge is advisory. It is not meant to force lookup for every question.

## Command surface

The package exposes:

- `/rainman`
- `/rainman test`

The command surface exists for status inspection and smoke testing, not for broad interactive query mode.

## Skill

The package ships a checked-in `rainman` skill that teaches when to consult cached stable knowledge, how to use each lookup status, and when to pivot to normal investigation.

---

## Runtime architecture

`rainman` has five main layers.

## 1. Routing and nudge layer

This layer uses prompt heuristics to determine when a Rainman-first reminder should be appended to the agent system prompt.

Its purpose is to steer stable-knowledge questions toward lookup without misrouting live-state investigation.

## 2. KB indexing and validation layer

This layer builds a knowledge-base view that distinguishes:

- lint-clean fact files that are safe to use as evidence
- malformed files that should be excluded from evidence
- warnings about corpus health

This layer depends on `rain-core` for the fact contract and linting behavior.

## 3. Isolated lookup-agent layer

This layer runs a separate Pi session with a tiny custom tool surface:

- `find`
- `grep`
- `read`
- `submit_result`

The isolated agent is responsible for navigating the KB and submitting a structured answer. It is not allowed arbitrary repo exploration.

## 4. Result validation layer

This layer ensures the final returned answer is acceptable before exposing it:

- structured schema validation
- citation validation
- normalization of failures into safe fallback statuses when necessary

This layer is essential because the package promise is evidence-backed lookup, not just model-generated summary.

## 5. Reporting and diagnostics layer

This layer turns isolated lookup activity into operator-usable feedback and later debugging evidence:

- streamed progress updates and status-only activity messages
- working/status UI updates
- execution metadata such as elapsed time and token usage
- failure diagnostics including session messages and tool-access state
- JSONL run artifacts under the agent data directory when artifact mode retains them, including retained raw lookup tool output for later debugging

Artifacts are diagnostic infrastructure. The default mode keeps failed lookup trails and discards successful trails; `PI_RAINMAN_DEBUG_ARTIFACTS=always` keeps every trail, while `off` disables artifact retention.

---

## Evidence model

`rainman` should answer only from lint-clean Rain fact files under the configured KB root.

Design rules:

- navigation tools are not evidence
- only read output counts as evidence
- every populated answer field should be traceable to citations
- malformed files should not silently contaminate answers
- conflicting KB evidence should surface as `conflict`, not be merged optimistically

This is the core correctness model of the package.

---

## Knowledge scope model

The package is intentionally scoped to **stable previously-derived knowledge**, such as:

- workflows
- conventions
- preferences
- source-of-truth locations
- ownership or repo boundaries
- recurring explanations
- durable conclusions already captured in the KB

It is intentionally not designed for:

- active outages
- current logs or traces
- very recent code changes
- transient operational state

That scoping is necessary to keep lookup semantics honest.

---

## State and persistence model

## In-memory state

The package tracks transient state for:

- active lookup runs
- session-local query counts
- hit counts
- error counts
- most recent run metadata, warning counts, malformed-file counts, token usage, and artifact path

## Session persistence

Lookup summaries and retained artifact references are appended as custom session entries so session-local metrics survive resume and branch navigation.

The KB itself remains the durable source of evidence; the session entries and artifacts are operational telemetry and diagnostics.

---

## Coupling and dependencies

## Coupling to `rain-core`

`rainman` depends on `rain-core` for:

- KB root handling
- linting and malformed-file exclusion
- structured fact parsing/rendering support
- path-safety and markdown file helpers

Per the repo-level design, this dependency is expressed as an explicit package dependency and public API boundary. `rainman` should continue to consume `rain-core` through that package boundary rather than by reaching into sibling source paths.

## Coupling to `raincatcher`

`rainman` is coupled to the knowledge format and corpus produced by `raincatcher`.

That coupling is intentional: Rainman is not a generic markdown QA tool. It is a lookup layer over the Rain fact corpus.

## Coupling to `raindistiller`

There is no direct runtime call dependency, but `rainman` benefits from the higher-quality corpus produced when `raindistiller` keeps the KB clean.

---

## Failure model

The package should fail safely and explicitly.

Expected behavior:

- no configured/available model should fail clearly
- missing or malformed KB content should reduce confidence rather than be hidden
- tool-scaffolding failures in the isolated agent should surface as explicit errors with retained diagnostics when artifact mode allows it
- an unanswered lookup should return `insufficient_evidence`, not a fabricated answer
- conflicting evidence should return `conflict`

The package is designed to be trusted precisely because it is willing to say “I do not know from the KB.”

---

## Validation model

`rainman` should eventually own a package-local `verify` contract aligned with the root design.

That contract will likely center on:

- linting
- typechecking
- targeted deterministic tests for routing heuristics, citation validation, KB indexing, streamed tool-output formatting, usage aggregation, and artifact-mode behavior where worthwhile
- package-local smoke validation such as the built-in self-test path

The root should orchestrate those checks rather than reimplement them.

---

## Packaging model

`rainman` should remain understandable as a standalone extension package, even though it participates in the broader Rain system.

Its package boundary should make explicit that:

- it is a lookup extension
- it depends on the Rain KB contract and shared `rain-core` APIs
- it is not a live-state observability or repo-search replacement

Long term it should not depend on implicit sibling source imports for correctness.

---

## Tradeoffs

This design intentionally favors:

- evidence-backed answers over broad recall
- narrow isolated tools over convenience
- explicit `insufficient_evidence` over guesswork
- stable-knowledge routing over live-state ambition

Those tradeoffs are central to the value proposition of the package.

---

## Summary

`rainman` is designed as a correctness-first lookup layer over the Rain knowledge base:

- nudge the agent toward cached stable knowledge when appropriate
- run a tightly constrained lookup session
- return only evidence-backed structured results
- refuse to overclaim when the KB is weak or conflicting

Its core design principle is trustworthy retrieval of durable prior understanding.