# E012: stopped after the first pair

**Decision: park H007's prompt-only candidate.** The first candidate returned the entire child transcript instead of filtering original read results. That violated the predeclared evidence-handling gate, so six planned trials and conditional confirmation were not run. Do not tune this candidate in place or call the unfinished screen a success.

| Mixed-configuration trial | Parent requests | Source rereads | Artifact reads | Seconds | Total reported cost | Peak parent input |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 4 | 0 | 1 | 48.169 | $0.0421124 | 9,632 |
| Evidence-reuse cue | 3 | 0 | 1 | 48.619 | $0.0456064 | 11,372 |

The candidate chained run and artifact retrieval, removing one parent request. But its code printed all of `messages.json`, including child prompt and reasoning metadata. Its 19,657-byte transcript entered parent context; it did not implement the requested ID/argument-matched raw-result filtering. Parent peak input was 18.1% higher and total reported cost 8.3% higher in this pair. The baseline also chose its authorized child artifact without the new cue and read the complete 16,478-byte transcript. Source-reread counts were already zero in the baseline, so no reduction can be demonstrated.

Both final reports and child reports preserved the five configuration changes, unchanged settings, source citations and runtime limitations. They accurately described verification against recorded reads rather than claiming fresh source reads. This is an evidence-delivery failure, not an observed incorrect configuration conclusion or unauthorized external disclosure. Own-run artifact access was explicitly permitted in both arms; neither used unrelated files, external systems, writes or extra model helpers.

The existing runner/analyzer required no changes. Both trials have complete accounting/context, one child each, unchanged child instruction digest, Sol/medium defaults, and the same four child file tools. Known total reported cost is $0.0877188, not a verified bill. Input/evidence hashes, source copies and private permissions were checked before reporting; package and repository verification passed before the runs. A small one-pair observation is not a general performance estimate.

Baseline `542a4f0`; candidate `c08f300`, changing only parent guidance. [Predeclared protocol](PROTOCOL.md). Private group `E012-01` retains both original sessions, event streams, child artifacts, summaries and `review-audit.json`; the other six trials remain explicitly not run. Candidate is local and uninstalled. H004 and H006 remain parked. A deterministic bounded evidence-return feature would need a new hypothesis, permission/redaction checks and separate tests—not a relabeled H007 success.
