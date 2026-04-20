# pi-extensions

Personal repo-backed source for pi extensions.

## Packages

- `polish-solution/` → `@zsaplan/pi-polish-solution`
- `rain-core/` → shared KB/file utilities used by Rain extensions
- `raincatcher/` → `@zsaplan/pi-raincatcher`
- `raindistiller/` → `@zsaplan/pi-raindistiller`
- `rainman/` → `@zsaplan/pi-rainman`
- `response-review/` → `@zsaplan/pi-response-review`

Extension packages keep their own `package.json` and `pi` manifest. `rain-core/` is the shared deterministic utility layer; model policy and runtime orchestration stay in the extension packages.

## Directory layout

```text
pi-extensions/
├── polish-solution/
│   ├── package.json
│   ├── README.md
│   ├── skills/
│   │   └── polish-solution/
│   │       └── SKILL.md
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
└── README.md
```

## Local usage

```bash
pi -e .

# or load individual source packages from this repo checkout
# (these source paths work because the sibling rain-core package is present in the repo)
pi -e ./polish-solution
pi -e ./raincatcher
pi -e ./raindistiller
pi -e ./rainman
pi -e ./response-review

# install the whole repo-backed package so shared rain-core imports stay intact
pi install .
```

Note: `response-review/` has a runtime dependency on `glimpseui`, so direct source loading (`pi -e ./response-review`) needs an `npm install` inside that package first. `pi install .` handles package installs for you.

## Development workflow

The repo-root lint and typecheck scripts cover `polish-solution` and `response-review`. The repo-root `knip` and response-review browser-artifact checks remain scoped to `response-review`.

Run these from the repository root:

```bash
npm run lint
npm run fix
npm run typecheck
npm run knip
npm run verify
```

Notes:

- `response-review/web/app.ts` is the tracked source-of-truth browser file.
- `response-review/web/app.js` is an untracked runtime artifact that is rebuilt on demand if missing or stale.
- `npm run fix` applies `gts` formatting across the repo-root lint surface and regenerates the untracked `response-review/web/app.js` runtime artifact from `response-review/web/app.ts`.
- `npm run typecheck` runs semantic TypeScript checks for `polish-solution/src`, `response-review/src`, and `response-review/web`.
- `npm run verify` runs linting and semantic typechecking for that onboarded surface, then runs `knip`, rebuilds the generated web script, and checks the generated `response-review/web/app.js` syntax.
- The other extensions can be onboarded to the same tooling in a later pass.

## Source of truth for this initial import

Initial package sources were copied from:

- `~/.pi/agent/extensions/raincatcher`
- `~/.pi/agent/extensions/rainman`

Repo-native additions after the initial import:

- `polish-solution/`
- `rain-core/`
- `raindistiller/`
- `response-review/`
