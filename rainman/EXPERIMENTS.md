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

## 2026-04-24 — deterministic candidate preselection experiment

### Plan

Reduce subagent wandering by precomputing likely fact files from filename overlap before the model starts. Put those ranked candidates directly in the first prompt so the subagent can read first instead of running broad `grep`/`find` loops.

### Action

- Added deterministic candidate ranking based on question tokens and fact filenames.
- Boosted direct topic files such as `__DEFINITION`, `__REPOSITORY`, `__LOCATION`, and `__WORKFLOW`.
- Added the ranked candidate list to the first subagent prompt.
- Added a regression test that ensures `BRITECORE__DEFINITION.md` and `BRITECORE__REPOSITORY.md` outrank noisy `RAIN_CORE__DEFINITION.md` / troubleshooting-style files for the BriteCore workspace question.

### Results

Baseline retained artifact for the BriteCore workspace question:

- Status: timeout/error.
- Inner Rainman elapsed: 45,231ms.
- Tool behavior: 21 tool calls before attempted submit.
- Total tokens: 233,269.
- Cost: $0.252367.

First live prompt-bound run after harness/prompt changes but before candidate tokenizer fix:

- Outer `pi -p` wall time: ~23.33s.
- Inner Rainman elapsed: 14,563ms.
- Status: answered.
- Tool behavior: still read several wrong `*CORE*` candidate files before finding `BRITECORE__DEFINITION.md`.
- Total tokens: 15,164.
- Cost: $0.048644.
- Artifact: `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-47-13-302Z_what-is-britecore-in-the-context-of-this-workspace-company_31011698-1e6a-453d-8801-09502f4ed4df.jsonl`

After fixing tokenizer/ranking to preserve `BriteCore` as `britecore` instead of only `brite`/`core`:

- Outer `pi -p` wall time: ~15.70s.
- Inner Rainman elapsed: 10,436ms.
- Status: answered.
- Tool behavior: `read BRITECORE__DEFINITION.md`, then `submit_result` repair, then accepted `submit_result`.
- Total tokens: 4,586.
- Cost: $0.022789.
- Artifact: `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-48-18-345Z_what-is-britecore-in-the-context-of-this-workspace-company_413ed331-508b-4f86-8f73-ca170cb0e516.jsonl`

Measured against the 45,231ms baseline, the best current inner Rainman run is about 76.9% faster.

### Decision

Keep deterministic candidate preselection. It exceeds the 50% speedup target on the motivating BriteCore question while also reducing token use and cost substantially. The next experiment should target avoiding the extra submit repair by making quote formatting expectations clearer in the prompt.
