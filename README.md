# pi-extensions

Personal repo-backed source for pi extensions.

## Packages

- `raincatcher/` → `@zsaplan/pi-raincatcher`
- `rainman/` → `@zsaplan/pi-rainman`

Each package is a standalone pi package with its own `package.json` and `pi` manifest.

## Directory layout

```text
pi-extensions/
├── raincatcher/
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
pi -e ./raincatcher
pi -e ./rainman

pi install ./raincatcher
pi install ./rainman
```

## Source of truth for this initial import

Current package sources were copied from:

- `~/.pi/agent/extensions/raincatcher`
- `~/.pi/agent/extensions/rainman`
