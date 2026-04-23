# raindistiller Design

## Purpose

This document defines the package-level design for `raindistiller`.

It should be read alongside:

- the repo-level design in [`../DESIGN.md`](../DESIGN.md)
- the shared Rain library boundary in [`../rain-core/CODEBASE.md`](../rain-core/CODEBASE.md)

This file describes the design of the distillation package itself rather than the repo or shared library layers.

---

## Package role

`raindistiller` is the **knowledge base maintenance extension** in the Rain package family.

Its job is to keep the Rain knowledge base usable by:

- removing duplicate durable facts conservatively
- optionally performing semantic cleanup rewrites on structurally valid files
- preserving enough auditability and validation to avoid damaging the corpus

In the Rain workflow, `raindistiller` sits downstream of `raincatcher` and upstream of `rainman` quality expectations.

---

## Responsibilities

This package owns:

- reacting to newly written Raincatcher fact files in automatic mode
- supporting explicit manual distillation commands
- scanning selected KB files against the broader KB for duplicate candidates
- asking the model to adjudicate ambiguous duplicate groups conservatively
- applying accepted duplicate removals safely
- proposing and validating semantic cleanup rewrites
- recording session-local run history and status information
- surfacing a user-visible summary of distillation work

This package does **not** own:

- initial fact capture from live agent interaction
- the canonical structured fact grammar itself
- knowledge lookup/query answering
- broad policy about when the KB should exist or where it lives outside shared `rain-core` resolution rules

---

## Design goals

### 1. Improve KB quality without damaging trust

The package should never optimize cleanup aggressiveness at the cost of corpus integrity.

### 2. Keep deterministic and model-based responsibilities separate

Deterministic scanning, validation, and mutation gating should remain distinct from model adjudication.

### 3. Support both automatic and operator-driven workflows

Auto-distill should be low-friction after capture, while manual distill should support deeper cleanup.

### 4. Preserve auditability

When the package changes files, there should be enough structured output and backup behavior to understand what happened.

---

## Extension surface

## Event-driven mode

When loaded with `raincatcher`, this package can listen for `raincatcher:files-written` events and auto-distill the affected files.

## Command surface

The package exposes:

- `/raindistiller`
- `/raindistiller on`
- `/raindistiller off`
- `/raindistiller distill`
- `/raindistiller distill --file ... --dir ...`
- semantic-cleanup on/off flags for manual runs

The design intent is to keep the command model understandable while still allowing targeted manual control when the KB needs deliberate cleanup.

---

## Runtime architecture

`raindistiller` has four main layers.

## 1. Selection and orchestration layer

This layer determines:

- which files are in scope
- whether the run is automatic or manual
- which thinking level to use
- whether semantic cleanup is enabled for the run
- how progress and status should be reported

## 2. Deterministic scan layer

This layer, mostly backed by `rain-core`, is responsible for:

- resolving selected markdown files
- linting the KB
- finding duplicate candidate groups
- identifying semantic cleanup warnings
- enforcing structural validation gates

This layer should remain deterministic and testable.

## 3. Model adjudication layer

This layer uses the active model conservatively for judgments that are difficult to reduce to pure deterministic rules, such as:

- whether near-duplicate occurrences are truly duplicate enough to dedupe
- whether a semantic cleanup rewrite is safe and worthwhile

The model is a reviewer, not an unconstrained editor.

## 4. Safe mutation layer

This layer applies changes only after deterministic validation succeeds.

It is responsible for:

- queued file mutation
- removing deduped bullet lines
- deleting empty raincatcher-generated fact files when appropriate
- backing up files before accepted semantic rewrites
- rejecting rewrites that worsen structural validity or semantic warning quality

This layer is where corpus protection is enforced.

---

## Dedupe model

Dedupe is intentionally conservative.

High-level flow:

1. scan for exact and near-duplicate candidate groups
2. use deterministic heuristics to present useful candidates
3. ask the model to choose between `dedupe` and `keep_all` when needed
4. validate the decision
5. remove only the losing occurrences

Design preferences include:

