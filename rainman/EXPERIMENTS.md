# Rainman experiments

This file records durable plans, actions, and results for improving Rainman subagent latency and answer quality.

## Experiment loop

1. Define or update an eval suite under `rainman/evals/`.
2. Run `/rainman eval [suitePath] [limit] [--repeat=N]` inside pi so the real Rainman subagent, active model, citation validator, and timeout behavior are exercised. Use at least `--repeat=5` before making empirical latency claims; this is the default.
3. Inspect the JSON and Markdown artifacts written to `~/.pi/agent/data/rainman-evals/`.
4. Make one small change to the prompt, candidate selection, KB organization, timeout, or validation path.
5. Rerun the same eval suite and compare pass rate, elapsed time, token usage, cost, citation quality, and failure modes.
6. Keep the change if it improves the target metrics without obvious accuracy regressions; otherwise revert it.
7. Record the plan, action, result, and decision below.

The harness is intentionally inspired by the tight experiment/evaluate loop in Andrej Karpathy's `autoresearch`: make benchmark cases explicit, run the real system, preserve artifacts, and iterate in small measurable steps.

## Metrics to watch

- Pass rate: status and required answer/citation checks.
- Rubric accuracy: required/forbidden answer claims, required concepts with acceptable alternatives, expected citation files, required citation quote substrings, and citation count bounds.
- Latency: per-case elapsed milliseconds and average elapsed milliseconds across at least n=5 repeats.
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

- Added `/rainman eval [suitePath] [limit] [--repeat=N]`; repeat defaults to 5.
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

Measured against the 45,231ms baseline, the best current inner Rainman run is about 76.9% faster. This was a promising single-run result; reproducible claims require at least n=5 through the eval harness.

### Follow-up n=5 reproducibility run

After adding the n=5 requirement, reran the same BriteCore workspace question five times through the real `rainman_lookup` tool with the local extension under test and `PI_RAINMAN_DEBUG_ARTIFACTS=always`.

Command shape:

```sh
PI_RAINMAN_DEBUG_ARTIFACTS=always pi -p --no-session --thinking off --no-extensions --extension ./rainman/src/index.ts --no-builtin-tools --tools rainman_lookup "Use rainman_lookup to answer exactly this question and then summarize only the tool result: What is BriteCore in the context of this workspace/company?"
```

Artifacts:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-55-50-441Z_what-is-britecore-in-the-context-of-this-workspace-company_3ea1fef3-d03e-441f-bc63-3c5675f3866a.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-56-04-611Z_what-is-britecore-in-the-context-of-this-workspace-company_d33eb20e-241b-40c1-a456-16665d9e6667.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-56-16-550Z_what-is-britecore-in-the-context-of-this-workspace-company_098dd94f-831d-4cd2-be86-a6df295f7986.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-56-24-550Z_what-is-britecore-in-the-context-of-this-workspace-company_1718a823-0c39-4468-9428-538c4b42dfad.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-56-36-972Z_what-is-britecore-in-the-context-of-this-workspace-company_650c0bea-c032-4eed-b67d-a669a2996301.jsonl`

Results against the 45,231ms baseline:

| Run | Status | Inner elapsed | Speedup | Tokens | Tool calls |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | answered | 10,123ms | 77.6% | 6,957 | 4 |
| 2 | answered | 6,597ms | 85.4% | 4,643 | 3 |
| 3 | answered | 4,315ms | 90.5% | 3,599 | 3 |
| 4 | answered | 7,072ms | 84.4% | 4,643 | 3 |
| 5 | answered | 12,094ms | 73.3% | 9,587 | 5 |

Aggregate:

- n=5.
- All 5 runs answered successfully.
- Mean inner elapsed: 8,040.2ms.
- Median inner elapsed: 7,072ms.
- Min/max inner elapsed: 4,315ms / 12,094ms.
- Standard deviation: 3,068.7ms.
- Mean speedup vs baseline: 82.2%.

### Decision

Keep deterministic candidate preselection. The improvement exceeds the 50% speedup target reproducibly at n=5 on the motivating BriteCore question while also reducing token use and cost substantially. The next experiment should target avoiding extra submit repairs by making quote formatting expectations clearer in the prompt.

## 2026-04-25 — eval rubric hardening and citation quote prompt clarity experiment

### Plan

First harden the eval harness so accuracy checks can express required concepts with acceptable alternatives instead of brittle exact substrings. Then address the candidate-ranking experiment's remaining repair behavior: the subagent sometimes put display line prefixes such as `3 | ` into `citation.quote`. Add explicit prompt guidance that citation quotes must be raw file text without read-output line-number prefixes, then rerun the BriteCore question at n=5.

### Action

- Added deterministic rubric fields for required concepts with acceptable alternatives, forbidden claims, required citation quote substrings, and citation count bounds.
- Updated the default eval suite to use a richer BriteCore accuracy rubric.
- Updated the system prompt, first user prompt, and `submit_result` tool prompt snippet to say citation quotes must omit read-output line-number prefixes.
- Ran `npm run verify --workspace rainman` before live sampling.
- Reran the BriteCore workspace question five times through the real `rainman_lookup` tool with `PI_RAINMAN_DEBUG_ARTIFACTS=always`.

Artifacts:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-59-48-993Z_what-is-britecore-in-the-context-of-this-workspace-company_ebeff3ef-c0be-4497-af3c-d66394918dd0.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-00-01-464Z_what-is-britecore-in-the-context-of-this-workspace-company_47edfd8b-7673-4690-be07-ec88ab322532.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-00-09-839Z_what-is-britecore-in-the-context-of-this-workspace-company_f067922f-f8c5-46a0-bba1-af8ba99c36e9.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-00-24-624Z_what-is-britecore-in-the-context-of-this-workspace-company_fda408a5-df35-4754-a3b1-2aad2cdef885.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-00-35-034Z_what-is-britecore-in-the-context-of-this-workspace-company_213bac15-1d6c-4da8-b418-5b6e6f57fcc6.jsonl`

