# polish-solution Design

## Purpose

This document defines the package-level design for `polish-solution`.

It should be read alongside the repo-level design in [`../DESIGN.md`](../DESIGN.md). The root document defines repo orchestration and package contracts. This file defines the design of this package specifically.

---

## Package role

`polish-solution` is a **multi-category review extension** for the current git worktree.

It provides:

- the `polish_solution_review` tool
- a checked-in `polish-solution` skill that teaches iterative review/remediate/rerun usage

Its purpose is to give the primary coding agent a structured way to ask isolated reviewers to examine the current diff for material correctness, robustness, design, simplification, standardization, pruning, and duplication risks.

---

## Responsibilities

This package owns:

- determining the fixed review scope from the current git worktree and a base ref
- creating isolated reviewer sub-sessions for each review category
- limiting that reviewer to a narrow, read-only inspection tool surface
- enforcing a structured category review result shape and aggregating suite results
- surfacing category reviewer progress, conflicts, and final results back to the caller
- persisting review diagnostics and debug artifacts for later inspection
- shipping the companion skill that teaches the intended workflow

This package does **not** own:

- automatic remediation of findings
- running the user's real validation commands after remediation
- generalized code review for arbitrary repositories outside the current git/worktree model
- extension-specific implementation logic outside the review tool and skill

---

## Design goals

### 1. Fixed-scope review

The reviewer should analyze a fixed diff scope derived from the current worktree, not a moving target.

### 2. Category focus

Each reviewer should bias toward its assigned objective rather than providing generic reassurance. The first-slice categories are adversarial, simplify, standardize, prune, and DRY.

### 3. Strong tool constraints

The isolated reviewer should have only the minimum read-only tools needed to inspect the fixed scope.

### 4. Structured machine-usable output

Results should be compact JSON with predictable fields so downstream usage stays simple.

### 5. Debuggability

When review behavior is surprising, there should be enough artifacts and diagnostics to understand what happened.

---

## Extension surface

## Tool

Primary tool:

- `polish_solution_review(baseRef?)`

The tool returns structured JSON with:

- review status
- summary
- aggregated findings
- per-category results
- deterministic conflict records
- execution metadata such as elapsed time and aggregate token usage

## Skill

Companion skill:

- `polish-solution`

The skill exists to teach the higher-level operating loop:

1. run the full review suite
2. remediate real findings or request direction for unresolved conflicts
3. run relevant validation
4. rerun the full suite from category 1 only after validation is back to green or understood

The skill is important because the tool alone does not enforce the surrounding workflow discipline.

---

## Runtime architecture

`polish-solution` has three main layers.

## 1. Scope construction layer

This layer determines what the reviewer is allowed to inspect and talk about.

It is responsible for:

- choosing a base ref
- finding the merge-base
- collecting tracked and eligible untracked changes
- materializing a fixed review diff
- rejecting empty or overly large scopes
- mapping changed files and valid line ranges

The design intent is that the reviewer receives a frozen scope, not unfenced live repository access.

## 2. Isolated reviewer layer

This layer runs one separate Pi agent session per review category with:

- a prompt composed from shared safety/output-schema instructions and the category objective
- a narrow read-only tool surface
- a structured `submit_review` completion path
- limited repair/retry behavior when the reviewer output is invalid

Each category reviewer is intentionally separated from the primary coding session and from the other category reviewers so the main agent can consume review output without reviewers inheriting broader tool power or shared mutable state by default.

## 3. Reporting and diagnostics layer

This layer:

- streams human-usable progress updates
- updates TUI status/working messages
- records structured debug artifacts under the agent data directory
- records category boundaries, category-tagged reviewer events, conflict analysis, and final suite snapshots
- surfaces parsed review metadata and hidden artifact references

This makes the tool usable interactively while still leaving behind evidence for later debugging.

---

## Review model

Each category reviewer is intentionally constrained.

### Reviewer inputs

Each reviewer should reason from:

- the fixed diff
- the derived changed file list
- targeted read-only inspection of repo files inside the scoped repository

### Reviewer outputs

Each child reviewer must produce one of two outcomes:

