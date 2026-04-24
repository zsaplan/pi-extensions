# pi-mono v0.70 Extension Compatibility and Modernization Plan

## Mission

Update this repository's pi extensions so they require and function with `badlogic/pi-mono` v0.70.0, then modernize the extension implementation to leverage recent pi SDK/runtime improvements where safe. Support for pi v0.69 is intentionally dropped so the implementation can depend directly on v0.70 SDK/runtime behavior.

This document is intended for a follow-up implementation agent. It captures the release review summary, concrete code targets, validation strategy, and sequencing.

## Upstream release reviewed

- Repository: <https://github.com/badlogic/pi-mono/releases>
- Latest release reviewed: `v0.70.0`
- Published: 2026-04-23
- Release URL: <https://github.com/badlogic/pi-mono/releases/tag/v0.70.0>

Relevant v0.70.0 release notes:

- Breaking change: OSC 9;4 terminal progress indicators are disabled by default. They can be re-enabled with `terminal.showTerminalProgress`.
- New/fixed SDK behavior: `--no-builtin-tools` / `createAgentSession({ noTools: "builtin" })` now disables only built-in tools while keeping extension/custom tools active.
- Improved stale extension context errors after session replacement/reload; extension authors should avoid captured stale `pi`/command `ctx` after session replacement and use `withSession` for post-replacement work.
- Fixed shutdown/session replacement extension UI cleanup ordering.
- Added GPT-5.5 Codex model support and provider/login UX improvements.

Context from prior release v0.69.0 that is still relevant:

- pi migrated first-party packages/docs/examples from `@sinclair/typebox` to `typebox` 1.x. Legacy extension loading still aliases root `@sinclair/typebox`, but new extensions/packages should use `typebox`.
- Custom tool results can return `terminate: true` to skip the automatic follow-up LLM turn when all finalized tool results in the batch are terminating.

## Current repo observations

The repo currently depends on pi `0.69.0` packages locally:

```text
@mariozechner/pi-ai@0.69.0
@mariozechner/pi-coding-agent@0.69.0
@mariozechner/pi-tui@0.69.0
```

Package peer dependencies currently use `^0.69.0`. Because these packages are still pre-1.0, that range means `>=0.69.0 <0.70.0`, so it does **not** accept v0.70.0.

Packages with pi peer dependency ranges to update:

- `package.json`
- `discord-notify/package.json`
- `polish-solution/package.json`
- `raincatcher/package.json`
- `raindistiller/package.json`
- `rainman/package.json`
- `response-review/package.json`

Source areas found during review:

- Isolated inner sessions:
  - `polish-solution/src/index.ts`
  - `rainman/src/index.ts`
- TypeBox imports still using legacy package:
  - `polish-solution/src/index.ts`
  - `rainman/src/index.ts`
- Final structured-output tools suitable for `terminate: true`:
  - `polish-solution` tool `submit_review`
  - `rainman` tool `submit_result`
- Long async UI/status flows to audit for stale context safety:
  - `response-review/src/index.ts`
  - `raincatcher/src/index.ts`
  - `raindistiller/src/index.ts`
  - `polish-solution/src/index.ts`
  - `rainman/src/index.ts`

## Compatibility test already performed

A temporary copy of the repo was tested with package peers changed to `^0.70.0` and pi packages installed at `0.70.0`.

Results:

- `npm run typecheck` passed across all workspaces.
- `npm run verify` mostly passed, but failed in `response-review` `knip` in the temp copy because the root `package-lock.json` had been regenerated in a way that caused `scripts/build-web.mjs` and `scripts/check-artifacts.mjs` to be reported as unused. The same `npm run knip --workspace response-review` passes in the current real checkout. Treat this as temp-copy artifact noise unless reproduced in the implementation worktree.

Conclusion: no immediate TypeScript API breakage was found for pi v0.70.0.

## Implementation scope

Implement all immediate compatibility fixes and optional modernization items below unless validation reveals a material blocker.

### Phase 1: Immediate install/runtime compatibility

#### 1. Update pi peer dependency ranges

Update every package that declares pi peer dependencies from exact minor caret ranges like:

```json
"@mariozechner/pi-coding-agent": "^0.69.0"
```

to a v0.70-only range:

```json
"@mariozechner/pi-coding-agent": "^0.70.0"
```

Apply the same pattern for these peers where present:

