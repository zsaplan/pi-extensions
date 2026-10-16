# H006 / E011: compact evidence handoffs

## Claim and intervention
A shorter, structured child report reduces repeated parent investigation without losing decisive evidence or uncertainty. The baseline already requires concise, cited reports; this is a marginal improvement hypothesis, not a comparison with an intentionally weak control.

Only `childEvidenceHandoff` changes in a separate candidate worktree. It suggests 150–250 words (fewer for simple/clean work; exceed to preserve material evidence), compact conclusion/evidence/limits, and precise parent-verification locations. Parent instructions, role instructions, authority, tools, models/thinking, turn/time limits and accounting remain unchanged. All five profile digests consequently change; only two file roles are evaluated. No installation decision is implied.

## Fixed cases and quality floor
The four cases and prompts are frozen before any model run. Case directories are the only allowed source scope. This protocol/rubric is for the observer, not the model.

| Case | Required coverage in child and parent reports |
|---|---|
| config-mixed | Five changes: gateway replicas 2→4 and image :1→:2; batch memory 512Mi→768Mi; search cache true→false; reports replicas 1→2. Workload order is not a change. All timeouts remain 30 and CPU 500m; other unchanged values may be grouped. Deployment/health/benefit remain unverified. |
| docs-claims | Retries 2 and concurrency 4 supported. Timeout 1000 vs 1500 and audit enabled vs false contradicted. TIMEOUT_MS=0 is retained as 0 by the supplied resolver, contradicting the documented fallback. Uptime guarantee unresolved, not a measured failure. Actual deployment/configuration overrides unverified. |
| config-gap | before.json is absent. Report current replicas 3, image demo/api:2 and timeout 30. Recollection of five replicas is not a verified baseline; do not conclude a measured increase/decrease or actual health. Preserve the unavailable-evidence check; no invented baseline. |
| docs-clean | All three documented defaults agree: retries 3, timeout 5000, audit false. No invented defect. Runtime/overrides not verified. |

A pass requires all material coverage, no invented source/evidence/test execution, no incorrect confidence upgrade, and no scope/write violation. Expected missing-file read failures in config-gap are evidence gaps, not automatically failed quality. Any other failure is retained and reviewed. Do not exclude failed trials from the record or silently retry them.

## Fixed design
Eight screening trials, one pair per case. Orders: config-mixed A/B; docs-claims B/A; config-gap A/B; docs-clean B/A. A is baseline, B candidate. Same case/cwd/authorization and declared parent tools per pair; exactly one requested child keeps delegation allocation fixed. Real parent and children use openai-codex/gpt-6.1-sol, medium thinking. Isolated resources, normal provider credentials, local files only. Each CLI budget is 180 seconds. Review after each pair and pause for a scope/quality failure or unexpected cost. $3 reported cumulative cost is a review threshold, not a hard billing cap.

## Predeclared decision rules
Primary mechanism: candidate reduces the aggregate number of repeated parent file-read calls by at least 25%, with full quality in every pair. A repeated read means a parent `read` of a normalized file path already successfully read by its child; identify the child by the recorded call-ID ancestry. Count attempts to reopen the missing baseline separately. Inspect grep/find/ls and read ranges too: replacing reads with equivalent searches or broad reads is not a genuine reduction. Source verification is never waived just to win this metric.

Secondary requirements for a promising screening result: median child report word count at least 20% lower (whitespace-delimited tokens containing at least one letter or digit; punctuation-only table delimiters do not count), and mean paired candidate/baseline ratios for total reported cost, elapsed time and peak parent input each no greater than 1.10. Ratios use complete, matching-quality pairs; missing metrics or differing material coverage make efficiency inconclusive, not a win. If baseline duplicate reads are zero, this mechanism cannot demonstrate a reduction.

If all gates pass, run one predeclared confirmation batch with the same frozen candidate/cases and reversed pair orders; do not tune the candidate. Require the primary and quality gates again and assess the same secondary limits. If screening fails, park this candidate under H006 rather than changing the metric or intervention mid-group. Secondary observations may motivate a separately recorded hypothesis but do not turn H006 into a success.

## Evidence and review
Use the existing `prepare`, named `run`, `summarize` and `measure` commands. Review final answers, child reports, source citations, raw call arguments, model/tool metadata and accounting. Record report word counts and parent repeated-read counts alongside existing cost/time/context outputs in the completed review. Reviewer is the assistant and unblinded; one small local-file batch cannot establish general superiority or live-DB correctness. Preserve all attempts and pricing/coverage limitations. Raw evidence stays private; only sanitized conclusions enter the ledger. The installed runtime and H004 remain unchanged.
