# Rainman experiments

This file records durable plans, actions, and results for improving Rainman subagent latency and answer quality.

## Experiment loop

1. Define or update an eval suite under `rainman/evals/`.
2. Run `/rainman eval [suitePath] [limit]` inside pi so the real Rainman subagent, active model, citation validator, and timeout behavior are exercised.
3. Inspect the JSON and Markdown artifacts written to `~/.pi/agent/data/rainman-evals/`.
4. Make one small change to the prompt, candidate selection, KB organization, timeout, or validation path.
5. Rerun the same eval suite and compare pass rate, elapsed time, token usage, cost, citation quality, and failure modes.
6. Keep the change if it improves the target metrics without obvious accuracy regressions; otherwise revert it.
7. Record the plan, action, result, and decision below.

The harness is intentionally inspired by the tight experiment/evaluate loop in Andrej Karpathy's `autoresearch`: make benchmark cases explicit, run the real system, preserve artifacts, and iterate in small measurable steps.

## Metrics to watch

- Pass rate: status and required answer/citation checks.
- Latency: per-case elapsed milliseconds and average elapsed milliseconds.
- Tool behavior: lookup artifacts should show fewer broad grep/find loops over time.
- Token/cost: total tokens and cost should trend down as navigation improves.
- Citation validity: successful runs must preserve exact citation validation.

## 2026-04-24 — baseline failure from artifact

### Plan

Use the retained Rainman lookup artifact for `What is BriteCore in the context of this workspace/company?` to identify why disabling subagent thinking did not produce a fast result.

### Action

Inspected:

`/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T22-21-42-208Z_what-is-britecore-in-the-context-of-this-workspace-company_26ab7b90-a132-492e-b919-cac5cc3663da.jsonl`

### Result

- Thinking level was already `off`.
- The run timed out at 45 seconds.
- Usage was 22 turns, 233,269 total tokens, and approximately $0.252367.
- The subagent made many broad navigation calls (`grep BriteCore`, `grep britecore`, `find BRITECORE`, `grep policy`) before reading useful files.
- The final attempted `submit_result` happened at the timeout boundary and included an invalid-looking quote, so validation likely would have required repair even without the timeout.

### Decision

The next improvements should focus on search discipline and KB discoverability, not only thinking level.

## 2026-04-24 — first harness and prompt-bound experiment

### Plan

Add a real Rainman eval harness that runs inside pi against the real subagent, records latency/accuracy artifacts, and creates a default suite including the BriteCore workspace definition case. Also make one small prompt change that biases the subagent toward fast, bounded lookup.

### Action

- Added `/rainman eval [suitePath] [limit]`.
- Added `rainman/evals/default.json`.
- Eval artifacts are written as JSON and Markdown under `~/.pi/agent/data/rainman-evals/`.
- Added prompt guidance:
  - Rainman is a fast citation lookup agent, not a researcher.
  - Prefer `find` with key nouns first.
  - Prefer `__DEFINITION`, `__REPOSITORY`, and `__WORKFLOW` files.
  - Read the best 1–3 files and submit.
  - Use `grep` only when `find` is insufficient or one narrow phrase is needed.
  - Submit insufficient evidence after six tool calls if direct evidence is not available.

### Result

Implementation validation:

- `npm run verify --workspace rainman` passed.
- `npm run lint` passed from the repository root.

A live `/rainman eval` run still needs to be launched from pi because the harness uses the active pi model context and real subagent runtime.

### Decision

Keep this as the first measurable harness/prompt experiment. If the BriteCore case still times out, the next likely experiment is deterministic candidate-file preselection before launching the subagent.
