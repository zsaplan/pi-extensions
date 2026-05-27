# session-file-footer Design

## Purpose

Show the active Pi JSONL session file in the footer without forcing users to run `/session` or inspect `~/.pi/agent/sessions` manually.

## Behavior

On `session_start`, the extension installs a custom footer. The first footer line is a two-column layout:

- left: working directory, git branch, and session name using the same information as the default footer
- right: `jsonl: <session file>` or `jsonl: ephemeral` when the session is not persisted

The second line preserves the default-style token, cost, context, model, provider, and thinking-level summary. Extension statuses from `ctx.ui.setStatus()` are rendered on an additional line as the default footer does.

## Boundaries

The package intentionally does not modify Pi internals. It uses the documented `ctx.ui.setFooter()` extension hook and the footer data provider passed to custom footer factories.

Because `setFooter()` replaces the whole footer, this package owns a small default-compatible footer implementation. If Pi's built-in footer gains new fields later, this package may need to be updated to mirror them.

## Validation

Package-local `npm run verify` runs linting, typechecking, and unit tests for the line-fitting helpers.