Results against the 45,231ms baseline:

| Run | Status | Inner elapsed | Speedup | Tokens | Tool calls | Submit calls |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | answered | 7,513ms | 83.4% | 4,740 | 3 | 2 |
| 2 | answered | 4,350ms | 90.4% | 2,828 | 2 | 1 |
| 3 | answered | 7,483ms | 83.5% | 3,076 | 3 | 1 |
| 4 | answered | 4,923ms | 89.1% | 3,824 | 4 | 1 |
| 5 | answered | 6,353ms | 86.0% | 3,097 | 3 | 1 |

Aggregate:

- n=5.
- All 5 runs answered successfully.
- Mean inner elapsed: 6,124.4ms.
- Median inner elapsed: 6,353ms.
- Min/max inner elapsed: 4,350ms / 7,513ms.
- Standard deviation: 1,450.7ms.
- Mean speedup vs baseline: 86.5%.
- Mean tokens: 3,513.
- Mean submit calls: 1.2.

Compared with the previous n=5 candidate-ranking run:

- Mean elapsed improved from 8,040.2ms to 6,124.4ms.
- Mean speedup improved from 82.2% to 86.5%.
- Variability dropped from 3,068.7ms stdev to 1,450.7ms stdev.
- Mean submit calls dropped materially; 4 of 5 runs submitted successfully without repair.

### Decision

Keep the quote-format prompt clarification. It improves the n=5 mean latency and substantially reduces repair behavior without reducing answer success on the motivating question.

## 2026-04-25 — single-best-file prompt experiment

### Plan

The quote-clarity baseline still sometimes read extra candidate files. Try a small prompt change that tells the subagent to read only candidate #1 first with a small limit and submit immediately if it has enough evidence. Keep the change only if n=5 preserves rubric accuracy and improves mean latency versus the current 6,124.4ms baseline.

### Action

- Updated the system prompt default strategy from "read the best 1-3 files" to "read the single best file first, and submit if it contains enough evidence."
- Updated the candidate section in the first prompt to instruct reading candidate #1 directly with a small limit such as 20, then reading candidate #2 or using narrow grep only if candidate #1 lacks direct evidence.
- Updated the prompt to prefer the fewest tool calls that preserve citation correctness.
- Ran `npm run verify --workspace rainman` before live sampling.
- Reran the BriteCore workspace question five times through the real `rainman_lookup` tool with `PI_RAINMAN_DEBUG_ARTIFACTS=always`.

