# @zsaplan/pi-session-file-footer

Pi extension that replaces the default footer with a compatible footer whose first line shows:

- the current working directory on the left
- the current JSONL session file on the right

The extension preserves the usual footer stats/model line and extension status line behavior.

## Usage

```bash
pi -e ./session-file-footer
```

When the whole repo package is loaded, this extension is included by the root package manifest.

## Validation

```bash
npm run verify --workspace session-file-footer
```
