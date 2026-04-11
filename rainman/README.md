# rainman

A minimal pi extension that adapts the core Rainman idea into a local verification tool for Raincatcher knowledge files.

## What it does

- Registers `rainman_verify`
- Uses an isolated in-memory pi sub-session
- Restricts that sub-session to KB-safe `find`, `grep`, `read`, and `submit_result` tools
- Uses shared `rain-core` linting and structured fact parsing to expose only lint-clean fact files as evidence
- The read tool returns raw lines plus parsed structured fact summaries for the requested range
- Validates citations before returning an evidence-backed result
- Tracks session-local TUI metrics for queries, hits, and errors
- Targets `~/.pi/agent/data/raincatcher` by default
- Skips malformed fact files and surfaces warnings when malformed KB content is present

## Configuration

Default KB root:

- `~/.pi/agent/data/raincatcher`

Optional override:

- `PI_RAINMAN_KB_ROOT=/path/to/markdown/root`

## Tool

- `rainman_verify(question)`

The tool returns a concise text summary plus structured details containing:

- `status`: `answered` | `insufficient_evidence` | `conflict`
- `data`
- `citations`
- `missingInformation`
- `warnings`
- `meta`

## Command

- `/rainman` — show KB root and session status

## TUI

A footer status is maintained for the current session with:

- queries
- hits (`answered` results)
- errors (tool execution failures)

## Notes

This first version intentionally skips the original Rainman HTTP service, Docker, and Helm layers. It keeps only the small verification core needed inside pi.
