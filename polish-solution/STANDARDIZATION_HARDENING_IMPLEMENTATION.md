# polish-solution Standardization and Hardening Implementation Plan

## Mission

Bring `polish-solution` up to the repo's package-local standardization target while preserving its core role: an adversarial review tool that inspects the current worktree without reviewing itself or escaping its intended scope.

This document is an implementation handoff for a future agent. Keep changes centered on `polish-solution` unless a root orchestration change is explicitly required.

## Starting context

- Package: `@zsaplan/pi-polish-solution`
- Runtime entry: `polish-solution/src/index.ts`
- Skill directory: `polish-solution/skills`
- Current validation: `npm run verify --workspace polish-solution` runs TypeScript only.
- Current peer dependencies: `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@sinclair/typebox`
- The implementation is intentionally self-review-resistant and writes review artifacts under local state paths.

## Scope

- Standardize package-local validation and packaging checks.
- Add tests for deterministic scope construction, path safety, output budgeting, and result validation where practical.
- Harden failure modes around git state, external reviewer invocation, artifact writing, and JSON/tool-result validation.
- Preserve the current tool and skill contract.

## Non-goals

- Do not redesign the review model or reviewer prompt unless a bug requires it.
- Do not add broad CI or root-level orchestration changes unless required to make this package's contract runnable.
- Do not remove the anti-self-review protections.
- Do not change the public tool output schema without an explicit migration note.

## Implementation checklist

### 1. Package-local validation contract

- Add a package-local `lint` script if package-local lint ownership is the agreed repo direction.
- Add a package-local `test` script once tests exist.
- Update `verify` so it runs `typecheck`, tests, and any package-owned static checks.
- Confirm `npm run verify --workspace polish-solution` and `cd polish-solution && npm run verify` both work after root install.

### 2. Deterministic unit coverage

- Identify pure helpers in `src/index.ts` that can be tested without spawning a reviewer agent.
- Add tests for path containment helpers, artifact path sanitization, diff/read output budget enforcement, and changed-file validation.
- Add tests for result-shape validation and repair-attempt boundaries if those can be isolated without a real model session.
- Prefer small internal modules for pure logic if test seams are otherwise too coarse.

### 3. Review-scope hardening

- Verify the tool handles clean worktrees, untracked files, large diffs, and missing base refs predictably.
- Confirm self-review blocking behavior still prevents the loaded package from reviewing its own active source path unless the explicit env override is set.
- Ensure errors from git commands are surfaced as structured findings or structured tool errors, not ambiguous crashes.
- Confirm artifact write failures are reported with useful context.

### 4. Package/install hardening

- Run `npm pack --dry-run --workspace polish-solution` and inspect included files.
- Confirm the skill directory is included and the package manifest exposes it correctly.
- Confirm no review artifacts, tmp files, or local state are packaged.
- Update package README only for newly verified local commands or install caveats.

## Acceptance criteria

- `polish-solution` owns a complete package-local verify contract for its complexity.
- Deterministic helpers have tests covering safety-critical behavior.
- The anti-self-review boundary remains intact and documented by tests or explicit validation.
- Package dry-run output includes the extension source, skill files, design docs, README, and package manifest only as intended.
- Public tool output shape remains stable or any intentional change is documented.

## Required validation

Run from the repo root unless noted otherwise:

```bash
npm install
npm run verify --workspace polish-solution
npm run verify
npm pack --dry-run --workspace polish-solution
cd polish-solution && npm run verify
```

If behavior around git/base refs is changed, add a focused smoke test or document the manual validation scenario.

## Risks and follow-ups

- `src/index.ts` is large; adding tests may require extracting pure helpers before meaningful coverage is possible.
- Reviewer-agent behavior depends on Pi AI runtime and should not be unit-tested by making real model calls.
- Package-local lint should be coordinated with the repo-wide lint ownership follow-up to avoid duplicate or inconsistent lint surfaces.
