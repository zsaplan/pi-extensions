# raincatcher Design

## Purpose

This document defines the package-level design for `raincatcher`.

It should be read alongside:

- the repo-level design in [`../DESIGN.md`](../DESIGN.md)
- the shared Rain library boundary in [`../rain-core/CODEBASE.md`](../rain-core/CODEBASE.md)

The root document defines package orchestration. `rain-core` defines the shared deterministic substrate. This file defines the design of `raincatcher` itself.

---

## Package role

`raincatcher` is the **knowledge capture extension** in the Rain package family.

Its job is to observe Pi work, extract only durable reusable facts from recent interaction context, and write those facts into canonical markdown knowledge files.

In the Rain workflow, `raincatcher` is the package that turns ephemeral agent work into a persistent knowledge base.

---

## Responsibilities

This package owns:

- observing relevant session and tool activity
- constructing a bounded recent-interaction or branch-harvest prompt for the model
- extracting durable candidate facts conservatively
- filtering and rejecting secret-looking or malformed outputs
- writing valid canonical fact bullets into KB files
- persisting session-local capture history through custom session entries
- emitting file-write events that downstream packages can react to
- exposing a small command surface to inspect or control capture behavior

This package does **not** own:

- deduplicating the knowledge base beyond local append-time duplicate avoidance
- semantic cleanup of already-written knowledge
- evidence-backed query answering over the knowledge base
- general-purpose document editing outside the canonical fact format

Those concerns belong primarily to `raindistiller`, `rainman`, and `rain-core`.

---

## Design goals

### 1. Capture only durable knowledge

The package should prefer missing a weak fact over storing a transient or low-value one.

### 2. Protect canonical structure

All writes should preserve the canonical structured Rain fact format.

### 3. Avoid secret capture

Secret-looking content should be redacted, filtered, or skipped.

### 4. Stay quiet and low-friction

Capture should feel ambient rather than noisy.

### 5. Integrate cleanly with the rest of the Rain pipeline

Writes should produce inputs that downstream Rain packages can trust.

---

## Extension surface

## Event-driven capture

`raincatcher` observes session activity such as:

- agent lifecycle events
- tool calls and tool results
- session start/tree/shutdown boundaries

The package accumulates a small bounded view of recent interaction and uses that as extraction input when capture is triggered.

## Commands

The package exposes:

- `/raincatcher`
- `/raincatcher on`
- `/raincatcher off`
- `/raincatcher harvest`

The command surface stays intentionally small. Operational complexity should remain inside the capture policy rather than in many user-facing command modes.

---

## Runtime architecture

`raincatcher` has four main layers.

## 1. Observation layer

This layer listens to session and tool events and records only the recent bounded context needed for extraction.

The design intent is:

- preserve just enough nearby context for good fact extraction
- avoid treating the whole session as always-live extraction input
- reset transient prompt state at sensible boundaries

## 2. Extraction layer

This layer builds a model prompt from recent messages and observed tool activity, then asks the model for a small JSON list of candidate facts.

The extraction policy is deliberately conservative:

- durable facts only
- canonical structured grammar only
- bounded fact count
- no secret-looking content

## 3. Validation and normalization layer

This layer normalizes candidate facts and rejects anything that does not fit the Rain data contract.

The canonical syntax and parsing rules come from `rain-core`, not from this package.

## 4. Persistence and signaling layer

This layer appends accepted facts to knowledge files, records session-local capture entries, updates status UI, and emits `raincatcher:files-written` events for downstream automation.

This signaling is how `raindistiller` can auto-distill fresh writes without `raincatcher` owning the distillation policy.

---

## Knowledge model

The knowledge base is a set of markdown files under a resolved KB root.

`raincatcher` should only write files that follow the canonical Rain fact-file contract:

- canonical heading
- canonical structured fact bullets
- filename derived from subject/topic

The package should never knowingly append mixed-format content to malformed files. If an existing target file is malformed, `raincatcher` should skip it rather than degrade the corpus.

---

## Capture model

There are two main capture modes.

## 1. Ambient prompt-level capture

This is the normal passive mode. The extension observes recent interaction and captures after meaningful agent work completes.

## 2. Explicit branch harvest

`/raincatcher harvest` re-reads the current session branch more broadly and extracts durable facts from that branch context.

This exists for cases where the useful facts are distributed across more of the session than the smaller ambient window captures well.

---

## State and persistence model

## In-memory state

The package keeps transient state for:

- enabled/disabled capture mode
- current busy state
- bounded recent tool inputs/results
- last-run and session totals

## Session persistence

The package appends custom session entries representing successful captures.

Those entries allow resumed sessions and tree navigation to restore counts and recent capture state without requiring an external database.

## File persistence

Accepted facts are written to KB markdown files under the resolved knowledge root.

---

## Secret-handling model

A core design constraint is to avoid persisting secrets into the knowledge base.

The package therefore treats secret-like content conservatively by:

- redacting obvious secret patterns from captured context
- filtering candidate facts that still look secret-like
- bounding and normalizing extracted text before it becomes a fact candidate

This package does not claim perfect secret detection, but it is designed to strongly prefer false negatives in capture over false positives in persistence.

---

## Coupling and dependencies

## Coupling to `rain-core`

`raincatcher` depends on `rain-core` for the shared deterministic fact contract, including:

- KB root resolution
- canonical filename/heading derivation
- structured fact parsing and rendering
- linting and syntax guidance

That coupling is intentional and fundamental.

Per the repo-level design, this dependency should ultimately be expressed as an explicit package dependency and public API boundary rather than as a repo-relative source import.

## Coupling to other Rain packages

`raincatcher` intentionally produces data and events consumed by:

- `raindistiller`
  - reacts to `raincatcher:files-written`
  - distills or semantically cleans captured knowledge
- `rainman`
  - reads the resulting KB as a stable knowledge cache

`raincatcher` is therefore a producer package in the Rain pipeline.

---

## Failure model

The package should fail conservatively.

Expected behavior:

- no active model or auth means do nothing rather than crash
- malformed existing fact files should be skipped rather than mixed with new writes
- invalid model output should be ignored rather than force-written
- secret-looking candidate facts should be dropped

The design goal is corpus safety over aggressive capture rate.

---

## Validation model

`raincatcher` should eventually own a package-local `verify` contract aligned with the root design.

That verification will likely center on:

- linting
- typechecking
- any targeted deterministic tests that become useful for prompt construction, filtering, or write behavior

The root should orchestrate those checks. It should not own them.

---

## Packaging model

`raincatcher` should be understandable as an independently documented extension package, while still participating in the broader Rain system.

Its packaging model should make the following explicit:

- it is an extension package
- it depends on the shared `rain-core` contract
- it produces a KB that downstream Rain packages can consume

The package should not rely on implicit sibling source-tree coupling long term.

---

## Tradeoffs

This design intentionally favors:

- conservative capture over maximal recall
- canonical structure over flexible prose capture
- low-noise status reporting over chatty UI
- interoperability with downstream Rain packages over package-local cleverness

Those tradeoffs are appropriate because bad knowledge is more damaging than missing knowledge.

---

## Summary

`raincatcher` is designed as the front door of the Rain knowledge pipeline:

- observe recent Pi work
- extract a small set of durable facts
- validate against the canonical Rain contract
- write safe structured knowledge files
- signal downstream packages when new knowledge appears

Its core design principle is conservative durable capture in service of a trustworthy shared knowledge base.