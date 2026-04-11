# raincatcher

A minimal pi extension that watches agent activity and records durable facts to markdown files under:

- `~/.pi/agent/data/raincatcher/`

## Current behavior

- Observes prompt-level activity using `agent_start`, `tool_call`, `tool_execution_end`, and `agent_end`
- Uses the active pi model to extract durable facts from the recent interaction
- Groups facts into subject/topic files like `BC_SITES__GITOPS.md` and `BRITEAUTH__DEFINITION.md`
- Deduplicates existing bullet points per file
- Skips obvious secret-looking values
- Shows a footer status for session totals like facts/files captured
- Shows an info notification after each automatic capture with facts/files counts
- Persists capture totals in the current pi session via custom session entries, so resumed sessions and tree navigation can restore counts

## Command

- `/raincatcher` — show status
- `/raincatcher on` — enable recording for this session
- `/raincatcher off` — disable recording for this session
- `/raincatcher harvest` — review the current session branch and extract durable facts from it

## Notes

- This first version is intentionally quiet: no widgets, no custom editor UI, no persistent config yet
- If no active model or auth is available, it simply does nothing
