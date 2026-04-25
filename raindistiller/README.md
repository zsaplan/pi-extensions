# raindistiller

A pi extension that distills Raincatcher knowledge files using model-reviewed duplicate dedupe plus validated semantic cleanup rewrites.

## Current behavior

- Listens for `raincatcher` file-write events when both extensions are loaded
- Auto-runs after captures using the written files as the target set
- Compares those files against the full KB before removing duplicates
- Uses a lightweight lexical dedupe core to generate exact and near-duplicate candidate groups
- Augments candidate review with canonical structured-fact parsing when occurrences are valid structured bullets
- Uses the active pi model to adjudicate each candidate group conservatively before removal
- Retries and repairs malformed duplicate-adjudication JSON responses before surfacing a warning
- Defaults to `medium` reasoning for automatic post-capture distillation
- Defaults to `xhigh` reasoning for manual `/raindistiller distill` runs
- Prefers keeping existing KB copies over newly captured duplicates when possible
- Prefers valid structured occurrences over malformed or legacy occurrences when deduping
- Warns when malformed fact files exist and skips malformed selected files from mutation
- Runs semantic cleanup after dedupe during manual distill runs by default
- Uses the active model to propose per-file semantic rewrites, then accepts them only if they stay structurally valid and reduce semantic warnings
- Re-runs targeted dedupe after accepted semantic rewrites
- Records semantic rewrite audit details and pre-rewrite backups for modified files
- Deletes empty raincatcher-generated fact files after dedupe
- Supports manual distillation of explicit files and directories

## Command

- `/raindistiller` — show status
- `/raindistiller on` — enable automatic post-capture distillation
- `/raindistiller off` — disable automatic post-capture distillation
- `/raindistiller distill` — distill the full KB root recursively
- `/raindistiller distill --file BC_SITES__GITOPS.md --dir archived` — distill explicit paths relative to the KB root
- `/raindistiller distill --semantic-cleanup` — force semantic cleanup on for one manual run
- `/raindistiller distill --no-semantic-cleanup` — force semantic cleanup off for one manual run

## Notes

- Directories are expanded into a deduped `files[]` list before processing
- If both files and directories are supplied, they are appended and deduped
- `RAINDISTILLER_SEMANTIC_CLEANUP_MODE=off|manual_only|all` controls whether semantic cleanup runs in no runs, manual runs only, or both manual and auto runs
- The default semantic cleanup rollout mode is `manual_only`
- When installing from this repo source, `pi install .` at the repo root remains the simplest whole-repo install path
- The dedupe core uses token overlap, trigram overlap, light stemming, and edit-distance-style lexical similarity to surface candidate groups
- The model still decides whether a candidate group is truly duplicate enough to remove or which semantic rewrites are worth attempting; deterministic validation gates decide what is actually applied
