# raindistiller Standardization and Hardening Implementation Plan

## Mission

Bring `raindistiller` up to the repo's package-local standardization target while preserving its core role: conservatively improving Rain knowledge quality through deterministic scans, model adjudication, backups, and auditability.

This document is an implementation handoff for a future agent. Keep changes centered on `raindistiller` unless a root orchestration, `rain-core`, or `raincatcher` compatibility change is explicitly required.

## Starting context

- Package: `@zsaplan/pi-raindistiller`
- Runtime entry: `raindistiller/src/index.ts`
- Supporting modules: `raindistiller/src/distill.ts`, `raindistiller/src/semanticCleanup.ts`
- Existing tests: `raindistiller/test/semanticCleanup.test.ts`
- Current validation: `npm run verify --workspace raindistiller` runs TypeScript and tests.
- Current peer dependencies: `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`
- Current package dependency: `@zsaplan/rain-core` via `file:../rain-core`
- The package listens for `raincatcher:files-written` events.

## Scope

- Standardize package-local validation and package dry-run checks.
- Expand deterministic tests around argument parsing, cleanup mode gating, dedupe decisions, backups, and audit output.
- Harden safe mutation behavior so model output cannot damage trust in the KB.
- Preserve compatibility with `rain-core`, `raincatcher`, and `rainman` expectations.

## Non-goals

- Do not change the structured fact grammar outside `rain-core`.
- Do not make real model calls in tests.
- Do not make auto-cleanup more aggressive without explicit acceptance criteria.
- Do not remove backup/audit behavior to simplify implementation.

## Implementation checklist

### 1. Package-local validation contract

- Add package-local `lint` if lint ownership is being standardized across all packages.
- Keep `verify` running both typecheck and tests.
- Consider adding package-local static checks only if they are owned by `raindistiller`.
- Confirm `npm run verify --workspace raindistiller` and `cd raindistiller && npm run verify` work after root install.

### 2. Deterministic unit coverage

- Add tests for command argument tokenization and file/directory resolution behavior where package-owned.
- Add tests for `RAINDISTILLER_SEMANTIC_CLEANUP_MODE=off|manual_only|all` gating.
- Add tests for duplicate decision parsing and rejection of malformed model responses.
- Extend semantic cleanup tests for backup creation, skipped-action reporting, and audit fields.
- Add tests for behavior when `raincatcher:files-written` sends empty or malformed payloads.

### 3. Safe mutation hardening

- Ensure all rewrites are validated against `rain-core` linting before persistence.
- Confirm rejected model proposals never modify files.
- Confirm backups are written before mutations and are discoverable by operators.
- Confirm partial failures report which files changed, skipped, or failed.
- Keep automatic mode conservative and clearly separated from manual command behavior.

### 4. Rain pipeline compatibility

- Confirm imports use only the public `@zsaplan/rain-core` boundary.
- Validate any event-shape assumptions against `raincatcher` before changing them.
- If mutation output affects `rainman` lookup correctness, run `npm run verify --workspace rainman` as part of validation.

### 5. Package/install hardening

- Run `npm pack --dry-run --workspace raindistiller` and inspect included files.
- Confirm tests are included only if intentionally packaged; otherwise adjust `files` or document the decision.
- Confirm `src`, `DESIGN.md`, `README.md`, and `package.json` are included.
- Confirm no backups, tmp files, or local KB artifacts are packaged.

## Acceptance criteria

- `raindistiller` package-local `verify` covers typecheck and deterministic tests.
- Semantic cleanup and mutation safety have tests for accepted, rejected, and skipped paths.
- Automatic behavior remains conservative and mode-gated.
- Compatibility with `raincatcher` events and `rain-core` public imports is preserved.
- Package dry-run output includes only intentional files.

## Required validation

Run from the repo root unless noted otherwise:

```bash
npm install
npm run verify --workspace raindistiller
npm run verify --workspace raincatcher
npm run verify --workspace rainman
npm run verify
npm pack --dry-run --workspace raindistiller
cd raindistiller && npm run verify
```

Run `raincatcher` validation when event handling changes. Run `rainman` validation when output structure or cleanup semantics could affect lookup evidence.

## Risks and follow-ups

- The package mixes deterministic orchestration and model-mediated decisions; tests should isolate deterministic gates rather than testing model quality.
- Backup/audit paths can become platform-sensitive; test with path-safe temp directories.
- Package-local lint should be coordinated with the repo-wide lint ownership follow-up.