- prefer keeping existing KB occurrences over newly captured duplicates when equally good
- prefer valid structured occurrences over malformed or legacy ones
- prefer `keep_all` over risky flattening of meaning

---

## Semantic cleanup model

Semantic cleanup is a second-stage workflow for structurally valid files.

Its purpose is not to re-author the KB freely. Its purpose is to improve semantically degraded but structurally valid fact lines when deterministic lint rules can point to a safer direction.

High-level flow:

1. identify semantic warnings in valid files
2. ask the model for line-targeted rewrite or skip actions only
3. validate proposed replacements structurally
4. accept only changes that reduce semantic warning burden without breaking structure
5. back up prior content and record audit details
6. optionally rerun targeted dedupe after accepted rewrites

This staged approach keeps semantic cleanup narrow and auditable.

---

## State and persistence model

## In-memory state

The package tracks transient state for:

- auto/manual mode
- busy/progress status
- pending files
- current KB warning counts
- last-run summary

## Session persistence

The package appends custom session entries for completed runs so resumed sessions can restore:

- run counts
- duplicates removed
- semantic issues resolved
- modified files
- most recent run metadata

## Backup and audit persistence

Semantic cleanup may create backup material and audit details so accepted rewrites remain inspectable.

Those artifacts exist to preserve trust in mutation, not to become a separate durable product surface.

---

## UI model

`raindistiller` is designed to be visible but not intrusive.

It uses:

- footer/status updates for current mode, progress, and recent totals
- summary notifications for auto and manual runs
- a custom message renderer for expandable run summaries

The UI should help an operator understand what happened without requiring a separate dashboard.

---

## Coupling and dependencies

## Coupling to `rain-core`

`raindistiller` depends heavily on `rain-core` for deterministic capabilities such as:

- KB root handling
- markdown selection
- parsing and linting
- duplicate candidate generation
- semantic warning detection primitives

That dependency is intentional. Per the repo-level design, it should ultimately be expressed as an explicit package dependency and public API boundary rather than a repo-relative source import.

## Coupling to `raincatcher`

`raindistiller` is intentionally coupled to `raincatcher` through:

- the `raincatcher:files-written` event
- the expectation that newly captured KB files follow the Rain fact contract

This coupling is optional at runtime but central to the auto-distill workflow.

## Coupling to `rainman`

There is no direct runtime call coupling, but `raindistiller` indirectly supports `rainman` by improving KB quality and consistency.

---

## Failure model

The package should fail conservatively.

Expected behavior:

- malformed selected files should be skipped rather than force-fixed in-place
- model decisions that fail validation should be ignored or rejected
- semantic cleanup should not run on structurally invalid files
- file mutations should be serialized to avoid conflicting writes
- warnings should be preserved and surfaced rather than hidden

The package is designed to prefer under-cleaning over destructive cleanup.

---

## Validation model

This package has a meaningful mix of deterministic and model-mediated behavior.

Its package-local validation should eventually center on:

- linting
- typechecking
- deterministic tests for mutation, semantic cleanup gating, and duplicate handling logic

The root should orchestrate those checks, but the package should own them.

---

## Packaging model

`raindistiller` should remain an independently documented extension package that happens to participate in the broader Rain system.

Its packaging should make explicit that:

- it is an extension package
- it depends on `rain-core`
- it optionally integrates with `raincatcher`
- it owns its own distillation and semantic cleanup policy

Long term it should not depend on implicit sibling source imports for correctness.

---

## Tradeoffs

This design intentionally favors:

- corpus safety over aggressive cleanup
- deterministic validation over model freedom
- conservative `keep_all` behavior over false duplicate merges
- explicit manual cleanup controls in addition to automatic maintenance

Those tradeoffs are essential because the package is a mutator of shared knowledge, not just a reader.

---

## Summary

`raindistiller` is designed as the cautious maintenance layer of the Rain system:

- receive new knowledge or explicit operator scope
- scan deterministically for cleanup opportunities
- use the model only as a conservative adjudicator
- apply only validated mutations
- leave the KB cleaner without undermining trust

Its core design principle is safe, auditable knowledge-base cleanup.