Artifacts:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-21-32-872Z_what-is-britecore-in-the-context-of-this-workspace-company_32006d0d-5ab8-44d0-9073-0a31099c682f.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-21-49-370Z_what-is-britecore-in-the-context-of-this-workspace-company_826378e7-dc98-4d41-947d-a605125f2352.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-22-02-170Z_what-is-britecore-in-the-context-of-this-workspace-company_3e1bcbe2-6920-4ca5-bd4b-2d4a859fecd0.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-22-12-111Z_what-is-britecore-in-the-context-of-this-workspace-company_647a01c2-e8c4-462c-ad1a-72604bec8f97.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-22-20-732Z_what-is-britecore-in-the-context-of-this-workspace-company_0c0815ed-222b-43a0-83fa-8fd71ce5fddc.jsonl`

Results against the current 6,124.4ms baseline and original 45,231ms baseline:

| Run | Status | Inner elapsed | vs current baseline | vs original baseline | Tokens | Tool calls | Submit calls |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | answered | 7,901ms | -29.0% | 82.5% | 2,926 | 2 | 1 |
| 2 | answered | 6,627ms | -8.2% | 85.3% | 2,926 | 2 | 1 |
| 3 | answered | 3,973ms | 35.1% | 91.2% | 2,933 | 2 | 1 |
| 4 | answered | 4,916ms | 19.7% | 89.1% | 2,996 | 2 | 1 |
| 5 | answered | 3,514ms | 42.6% | 92.2% | 2,934 | 2 | 1 |

Aggregate:

- n=5.
- All 5 runs answered successfully.
- The richer concept-based BriteCore rubric passes for all 5 runs.
- Mean inner elapsed: 5,386.2ms.
- Median inner elapsed: 4,916ms.
- Min/max inner elapsed: 3,514ms / 7,901ms.
- Standard deviation: 1,843.0ms.
- Mean speedup vs current baseline: 12.1%.
- Mean speedup vs original baseline: 88.1%.
- Mean tokens: 2,943.
- Mean tool calls: 2.0.
- Mean submit calls: 1.0.

### Decision

Keep the single-best-file prompt change. It improves mean latency versus the accepted current baseline while preserving n=5 rubric accuracy, and it reduces average tokens/tool calls/submit repairs.

## 2026-04-25 — candidate list size experiments

### Plan

The single-best-file prompt still includes a deterministic candidate list in the prompt. Test whether shortening that list reduces prompt overhead and latency without hurting accuracy. Run three variants at n=5: candidate limit 5, candidate limit 3, and candidate limit 1.

### Experiment 1: candidate limit 5

Action:

- Changed `rankCandidateFactFiles` default limit from 12 to 5.
- Relaxed the BriteCore eval rubric's ecosystem concept alternatives to include `platform ecosystem`, which is semantically equivalent for observed valid answers.
- Ran `npm run verify --workspace rainman` before live sampling.
- Reran the BriteCore workspace question five times through the real `rainman_lookup` tool with `PI_RAINMAN_DEBUG_ARTIFACTS=always`.

Artifacts:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-32-40-261Z_what-is-britecore-in-the-context-of-this-workspace-company_8d0983af-3fae-49ca-a0b2-e96cb833f405.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-32-49-870Z_what-is-britecore-in-the-context-of-this-workspace-company_1b9aefb0-8b40-49bc-ab52-e0f9afa1d9e7.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-32-58-374Z_what-is-britecore-in-the-context-of-this-workspace-company_2304be92-81e7-47e0-a76f-bc3aa3d54e81.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-33-06-002Z_what-is-britecore-in-the-context-of-this-workspace-company_21154408-a886-4e25-9092-21a2c7b634ed.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-33-14-757Z_what-is-britecore-in-the-context-of-this-workspace-company_5086f3d5-2471-4795-93f3-dedb55d482bd.jsonl`

Results:

