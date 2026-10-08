# AGENTS.md

- Run repo-wide validation commands from the repository root.
- The repo uses package-local verification contracts with root orchestration via npm workspaces.
- Every package should own `npm run verify`; the root `npm run verify` script runs the shared repo-root lint surface and then fans out to workspace package `verify` scripts.
- The root `npm run typecheck` and `npm run test` scripts fan out to workspace package scripts when present.
- The root `npm run lint` command remains the shared repo-root gts lint surface for the currently onboarded files.
- Use `npm run verify --workspace <package-dir>` for targeted package verification during focused work.
- `response-review/web/app.ts` is the tracked source of truth; `response-review/web/app.js` is a generated runtime artifact and should not be edited by hand.
- The extension runtime rebuilds `response-review/web/app.js` on demand if it is missing or stale.
- `response-review` owns its own web build, artifact checks, and `knip` validation inside `response-review/package.json`.
- Use `npm run fix` from the repo root to apply gts formatting across the repo-root lint surface and then fan out workspace prepare hooks.
- Before committing or opening a PR, run `npm run verify` from the repo root. For package-focused iterations, run the relevant package-local `npm run verify --workspace <package-dir>` first.

## OpenSpec pilot

- OpenSpec currently covers only the `profile-subagent` discovery increment. See [the active proposal](openspec/changes/search-trusted-specialists/proposal.md) and [acceptance tasks](openspec/changes/search-trusted-specialists/tasks.md).
- Keep existing `profile-subagent/DESIGN.md` and `RESEARCH.md` as baseline/research references; do not treat proposed specs or completed planning artifacts as implemented or verified behavior.
- Preserve unchecked acceptance work and execution evidence in the change. Do not sync/archive proposed behavior before its implementation and acceptance checks pass.
