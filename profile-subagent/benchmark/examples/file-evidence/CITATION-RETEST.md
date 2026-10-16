# E014: citation recurrence diagnostic

**The original off-by-one error did not recur in three fresh candidate runs.** All three new baseline runs also had correct citations. This is evidence against a consistent failure in this case, not proof that citation errors are rare or impossible. The original error remains in E013; no acceptance rule was relaxed and no candidate code was changed.

## Fixed rerun

At the user's request, predeclared three additional pairs on the same mixed-configuration case. Orders: candidate/baseline, baseline/candidate, candidate/baseline. Same user prompt, source files, authorization, Sol/medium parents/children and candidate `7ef29d4`. Baseline `622710f` has unchanged runtime/profile code from E013. Verified 54 relevant original frozen paths before launch. These are six new diagnostic trials, not replacement of E013 or its conditional confirmation. No experiment retries, native provider retries, or additional trials occurred.

| Child report | Original E013 pair | Three new repeats | Combined observations |
|---|---|---|---|
| Candidate | Incorrect line references | Correct / correct / correct | Error in 1 of 4 reports |
| Baseline | Correct line references | Correct / correct / correct | Error in 0 of 4 reports |

Each new report included all five changed-field before/after line pairs. All **30 candidate addresses and 30 baseline addresses** matched one-based source lines; grouped unchanged-setting locations/ranges also checked correctly. These addresses are not 60 independent trials. All six new final answers preserved the correct five changes, unchanged settings and runtime limits. Baseline final answers included correct line references; candidate final answers used file/field references without line numbers. No incorrect line reference reached a final answer, including in the original E013 pair.

## Secondary measurements

| Repeat | Cost baseline / candidate | Seconds baseline / candidate | Peak parent input baseline / candidate |
|---|---:|---:|---:|
| 1 | $0.0465732 / $0.0418980 | 47.928 / 45.992 | 11,795 / 6,526 |
| 2 | $0.0578652 / $0.0351136 | 53.655 / 47.546 | 13,785 / 6,449 |
| 3 | $0.0657660 / $0.0428420 | 54.346 / 53.449 | 11,517 / 6,541 |

Mean of the three paired candidate/baseline ratios: **28.1% lower reported cost, 47.0% lower peak parent input, 5.7% shorter elapsed time**. Every parent used 4 requests in baseline versus 3 in candidate. Both arms had one child. The second baseline child also performed two line-numbered grep checks and used an extra request; methods and generated child-assignment wording were not identical despite fixed user prompts and required coverage. These small-sample results are secondary observations, not general efficiency or full-screen acceptance.

Total reported parent-plus-child cost for the six new trials: **$0.290058**, not a verified bill. All usage/context records were complete and reconciled. Baseline parents each imported their own full child transcript; candidate parents made no extra source/artifact reads. All candidate packets exactly matched their two original post-hook read results and the source files, with correct IDs/requested arguments and no omissions or unavailable records. No child prompts/reasoning were in those packets. Scope, model/tool defaults, original source copies, evidence hashes, 226 frozen paths and private 0700/0600 permissions were checked before reporting. The existing runner/analyzer was reused unchanged. A post-run citation audit initially counted its table header as a finding; that audit-only assertion failure was retained and the row selector corrected without repeating any trial.

## Review and remaining work

The available evidence supports **intermittent rather than consistently reproducible citation failure in this case**. It does not establish a true failure rate or attribute the original error to the feature. Review was assistant-led and unblinded; the same small case was repeated. The runtime does not alter the child instructions or original source-read content.

The evidence-packet mechanism and reduced context/request count repeated successfully, but H008's broader acceptance is still open. Keep the original defect recorded and the candidate unchanged while reviewing these results with the user. No other-case screening, unchanged-candidate confirmation, merge, installation or external publication was performed. Remaining coverage/quality decisions in [E013 results](RESULTS.md) are not automatically checked off by this diagnostic.

Private evidence: `file-evidence-citation-retest/E014-01` contains the frozen/source plan, all six original sessions/events, child artifacts and completed review. Adjacent `review-audit.json`, `provenance.json`, `protocol.md` and the summary pointer retain the review method and audit evidence. Public content contains only this sanitized summary.
