# pi-extensions

Personal repo-backed source for pi extensions.

## Packages

- `rain-core/` → shared KB/file utilities used by Rain extensions
- `raincatcher/` → `@zsaplan/pi-raincatcher`
- `raindistiller/` → `@zsaplan/pi-raindistiller`
- `rainman/` → `@zsaplan/pi-rainman`
- `response-review/` → `@zsaplan/pi-response-review`

Extension packages keep their own `package.json` and `pi` manifest. `rain-core/` is the shared deterministic utility layer; model policy and runtime orchestration stay in the extension packages.

## Directory layout

```text
pi-extensions/
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

## Install with pi

This repository is itself a pi package at the repo root. Installing it from git/GitHub loads the extensions declared in the root `package.json`, including `response-review`.

```bash
# global install
pi install git:github.com/zsaplan/pi-extensions

# raw GitHub URL also works
pi install https://github.com/zsaplan/pi-extensions

# install into the current project's .pi/settings.json
pi install -l git:github.com/zsaplan/pi-extensions

# try it for one run without installing
pi -e git:github.com/zsaplan/pi-extensions
```

After installing, restart pi or run `/reload`.

## Local usage

```bash
pi -e .

# or load individual source packages from this repo checkout
# (these source paths work because the sibling rain-core package is present in the repo)
pi -e ./raincatcher
pi -e ./raindistiller
pi -e ./rainman
pi -e ./response-review

# install the whole repo-backed package so shared rain-core imports stay intact
pi install .
```

Note: `response-review/` has a runtime dependency on `glimpseui`, so direct source loading (`pi -e ./response-review`) needs an `npm install` inside that package first. `pi install .`, `pi install git:github.com/zsaplan/pi-extensions`, and `pi install https://github.com/zsaplan/pi-extensions` handle package installs for you.

## Development workflow

For now, the repo-root validation scripts are scoped to `response-review` only.

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
- `npm run fix` applies `gts` formatting and regenerates the untracked `response-review/web/app.js` runtime artifact from `response-review/web/app.ts`.
- `npm run typecheck` runs semantic TypeScript checks for both `response-review/src` and `response-review/web`.
- `npm run verify` runs linting, semantic typechecking, `knip`, rebuilds the generated web script, and checks the generated `response-review/web/app.js` syntax.
- The other extensions can be onboarded to the same tooling in a later pass.

## Source of truth for this initial import

Initial package sources were copied from:

- `~/.pi/agent/extensions/raincatcher`
- `~/.pi/agent/extensions/rainman`

Repo-native additions after the initial import:

- `rain-core/`
- `raindistiller/`
- `response-review/`