- `needs-attention`
- `approve`

with structured findings only when material category-specific issues exist. The parent tool then assigns visible finding IDs, adds category metadata, detects conservative conflicts, and builds the final suite result.

### Conflict model

The parent tool detects only narrow, provable conflicts: findings from different categories on the same file with overlapping line ranges and explicit opposing action pairs. The resolver records every conflict, annotates both findings with `conflicts_with`, and never suppresses either finding automatically.

Resolvable first-slice conflicts use deterministic priority rules. Unresolved conflicts do not introduce a third top-level status; they return `status: "needs-attention"` with `conflicts[].resolution = "needs-user-direction"` so the primary agent can ask the user or choose a remediation strategy explicitly.

### Out-of-scope bias

Reviewer prompts intentionally exclude broad categories of weak or externalized feedback such as generic test nags, docs-only concerns, or rollout chores. The design goal is to maximize useful signal density.

---

## Safety and anti-self-review model

A key design concern is preventing the reviewer from reviewing its own control surface in an unsafe way.

This package therefore includes self-review protections around reviewer-control files and supports the concept of an external clean reviewer checkout/worktree.

High-level intent:

- do not let the reviewed diff quietly redefine the reviewer policy that is evaluating it
- fail fast when reviewer-control files are part of the diff and no safe review mode is available
- treat a separate clean external checkout/worktree as an acceptable reviewer source

This is a core trust-boundary feature of the package design, not an incidental implementation detail.

---

## State and persistence model

## In-memory state

During execution the tool maintains transient state for:

- progress reporting
- reviewer event subscriptions
- scoped execution metadata
- token and timing aggregation

## Persistent artifacts

The package also writes per-run JSONL artifacts under the agent data directory.

Those artifacts exist to preserve:

- run start metadata
- scope snapshots
- category progress breadcrumbs
- category-tagged reviewer events of interest
- conflict-analysis records
- final success or failure record with category results and conflicts when available

The artifacts are diagnostic infrastructure, not a user-facing product feature.

---

## Failure model

The package should fail fast and explicitly when a trustworthy review cannot be produced.

Expected failure cases include:

- not being in a git repo/worktree
- base ref resolution failure
- no merge-base
- no effective diff
- diff too large for a single category reviewer pass
- invalid category reviewer output after allowed repairs
- category reviewer tool-scaffolding failures

The design prefers an explicit error over a low-confidence or misleading review result.

---

## Coupling and dependencies

## External coupling

This package depends on:

- git repository state
- Pi's agent/session APIs
- the current active model for isolated reviewer execution

## Internal repo coupling

This package owns its own skill under `skills/` and its own reviewer logic under `src/`.

It has no intended runtime dependency on other local packages such as `rain-core`. Its primary relationship to the repo root is the shared development contract defined in [`../DESIGN.md`](../DESIGN.md).

---

## Validation model

This package has no generated frontend artifact, but it does have a significant behavioral surface.

Its package-local validation should eventually center on:

- linting
- typechecking
- targeted behavioral coverage for scope construction, reviewer diagnostics, category aggregation, and conflict analysis

The package should own those checks locally. The repo root should only orchestrate them.

---

## Packaging model

`polish-solution` should remain understandable as a standalone package consisting of:

- a review tool
- a companion skill
- package-local documentation

Its behavior should not depend on hidden root-level scripting. The root may aggregate or install it, but the package should remain the source of truth for its own design and validation.

---

## Tradeoffs

This design intentionally favors:

- fixed-scope review over open-ended repository exploration
- structured results over freeform critique
- strong constraints over reviewer flexibility
- review quality and debuggability over maximal simplicity of implementation

That is appropriate because the package's value comes from trustworthy skepticism, not breadth.

---

## Summary

`polish-solution` is designed as a constrained multi-category reviewer for the current git worktree:

- freeze a review scope
- run isolated category reviewers
- return structured findings and conflicts
- preserve enough diagnostics to trust and debug the result

The core design principle is that reviewer trustworthiness depends on scope control, tool control, and explicit failure when those guarantees weaken.