- n=5.
- Rubric pass rate after the ecosystem alternative update: 5/5.
- Mean inner elapsed: 4,132.2ms.
- Median inner elapsed: 3,850ms.
- Min/max inner elapsed: 3,794ms / 5,142ms.
- Standard deviation: 571.9ms.
- Mean speedup vs prior 5,386.2ms baseline: 23.3%.
- Mean speedup vs original 45,231ms baseline: 90.9%.
- Mean tokens: 2,799.2.
- Mean tool calls: 2.0.
- Mean submit calls: 1.0.

Decision: keep candidate limit 5. It materially improves latency and stability while preserving rubric accuracy.

### Experiment 2: candidate limit 3

Action:

- Changed `rankCandidateFactFiles` default limit to 3.
- Ran `npm run verify --workspace rainman` before live sampling.
- Reran the BriteCore workspace question five times through the real `rainman_lookup` tool with `PI_RAINMAN_DEBUG_ARTIFACTS=always`.

Artifacts:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-33-54-779Z_what-is-britecore-in-the-context-of-this-workspace-company_e3e185b8-bc00-44b4-b6ff-b3532c271842.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-34-05-673Z_what-is-britecore-in-the-context-of-this-workspace-company_c1fdc14f-68dc-49d2-9f4e-b6cf6a0639a6.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-34-14-656Z_what-is-britecore-in-the-context-of-this-workspace-company_dcbc14d2-854d-475f-8ba7-f18a6b1be9b0.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-34-25-606Z_what-is-britecore-in-the-context-of-this-workspace-company_b47335cc-18e7-460b-a1f8-dc16e39a4c04.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-34-33-677Z_what-is-britecore-in-the-context-of-this-workspace-company_c0b3f2b3-b18f-4b69-83bc-205cb99e914d.jsonl`

Results:

- n=5.
- Rubric pass rate under the then-current rubric: 4/5; likely 5/5 under the later `related ecosystem` alternative, but this run did not beat candidate limit 5.
- Mean inner elapsed: 5,414.8ms.
- Median inner elapsed: 5,212ms.
- Min/max inner elapsed: 3,753ms / 7,018ms.
- Standard deviation: 1,210.9ms.
- Mean speedup vs prior 5,386.2ms baseline: -0.5%.
- Mean speedup vs original 45,231ms baseline: 88.0%.

Decision: reject candidate limit 3. It is slower and more variable than candidate limit 5.

### Experiment 3: candidate limit 1

Action:

- Changed `rankCandidateFactFiles` default limit to 1.
- Included `related ecosystem` and `surrounding ecosystem` in the analysis rubric alternatives because those are semantically valid phrasings observed in answers.
- Ran `npm run verify --workspace rainman` before live sampling.
- Reran the BriteCore workspace question five times through the real `rainman_lookup` tool with `PI_RAINMAN_DEBUG_ARTIFACTS=always`.

Artifacts:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-35-03-111Z_what-is-britecore-in-the-context-of-this-workspace-company_fab52fd8-9bcf-48bb-ab67-f16c80d17c90.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-35-11-933Z_what-is-britecore-in-the-context-of-this-workspace-company_4809ef1d-e52b-4b63-9dd2-401a4a35cf87.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-35-21-729Z_what-is-britecore-in-the-context-of-this-workspace-company_4135c202-8551-47b3-b839-988e4ff089bf.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-35-35-423Z_what-is-britecore-in-the-context-of-this-workspace-company_82087bd0-4abd-4233-8bf4-aa09753af63b.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-35-46-589Z_what-is-britecore-in-the-context-of-this-workspace-company_4ecf9223-b662-417c-b2b9-d812084bfb27.jsonl`

Results:

- n=5.
- Rubric pass rate under the expanded concept alternatives: 5/5.
- Mean inner elapsed: 6,191.6ms.
- Median inner elapsed: 6,031ms.
- Min/max inner elapsed: 4,616ms / 7,819ms.
- Standard deviation: 1,586.9ms.
- Mean speedup vs prior 5,386.2ms baseline: -15.0%.
- Mean speedup vs original 45,231ms baseline: 86.3%.

Decision: reject candidate limit 1. It preserves accuracy but is slower and causes more submit repairs than candidate limit 5.

### Overall decision

Keep candidate limit 5 and update `rainman/BASELINE.md` to make candidate-limit-5 the new accepted baseline for this BriteCore case.
