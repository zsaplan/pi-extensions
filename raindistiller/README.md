# raindistiller

A pi extension that distills Raincatcher knowledge files using model-reviewed exact and near-duplicate dedupe.

## Current behavior

- Listens for `raincatcher` file-write events when both extensions are loaded
- Auto-runs after captures using the written files as the target set
- Compares those files against the full KB before removing duplicates
- Uses a lightweight lexical dedupe core to generate exact and near-duplicate candidate groups
- Augments candidate review with canonical structured-fact parsing when occurrences are valid structured bullets
- Uses the active pi model to adjudicate each candidate group conservatively before removal
- Defaults to `medium` reasoning for automatic post-capture distillation
- Defaults to `xhigh` reasoning for manual `/raindistiller distill` runs
- Prefers keeping existing KB copies over newly captured duplicates when possible
- Prefers valid structured occurrences over malformed or legacy occurrences when deduping
- Warns when malformed fact files exist and skips malformed selected files from mutation
- Deletes empty raincatcher-generated fact files after dedupe
- Supports manual distillation of explicit files and directories

## Command

- `/raindistiller` — show status
- `/raindistiller on` — enable automatic post-capture distillation
- `/raindistiller off` — disable automatic post-capture distillation
- `/raindistiller distill` — distill the full KB root recursively
- `/raindistiller distill --file BC_SITES__GITOPS.md --dir archived` — distill explicit paths relative to the KB root

## Notes

- Directories are expanded into a deduped `files[]` list before processing
- If both files and directories are supplied, they are appended and deduped
- When installing from this repo source, prefer `pi install .` at the repo root so shared `rain-core` imports remain available
- The dedupe core uses token overlap, trigram overlap, light stemming, and edit-distance-style lexical similarity to surface candidate groups
- The model still decides whether a candidate group is truly duplicate enough to remove
