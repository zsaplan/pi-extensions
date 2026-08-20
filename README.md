# pi-extensions

Personal repo-backed source for pi extensions.

## Packages

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

## Source of truth for this initial import

Initial package sources were copied from:

- `~/.pi/agent/extensions/raincatcher`
- `~/.pi/agent/extensions/rainman`

Repo-native additions after the initial import:

- `discord-notify/`
- `jira/`
- `polish-solution/`
- `pr-worktree-status/`
- `rain-core/`
- `raindistiller/`
- `response-review/`
- `session-file-footer/`
