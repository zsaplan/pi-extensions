# raincatcher

A minimal pi extension that watches agent activity and records durable facts to markdown files under:

- `~/.pi/agent/data/raincatcher/`
- or `PI_RAINMAN_KB_ROOT=/path/to/markdown/root`

## Current behavior

- Observes prompt-level activity using `agent_start`, `tool_call`, `tool_execution_end`, and `agent_end`
- Uses the active pi model to extract durable facts from the recent interaction
- Writes only canonical structured fact files like `# SUBJECT / TOPIC` with bullets shaped as `- RELATION | OBJECT | key=value`
- Groups facts into subject/topic files like `BC_SITES__GITOPS.md` and `BRITEAUTH__DEFINITION.md`
- Deduplicates existing structured bullets per file
- Lints files before writing and skips malformed existing files instead of appending mixed-format content
- Skips obvious secret-looking values
- Shows a footer status for session totals like facts/files captured
- Shows an info notification after each automatic capture with facts/files counts
- Persists capture totals in the current pi session via custom session entries, so resumed sessions and tree navigation can restore counts
- Emits file-write events that `raindistiller` can consume for post-capture dedupe when both extensions are loaded

## Command

- `/raincatcher` — show status
- `/raincatcher on` — enable recording for this session
- `/raincatcher off` — disable recording for this session
- `/raincatcher harvest` — review the current session branch and extract durable facts from it

## Notes

- Raincatcher now honors the shared KB root override env var: `PI_RAINMAN_KB_ROOT`
- Raincatcher now consumes shared `rain-core` structured fact guidance, parsing, rendering, and linting APIs
- When installing from this repo source, `pi install .` at the repo root remains the simplest whole-repo install path
- This first version is intentionally quiet: no widgets, no custom editor UI, no persistent config beyond the shared env override
- If no active model or auth is available, it simply does nothing