```json
"@mariozechner/pi-ai": "^0.70.0"
"@mariozechner/pi-coding-agent": "^0.70.0"
"@mariozechner/pi-tui": "^0.70.0"
```

Do **not** remove `@sinclair/typebox` peer entries in this phase unless doing the TypeBox migration in Phase 2.

Run `npm install` after editing package metadata so `package-lock.json` stays consistent.

Acceptance criteria:

- `npm install` succeeds without peer dependency conflicts.
- `npm ls @mariozechner/pi-coding-agent @mariozechner/pi-ai @mariozechner/pi-tui --depth=0` shows a coherent install.
- Repo validation still passes.

### Phase 2: SDK/runtime modernization

#### 2. Simplify isolated custom-tool sessions with `noTools: "builtin"`

Targets:

- `polish-solution/src/index.ts`
- `rainman/src/index.ts`

Current pattern:

- Create isolated sessions using `tools` allowlists plus `customTools`.
- Introspect whether expected custom tools registered.
- Fall back to `tools: []` / customTools-only behavior if the allowlist path does not register expected tools.

v0.70.0 gives an explicit SDK option:

```ts
createAgentSession({
  noTools: 'builtin',
  customTools,
  // ...other options
})
```

Use this for inner reviewer/lookup sessions whose intent is: disable default built-in tools, keep only custom extension tools.

Implementation guidance:

- Prefer the simplest robust implementation.
- Keep existing introspection/reporting if it provides useful diagnostics, but remove obsolete fallback paths only after proving `noTools: 'builtin'` activates expected custom tools.
- Preserve the safety property that inner agents cannot call default file/process tools except through the curated custom tools.
- In `polish-solution`, ensure reviewer tools such as diff/read/grep/submit remain available.
- In `rainman`, ensure lookup tools such as list/read/grep/submit remain available.

Potential mechanical change shape:

```ts
const {session} = await createAgentSession({
  cwd: scope.repoRoot,
  agentDir: getAgentDir(),
  model,
  modelRegistry,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
  noTools: 'builtin',
  customTools: reviewerTools,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory({
    compaction: {enabled: false},
    retry: {enabled: true, maxRetries: MAX_REPAIR_ATTEMPTS},
  }),
});
```

Use the analogous shape in `rainman`.

Acceptance criteria:

- Existing unit tests pass.
- TypeScript accepts `noTools: 'builtin'` after v0.70 peer/install update.
- Any existing self-tests or command tests for `rainman`/`polish-solution` still pass.
- Inspect inner session active/configured tools in tests or via existing diagnostics if feasible.

#### 3. Add terminating results to final submit tools

Targets:

- `polish-solution/src/index.ts`: custom tool named `submit_review`
- `rainman/src/index.ts`: custom tool named `submit_result`

Add `terminate: true` to successful final tool result objects.

Example:

```ts
return {
  content: [{type: 'text', text: 'submit_review accepted. Stop now.'}],
  details: validated,
  terminate: true,
};
```

Do not add `terminate: true` to error paths. If validation fails, the tool should still throw so the inner agent can repair and retry.

Acceptance criteria:

- TypeScript accepts the tool result shape.
- Tests pass.
- Existing prompt-time logic that races on submitted-result state should still work. It may become simpler in the future, but avoid broad behavior rewrites unless tests demonstrate safety.

### Phase 3: TypeBox migration

#### 4. Migrate from `@sinclair/typebox` to `typebox`

Targets:

- `polish-solution/src/index.ts`
- `rainman/src/index.ts`
- package metadata for root, `polish-solution`, and `rainman`
- `package-lock.json`

Change imports:

```ts
import {Type, type Static} from '@sinclair/typebox';
```

to:

```ts
import {Type, type Static} from 'typebox';
```

Metadata guidance:

- Add a dependency or peer dependency on `typebox` as appropriate. Since these extensions import it directly at runtime/build time, prefer declaring it explicitly in packages that import it.
- Remove `@sinclair/typebox` peer dependencies if no longer used anywhere.
- Verify `package-lock.json` reflects the new dependency shape.

Open question for implementer:

- Decide whether `typebox` belongs in `dependencies` or `peerDependencies`. Since pi already depends on `typebox`, peer may be acceptable for pi packages, but direct imports are easiest/most robust when declared in `dependencies`. Keep repo conventions in mind and validate with `npm pack`/workspace install behavior if uncertain.

Acceptance criteria:

