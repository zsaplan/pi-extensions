# Rainman baseline

This file captures the current accepted Rainman performance baseline for future experiments. Update it only after an experiment is kept and validated.

## 2026-04-25 — post candidate-ranking and citation-prompt baseline

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

Current n=5 artifact set:

- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-24T23-59-48-993Z_what-is-britecore-in-the-context-of-this-workspace-company_ebeff3ef-c0be-4497-af3c-d66394918dd0.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-00-01-464Z_what-is-britecore-in-the-context-of-this-workspace-company_47edfd8b-7673-4690-be07-ec88ab322532.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-00-09-839Z_what-is-britecore-in-the-context-of-this-workspace-company_f067922f-f8c5-46a0-bba1-af8ba99c36e9.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-00-24-624Z_what-is-britecore-in-the-context-of-this-workspace-company_fda408a5-df35-4754-a3b1-2aad2cdef885.jsonl`
- `/Users/zach/.pi/agent/data/rainman-lookup/2026-04-25T00-00-35-034Z_what-is-britecore-in-the-context-of-this-workspace-company_213bac15-1d6c-4da8-b418-5b6e6f57fcc6.jsonl`

| Metric | Current baseline |
| --- | ---: |
| n | 5 |
| Success rate | 5/5 answered |
| Mean inner elapsed | 6,124.4ms |
| Median inner elapsed | 6,353ms |
| Min inner elapsed | 4,350ms |
| Max inner elapsed | 7,513ms |
| Std dev | 1,450.7ms |
| Mean speedup vs original baseline | 86.5% |
| Mean tokens | 3,513 |
| Mean submit calls | 1.2 |

### Future comparison rule

Future speed experiments should compare against this current accepted baseline unless the experiment targets a different question class or suite. Use at least n=5 before making reproducibility claims.

For this BriteCore case, a future change should normally be considered materially faster only if it improves mean inner elapsed below 6,124.4ms without reducing the 5/5 success rate or citation validity.
