# H007 / E012: reuse raw evidence within the handoff

## Hypothesis
For bounded snapshot-file assignments, retrieving the child's original read results in the same codemode call as the child run can remove a parent request cycle and repeated source retrieval without reducing independent verification. This tests evidence delivery, not shorter prose or more delegation. H004 and H006 remain parked.

The baseline already exposes private child artifacts. Change only parentDelegationGuidance in a separate worktree to suggest chaining the run with filtered raw-evidence retrieval. Child instructions/digests, role scope, model/thinking, permissions, queue, accounting and report limits remain unchanged. No new runtime API, launcher or analyzer is needed.

## Cases and authority
Reuse all four E011 source cases/prompts and the material-quality rubric in [the original protocol](../report-brief/PROTOCOL.md). Child scope remains named case files only. Both parents may inspect the messages.json artifact in the exact directory returned by their own specialist run. No other artifact directories, credentials, live systems or external helpers are authorized. Files remain unchanged during the experiment; frozen pre/post hashes verify this, not an assertion about general filesystem immutability.

Original read records must be matched to read tool-call arguments and IDs. Include failures and coverage/truncation limits, not only successes. Do not mistake the child summary for source evidence or pass its system prompts/reasoning into the parent. Parent conclusions must be independently supported by the original recorded tool evidence. Missing, malformed, mismatched or truncated records require targeted source reads or an incomplete conclusion. Current/mutable evidence still requires appropriate freshness checks. Snapshot evidence is observation-time evidence, not a guarantee of present live state. This experiment does not relax production verification or authorize rollout.

## Fixed screening design
Eight fresh trials, one pair per case. Order: mixed configuration B/A, documentation claims A/B, missing baseline B/A, clean documentation A/B. Exactly one child in each arm; same prompt, case cwd and authorization. A uses baseline guidance; B uses the evidence-reuse suggestion. Parent/child openai-codex/gpt-6.1-sol, medium; 180-second CLI budget. Review after each pair for scope/quality/cost problems. $3 cumulative reported cost triggers review, not a hard billing cap. Unknown usage stays unknown. Native provider retries are retained; no experiment-level retry or replacement.

## Predeclared gates
All eight completed parent/child reports must meet the original material-coverage and uncertainty rubric. In reuse trials, inspect the raw evidence delivered to the parent and its code: correct tool-call/result pairing, named source files, errors/gaps retained, no substituted report claims, no unsupported claims of independent rereads or runtime tests, no unrelated artifacts or scope violation.

Mechanism: reduce aggregate parent model requests by at least 20% and repeated source-file reads by at least 50%. Count artifact reads separately; no hidden source queries/helpers. A count reduction by itself is insufficient.

Usefulness: mean paired candidate/baseline cost ratio at most 0.90, with mean paired elapsed-time and peak-parent-input ratios each at most 1.10. Costs include parent plus nested child usage once. Require complete usage/context and matching coverage in every pair; otherwise overall efficiency is inconclusive, not a win. Preserve every attempt and do not replace missing costs with zero or discard a slow/failing trial. Report artifact size/filtering overhead and legitimate verification separately from avoidable duplication.

If all screening gates pass, run the unchanged cases/candidate once more in reversed pair orders, applying the same gates. Otherwise park the candidate rather than tuning it in place. Provider failures do not justify deleting or silently rerunning trials. Assistant review is unblinded; small synthetic local-file evidence cannot establish general benefit, operational correctness or adoption readiness.

## Evidence
Use existing experiments.py prepare/run/summarize/measure and inspect raw sessions, calls, child artifacts and model/accounting metadata. Retain originals privately. Report sanitized results in the ledger with limits and prospective/retrospective distinctions. Keep installed runtime and previous candidates unchanged. Package then repository verification must pass before candidate runs/commits.
