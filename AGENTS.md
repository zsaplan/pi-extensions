# AGENTS.md

- Run repo-wide validation commands from the repository root: `/Users/zach/zsaplan/pi-extensions`.
- For now, the root `npm run lint`, `npm run knip`, and `npm run verify` scripts are scoped to `response-review` only. Onboard the other extensions in a separate session.
- `response-review/web/app.ts` is the tracked source of truth; `response-review/web/app.js` is a generated runtime artifact and should not be edited by hand.
- After `response-review/src/**/*.ts` or `response-review/web/app.ts` changes, run `npm run lint` from the repo root.
- Use `npm run fix` from the repo root to apply gts formatting and regenerate `response-review/web/app.js` from `response-review/web/app.ts`.
- Before committing or opening a PR for `response-review`, run `npm run verify` from the repo root.
