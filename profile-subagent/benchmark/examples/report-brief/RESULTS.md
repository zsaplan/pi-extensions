# E011 results: shorter reports did not reduce repeated reads

**Decision: park H006's candidate. Do not run the conditional confirmation or install it.** The primary screening requirement failed: the parent reopened the same nine successfully read files in both variants. Reports were shorter and required findings were preserved, but that is not the claimed reduction in repeated investigation. Overall efficiency is inconclusive because one provider failure left usage unknown.

## Observations

Four frozen local-file cases, one baseline/candidate pair per case, with alternating order. Exactly one specialist per trial; this is not a natural-routing evaluation. Baseline runtime came from `276b6ac`, with case/protocol commit `c7b6033`; candidate `d0e87e3` changes only shared child handoff instructions. [Predeclared protocol](PROTOCOL.md).

| Case | Child words A / B | Reopened successful files A / B | Seconds A / B | Total reported cost A / B | Peak parent input A / B |
|---|---:|---:|---:|---:|---:|
| Mixed configuration | 534 / 200 | 2 / 2 | 58.548 / 35.171 | $0.039698 / $0.044150 | 6,604 / 5,960 |
| Documentation claims | 301 / 194 | 3 / 3 | 51.812 / 38.551 | $0.041460 / $0.0364064 | 5,674 / 5,499 |
| Missing baseline | 285 / 207 | 2 / 2 | 33.323 / 32.265 | $0.0311132 / $0.040268 | 5,456 / 5,413 |
| Clean documentation | 205 / 169 | 2 / 2 | 40.123 / 126.207 | $0.037836 / unknown | 5,313 / ≥5,174 |

A = baseline; B = brief candidate. Median report words fell **32.8%**, from 293 to 197, satisfying the secondary report-length gate. Word counts follow the predeclared whitespace/alphanumeric rule, not token counts. Reopened-file counts count parent `read` calls on normalized paths previously read successfully by the child, using call ancestry and execution order. No grep/find/ls calls displaced reads; bounded reads still covered the complete tiny files.

The missing-file checks are separate: baseline parent tried once; candidate parent tried twice. Its first codemode result serialized the rejected `Error` as `{}`, then it reread the missing file to obtain the error text. This behavior is retained, not repaired or removed from results.

The clean-documentation candidate had a **WebSocket error** during its first parent request. Pi automatically retried inside the same CLI invocation and finished. The original partial tool call and zero-token usage placeholder remain in the session. The existing analyzer correctly left total cost unknown and parent-context coverage incomplete. There was no experiment-runner retry, trial replacement, or analyzer adjustment. Recorded known costs across all eight trials total **$0.3000428**, not a complete bill or complete experiment cost.

## Quality and limits

Assistant-led, unblinded review found all required material findings and uncertainty in every completed child and parent report: five configuration changes, the six claim classifications, missing history treated as missing, and clean agreement without invented defects. Source citations match the fixtures. All children used Sol/medium and the same four read-only file tools; all eight child usages reconciled with enclosing tool usage. No scope breach, writes, external queries, additional model helpers, truncation, or input drift was observed. Initial parent model/tool/system setup matched within every pair.

The parent checked source material rather than merely restating a child's claims. For these tiny files, rereading all evidence is a reasonable verification step; the count alone does **not** establish waste. Shorter prose did not remove the need for source verification. Parent-generated child assignments also varied in wording: the mixed baseline requested a comprehensive report regardless of length. That natural variation limits attribution of report-length differences to the intervention alone.

Do not discard the failed request, present the three complete pairs as the full experiment, or turn shorter prose into a successful H006 efficiency claim. There is no complete four-pair cost/context result, and the clean-case delay cannot be attributed to handoff formatting. No confirmation batch is justified under the frozen gates.

## Evidence and verification

Private group `E011-01` preserves the source/frozen plans, invocation records, all eight original event streams and sessions, failed request and native retry, copied child artifacts, summaries, completed review and count audit. The existing runner/analyzer was reused unchanged. Before reporting, 202 frozen paths, source copies, evidence hashes, parent/child defaults, read order and 0700/0600 evidence permissions were checked. Package verification passed 93 tests and repository verification passed before testing; one fixture-formatting lint failure was retained and corrected before freezing.

The candidate remains isolated and uninstalled. Installed runtime, parked H004, SQL validation, and operational systems were not changed. A future evidence-reuse experiment would be a new hypothesis with its own quality/authority rules—not a retuned or relabeled H006 success.
