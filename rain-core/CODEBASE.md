# rain-core CODEBASE

This package is the shared deterministic substrate for the Rain extension repo.

## Purpose

`rain-core` owns reusable knowledge-base and fact-processing mechanics that are:

- model-agnostic
- deterministic
- easy to unit test in isolation
- likely to be reused by more than one Rain package

## Logical separation

### Belongs in `rain-core`

- KB root resolution
- safe root-relative path handling
- markdown file discovery
- raincatcher-style fact-file parsing
- fact normalization helpers
- fact record construction
- lexical similarity scoring
- duplicate candidate generation
- duplicate clustering

These are low-level capabilities. They should not know when a workflow runs, which model is used, or how aggressive a caller wants to be.

### Does **not** belong in `rain-core`

- slash commands
- session UI/status widgets
- event subscriptions
- automatic post-capture orchestration
- thinking-level defaults
- model adjudication prompts
- dedupe policy decisions about whether a candidate group should be removed
- user-facing notifications or reports

Those concerns belong in package-specific orchestration layers such as `raindistiller`.

## Current modules

- `src/paths.ts`
  - KB root resolution
  - root-relative path safety
- `src/markdown.ts`
  - markdown file inventory and selection expansion
- `src/facts.ts`
  - fact bullet parsing and normalization
- `src/dedupe.ts`
  - fact records, lexical similarity, blocking, and duplicate candidate clustering
- `src/index.ts`
  - shared public exports

## Current consumers

- `raincatcher`
  - KB root/path helpers
  - fact normalization and filename helpers
- `raindistiller`
  - markdown selection helpers
  - fact parsing helpers
  - duplicate candidate generation

## Design intent

If future work introduces heavier or more policy-rich dedupe behavior, keep the split intact:

- `rain-core` should continue to surface candidate-generation primitives
- higher layers should own model prompts, adjudication policy, and mutation/orchestration behavior
