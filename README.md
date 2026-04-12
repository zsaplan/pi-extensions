# pi-extensions

Personal repo-backed source for pi extensions.

## Packages

- `rain-core/` → shared KB/file utilities used by Rain extensions
- `raincatcher/` → `@zsaplan/pi-raincatcher`
- `raindistiller/` → `@zsaplan/pi-raindistiller`
- `rainman/` → `@zsaplan/pi-rainman`

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
└── README.md
```

## Local usage

```bash
pi -e .

# or load individual source packages from this repo checkout
# (these source paths work because the sibling rain-core package is present in the repo)
pi -e ./raincatcher
pi -e ./raindistiller
pi -e ./rainman

# install the whole repo-backed package so shared rain-core imports stay intact
pi install .
```

## Source of truth for this initial import

Initial package sources were copied from:

- `~/.pi/agent/extensions/raincatcher`
- `~/.pi/agent/extensions/rainman`

Repo-native additions after the initial import:

- `rain-core/`
- `raindistiller/`
