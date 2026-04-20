# AGENTS.md

- Run repo-wide validation commands from the repository root: `/Users/zach/zsaplan/pi-extensions`.
- The root `npm run lint` and `npm run typecheck` scripts are onboarded for `polish-solution` and `response-review`.
- The root `npm run knip` script and the response-review browser-artifact checks inside `npm run verify` remain scoped to `response-review`.
- `response-review/web/app.ts` is the tracked source of truth; `response-review/web/app.js` is a generated runtime artifact and should not be edited by hand.
- The extension runtime rebuilds `response-review/web/app.js` on demand if it is missing or stale.
- After `polish-solution/src/**/*.ts`, `response-review/src/**/*.ts`, or `response-review/web/app.ts` changes, run `npm run lint` from the repo root.
- Use `npm run fix` from the repo root to apply gts formatting across the repo-root lint surface and regenerate `response-review/web/app.js` from `response-review/web/app.ts`.
- Run `npm run typecheck` from the repo root to semantically check `polish-solution/src`, `response-review/src`, and `response-review/web`.
- Before committing or opening a PR for `polish-solution` or `response-review`, run `npm run verify` from the repo root.
