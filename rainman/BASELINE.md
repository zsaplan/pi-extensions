# Rainman baseline

This file captures the current accepted Rainman performance baseline for future experiments. Update it only after an experiment is kept and validated.

## 2026-04-25 — candidate limit 5 baseline

### Scope

Baseline case:

```text
What is BriteCore in the context of this workspace/company?
```

Baseline command shape:

```sh
PI_RAINMAN_DEBUG_ARTIFACTS=always pi -p --no-session --thinking off --no-extensions --extension ./rainman/src/index.ts --no-builtin-tools --tools rainman_lookup "Use rainman_lookup to answer exactly this question and then summarize only the tool result: What is BriteCore in the context of this workspace/company?"
```

### Baseline reference

Original pre-improvement retained artifact:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T22-21-42-208Z_what-is-britecore-in-the-context-of-this-workspace-company_26ab7b90-a132-492e-b919-cac5cc3663da.jsonl`
- Status: timeout/error.
- Inner Rainman elapsed: 45,231ms.
- Tool behavior: 21 tool calls before attempted submit.
- Total tokens: 233,269.
- Cost: $0.252367.

### Current accepted baseline

Current accepted implementation includes:

- subagent thinking level set to `off`
- fast lookup prompt discipline
- deterministic candidate-file preselection
- n=5 eval sampling requirement
- clearer raw citation quote instructions
- deterministic rubric accuracy checks
- single-best-file prompt discipline
- ranked candidate list capped at 5 files

Current n=5 artifact set:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-32-40-261Z_what-is-britecore-in-the-context-of-this-workspace-company_8d0983af-3fae-49ca-a0b2-e96cb833f405.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-32-49-870Z_what-is-britecore-in-the-context-of-this-workspace-company_1b9aefb0-8b40-49bc-ab52-e0f9afa1d9e7.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-32-58-374Z_what-is-britecore-in-the-context-of-this-workspace-company_2304be92-81e7-47e0-a76f-bc3aa3d54e81.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-33-06-002Z_what-is-britecore-in-the-context-of-this-workspace-company_21154408-a886-4e25-9092-21a2c7b634ed.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-33-14-757Z_what-is-britecore-in-the-context-of-this-workspace-company_5086f3d5-2471-4795-93f3-dedb55d482bd.jsonl`

| Metric | Current baseline |
| --- | ---: |
| n | 5 |
| Success rate | 5/5 answered |
| Mean inner elapsed | 4,132.2ms |
| Median inner elapsed | 3,850ms |
| Min inner elapsed | 3,794ms |
| Max inner elapsed | 5,142ms |
| Std dev | 571.9ms |
| Mean speedup vs original baseline | 90.9% |
| Mean tokens | 2,799.2 |
| Mean tool calls | 2.0 |
| Mean submit calls | 1.0 |

### Future comparison rule

Future speed experiments should compare against this current accepted baseline unless the experiment targets a different question class or suite. Use at least n=5 before making reproducibility claims.

For this BriteCore case, a future change should normally be considered materially faster only if it improves mean inner elapsed below 4,132.2ms without reducing the 5/5 rubric pass rate or citation validity.
