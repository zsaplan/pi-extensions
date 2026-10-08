# Measuring delegation

Compare useful work allocation, not child count. Prioritize correctness, elapsed time and total parent-plus-child reported cost; also measure parent context. The [delegation policy](../DELEGATION.md) includes a sanitized aggregate result from one live trial.

## Trial protocol

1. Choose a bounded authorized workload and freeze task, verification standard, profiles/runtime, model/thinking and evaluation revision.
2. Start fresh A/B forks from the same original context. A has no specialist tools; B may choose whether/how to delegate. Give both identical task and verification instructions.
3. Run arms sequentially without coaching. Concurrent independent sessions can run, but resource/provider contention weakens timing comparisons.
4. Retain the actual assignments, calls, evidence, failures, omitted checks and source freshness. No tuning or discarded failed runs within a group.
5. Review decisive conclusions and verification coverage, not just successful completion or number of children.
6. Sum fresh parent and child model requests exactly once. Nested tool usage is a cross-check, not another charge. Exclude inherited requests and observer analysis. Account separately for standalone helper/compaction usage where present.
7. Preserve private original evidence and publish only reviewed, sanitized summaries.

Optional forced-delegation arms can diagnose one combined versus several independent children. Label them as diagnostics, not normal policy. A direct B run is valid but cannot demonstrate benefit from delegation. Shared-context and different-context workloads need separate evaluation; one favorable trial establishes neither general superiority nor production readiness.

Operational launchers and recording-stub checks tied to private sessions are deliberately not distributed. Repeating a workload requires an operator-owned authorized task/context and a new run identifier; do not reopen someone else's session or reuse private targets.

## Parent input context — v1

For each fresh parent assistant request:

```text
input context = usage.input + usage.cacheRead + usage.cacheWrite
```

Report first, last, peak and last-minus-first growth. Cached input still occupies context. Do not sum requests and call that context size: cumulative processed input is a separate measure that counts repeated history each time.

Exclude current output, child/nested usage and old model requests. Inherited conversation still present in a fresh input does count; child reports returned to the parent naturally count in later inputs. Record compactions/context edits, missing usage and abandoned branches. An incomplete sample's observed peak is a lower bound. Do not infer a context-window percentage or verified billing.

The extractor reads explicit files, follows the final active branch and treats unknown usage as unknown—not zero. It rejects malformed histories, duplicate IDs/paths, broken/cyclic chains and an existing output path. It never calls models or databases.

```bash
python3 profile-subagent/benchmark/context_usage.py \
  --output /path/to/private/new-comparison/context.json \
  /path/to/completed-a.jsonl /path/to/completed-b.jsonl
```

Use a new output path on every extraction. The output includes session hashes, per-request evidence, coverage, context-change flags and summaries. Keep it private: it can reveal session paths and identifiers.

Nine CLI fixtures cover accounting, missing/zero usage, broken/cyclic chains, duplicate IDs/inputs, invalid JSON and overwrite protection. Run `npm run verify --workspace profile-subagent` from the repository root.

## Evidence limits

Actual CLI/SDK tests prove execution mechanics, not autonomous decisions. The [synthetic real-model evaluation](../test/evaluation/README.md) separately covers selection, abstention and bounded work quality. Its fake DB transport does not execute SQL. Live queries, deployed-source matching, application behavior and repair approval require separate authorization and acceptance.

When schemas or source state change between arms, retain that uncertainty. Partial nested records can mean omitted argument bodies rather than unfinished calls; inspect complete child artifacts before judging execution. Preserve failures and adverse results alongside favorable comparisons.