- `rg "@sinclair/typebox" --glob '*.ts' --glob '*.json' --glob '!node_modules'` returns no source/package metadata references unless intentionally retained for backward compatibility.
- `npm run typecheck` passes.
- `npm run verify` passes.

### Phase 4: Stale context and shutdown safety audit

#### 5. Audit long async extension flows

v0.70.0 improves stale extension context errors. No obvious current break was found, but long async flows should be made defensive where low-risk.

Areas to inspect:

- `response-review/src/index.ts`
  - Holds `ctx` while native window is open.
  - Uses `ctx.ui.notify`, `ctx.ui.setEditorText`, and custom UI promises after async window events.
  - Has `session_shutdown` cleanup that dismisses UI and closes the window.
- `raincatcher/src/index.ts`
  - `agent_end` and `/raincatcher harvest` use `ctx` after model calls and disk writes.
  - Should avoid UI/status updates if shutdown/replacement occurred during async capture.
- `raindistiller/src/index.ts`
  - Long distill command flow uses UI/status updates and may send messages after awaits.
- `polish-solution/src/index.ts`
  - Long review flow updates working message/status and appends custom entries.
- `rainman/src/index.ts`
  - Self-test/lookup flows use UI notifications and session entries.

Implementation guidance:

- Do not over-engineer or introduce large lifecycle abstractions unless needed.
- Prefer simple guards around UI usage, cancellation, and cleanup.
- Avoid captured `pi` or command `ctx` after any explicit session replacement methods. This repo did not appear to call `ctx.newSession`, `ctx.fork`, or `ctx.switchSession`, so this may be mostly an audit/no-op.
- For `response-review`, ensure `session_shutdown` cleanup remains safe and idempotent. v0.70 includes fixes in this area, so avoid fighting the host runtime.
- For long model calls, prefer honoring existing `ctx.signal` and avoiding post-await UI updates when aborted.

Acceptance criteria:

- No new stale-context-prone session replacement behavior is introduced.
- Existing UI cleanup remains idempotent.
- Tests pass.

## Validation plan

Run from repo root unless noted.

### Baseline after edits

```sh
npm install
npm run typecheck
npm run test
npm run verify
```

The repo-specific contract is `npm run verify` from the root before finalizing.

### Targeted commands during iteration

```sh
npm run verify --workspace polish-solution
npm run verify --workspace rainman
npm run verify --workspace response-review
npm run knip --workspace response-review
```

### Compatibility validation suggestion

Validate the supported pi minor line:

1. Current lockfile/default install path using pi `0.70.0`.

Suggested temp validation shape:

```sh
tmp=$(mktemp -d /tmp/pi-ext-070.XXXXXX)
rsync -a --exclude node_modules --exclude .git --exclude tmp ./ "$tmp"/
cd "$tmp"
npm install
npm run typecheck
npm run verify
```

The implementation branch requires v0.70, so separate v0.69 validation is no longer part of the compatibility matrix.

## Expected final changed files

Likely changed files after full implementation:

- `package.json`
- `package-lock.json`
- `discord-notify/package.json`
- `polish-solution/package.json`
- `polish-solution/src/index.ts`
- `raincatcher/package.json`
- `raindistiller/package.json`
- `rainman/package.json`
- `rainman/src/index.ts`
- `response-review/package.json`

Potentially changed if stale-context audit finds simple fixes:

- `response-review/src/index.ts`
- `raincatcher/src/index.ts`
- `raindistiller/src/index.ts`

## Risks and cautions

- Pre-1.0 semver caret behavior is intentional here: `^0.70.0` excludes `0.69.x`.
- `noTools: 'builtin'` exists in pi-coding-agent v0.70.0 typings and is now used directly; v0.69 support is intentionally removed.
- TypeBox migration may alter package dependency shape. Ensure direct imports resolve for each workspace package, not just from the root by accident.
- `terminate: true` only skips automatic follow-up when every finalized tool result in the batch is terminating. It is still safe and useful for final structured-output tools.
- Avoid broad refactors of long async flows unless there is concrete stale-context risk. Keep changes simple and testable.

## Definition of done

- All peer dependency updates requiring pi v0.70 are implemented.
- Modernization items are implemented or explicitly documented as deferred with a concrete reason.
- `npm run verify` passes from the repo root.
- If possible, a v0.70.0 install/typecheck/verify path has been tested.
- Final response to the user summarizes changes, validation results, and any deferred follow-ups.
