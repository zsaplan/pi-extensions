# pi-extensions

Personal repo-backed source for pi extensions.

## Packages

- `codex-research/` → `@zsaplan/pi-codex-research`
- `discord-notify/` → `@zsaplan/pi-discord-notify`
- `jira/` → `@zsaplan/pi-jira`
- `polish-solution/` → `@zsaplan/pi-polish-solution`
- `pr-worktree-status/` → `@zsaplan/pi-pr-worktree-status`
- `rain-core/` → shared KB/file utilities used by Rain extensions
- `raincatcher/` → `@zsaplan/pi-raincatcher`
- `raindistiller/` → `@zsaplan/pi-raindistiller`
- `rainman/` → `@zsaplan/pi-rainman`
- `response-review/` → `@zsaplan/pi-response-review`
- `session-file-footer/` → `@zsaplan/pi-session-file-footer`

Extension packages keep their own `package.json` and `pi` manifest. `rain-core/` is the shared deterministic utility layer; model policy and runtime orchestration stay in the extension packages.

Repo-wide design lives in [`DESIGN.md`](./DESIGN.md). Each extension directory also carries its own package-level `DESIGN.md` describing that package's responsibilities, boundaries, and coupling.

## Directory layout

```text
pi-extensions/
├── codex-research/
│   ├── package.json
│   ├── README.md
│   └── src/
├── discord-notify/
│   ├── package.json
│   ├── README.md
│   └── src/
├── jira/
│   ├── package.json
│   ├── README.md
│   └── src/
├── polish-solution/
│   ├── package.json
│   ├── README.md
│   ├── skills/
│   │   └── polish-solution/
│   │       └── SKILL.md
│   └── src/
├── pr-worktree-status/
│   ├── package.json
│   ├── README.md
│   └── src/
├── rain-core/
│   ├── CODEBASE.md
│   ├── package.json
│   ├── README.md
│   └── src/
├── raincatcher/
│   ├── package.json
│   ├── README.md
│   └── src/
├── raindistiller/
│   ├── package.json
│   ├── README.md
│   └── src/
├── rainman/
│   ├── package.json
│   ├── README.md
│   └── src/
├── response-review/
│   ├── package.json
│   ├── README.md
│   ├── src/
│   └── web/
├── session-file-footer/
│   ├── package.json
│   ├── README.md
│   └── src/
└── README.md
```

## Local usage

```bash
pi -e .

# or load individual source packages from this repo checkout
# (run `npm install` at the repo root first so local package dependencies are wired up)
pi -e ./codex-research
pi -e ./discord-notify
pi -e ./jira
pi -e ./polish-solution
pi -e ./pr-worktree-status
pi -e ./raincatcher
pi -e ./raindistiller
pi -e ./rainman
pi -e ./response-review
pi -e ./session-file-footer

# install the whole repo-backed package
pi install .
```

Note: `response-review/` has a runtime dependency on `glimpseui`, so direct source loading (`pi -e ./response-review`) needs dependencies installed first. Running `npm install` at the repo root is the simplest option; `pi install .` also handles package installs for you.

## Development workflow

The repo now follows a package-local verification model with root orchestration:

- each package owns its own `npm run verify`
- the repo root uses npm workspaces to fan out shared commands to those package-local contracts
- the root `npm run lint` command remains the shared repo-root gts lint surface for the currently onboarded files
- package-specific checks such as `response-review`'s `knip` run live in the owning package now, not in the root script implementation

Run these from the repository root:

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run verify
```

Useful targeted commands:

```bash
npm run verify --workspace codex-research
npm run verify --workspace jira
npm run verify --workspace response-review
npm run verify --workspace rainman
npm run verify --workspace session-file-footer
npm run verify --workspace pr-worktree-status
```

Notes:

- `npm run typecheck` fans out to each workspace package's local `typecheck` script when present.
- `npm run test` fans out to each workspace package's local `test` script when present.
- `npm run verify` runs the shared root lint surface, then fans out to each workspace package's local `verify` script.
- `response-review/web/app.ts` is the tracked source-of-truth browser file.
- `response-review/web/app.js` is an untracked runtime artifact that is rebuilt on demand if missing or stale.
- `response-review` owns its own web build, artifact checks, and `knip` validation inside `response-review/package.json`.

## Pi 0.99.2 upgrade validation

Pi development dependencies and the live CLI acceptance check target **0.99.2**.
Host-provided packages, including `typebox`, belong in `peerDependencies` with
`"*"` ranges; development dependencies support local checks without bundling them.

Run from the repository root:

```bash
npm run verify
npm run verify:upgrade
npm run verify:live  # makes real subscription/paid model requests
```

Preparation results (Node 26.9.0, Pi 0.99.2):

- [x] Repository lint, typechecks, package checks, and 158 tests passed.
- [x] Offline acceptance passed: five isolated reviewers, 18 local HTTP requests,
  and restored session context (`tmp/pi-upgrade-smoke.json`).
- [x] Live CLI acceptance passed with `openai-codex/gpt-5.6-sol`: file read,
  persisted-session resume, five review categories, and Rainman citation.
  Evidence: `tmp/pi-live-qe0icB/report.json`; reruns retain new `tmp/pi-live-*` reports.
- [x] Isolated CLI startup loaded the 13 configured packages with no stderr warnings.
- [x] The separately maintained Slack worktree passed its 107 tests and package checks.
- [ ] Merge preparation changes and refresh dependencies in the active checkout.
- [ ] Upgrade Homebrew Pi, restart, and verify the installed executable and normal session.
- [ ] Check image results and interactive approval dialogs without external writes.
- [ ] Check compaction and branching on a copied session.

Preparation does not change the daily installation, provider selection, or enable
MCP/codemode. Interactive acceptance remains separate from automated checks.

## Source of truth for this initial import

Initial package sources were copied from:

- `~/.pi/agent/extensions/raincatcher`
- `~/.pi/agent/extensions/rainman`

Repo-native additions after the initial import:

- `codex-research/`
- `discord-notify/`
- `jira/`
- `polish-solution/`
- `pr-worktree-status/`
- `rain-core/`
- `raindistiller/`
- `response-review/`
- `session-file-footer/`
