# rainman

A pi extension that turns Raincatcher into a local knowledge-cache lookup tool for stable, previously-derived project understanding.

## What it does

- Registers `rainman_lookup`
- Nudges the agent to consult Rainman first for likely-stable questions about workflows, conventions, preferences, ownership, source-of-truth repos, paths, locations, cache behavior, prior conclusions, and recurring explanations
- Falls back naturally to normal investigation when the lookup result is `insufficient_evidence` or `conflict`
- Uses an isolated in-memory pi sub-session
- Restricts that sub-session to KB-safe `find`, `grep`, `read`, and `submit_result` tools
- Uses shared `rain-core` linting and structured fact parsing to expose only lint-clean fact files as evidence
- The read tool returns raw lines plus parsed structured fact summaries for the requested range
- Validates citations before returning an evidence-backed result
- Tracks richer session-local TUI metrics for queries, hits, errors, last runtime, token usage, warning count, malformed-file count, and artifact path
- Streams concise start/progress/completion feedback during lookups and updates the working/status UI while a lookup is in flight
- Includes polish-style elapsed-time and token-usage summaries when the isolated lookup session reports usage
- Writes JSONL debug artifacts in failure-only mode by default, with always/off modes controlled by configuration
- Ships a checked-in `rainman` skill that teaches when to use cached knowledge versus normal live investigation
- Ships `rainman/evals/default.json` for recurring latency and accuracy experiments
- Targets `~/.pi/agent/data/raincatcher` by default
- Skips malformed fact files and surfaces warnings when malformed KB content is present

## Configuration

Default KB root:

- `~/.pi/agent/data/raincatcher`

Optional overrides:

- `PI_RAINMAN_KB_ROOT=/path/to/markdown/root`
- `PI_RAINMAN_DEBUG_ARTIFACTS=failure|always|off` controls JSONL lookup artifacts; default is `failure`

## Tool

- `rainman_lookup(question)`

The tool returns a concise text summary plus structured details containing:

- `status`: `answered` | `insufficient_evidence` | `conflict`
- `data`
- `citations`
- `missingInformation`
- `warnings`
- `meta` with evidence context such as model and KB root
- `result` with the evidence-backed payload repeated as a stable nested field
- `execution` with elapsed time and token usage when available
- `diagnostics` with isolated-session messages, tool access, and usage when available
- `artifact` / `artifactFormat` / `artifactWarning` when a debug artifact is retained

## Command

- `/rainman` — show KB root, session status, last run metadata, and artifact mode
- `/rainman test` — run a Rainman lookup smoke test against a synthetic question
- `/rainman eval [suitePath] [limit] [--repeat=N]` — run the real Rainman subagent against an eval suite and write JSON/Markdown results to `~/.pi/agent/data/rainman-evals/`; repeat defaults to `5` so latency claims are based on at least n=5

## Skill

- `rainman` — teaches the Rainman-first workflow for stable knowledge questions and the pivot rules for insufficient evidence, conflicts, and live-state requests

## TUI

A footer status is maintained for the current session with:

- queries
- hits (`answered` results)
- errors (tool execution failures)
- current lookup activity while a lookup is running
- last elapsed time, token usage, warning count, malformed-file count, and artifact path

## Debug artifacts

Rainman writes artifacts under `~/.pi/agent/data/rainman-lookup/` when retained. In the default `failure` mode, successful lookup artifacts are discarded and failed/interrupted lookup trails are kept for diagnostics. `always` keeps every lookup trail, and `off` disables artifact retention.

## Notes

This version intentionally skips the original Rainman HTTP service, Docker, and Helm layers. It keeps only the small knowledge-lookup core needed inside pi.
