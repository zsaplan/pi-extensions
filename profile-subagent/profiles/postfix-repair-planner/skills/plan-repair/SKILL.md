---
name: plan-repair
description: Validate one missing postfix outcome and draft a bounded repair package without writes.
---

# Plan a postfix repair

1. Read the task's audit README, run-status, report, and relevant source postfix. Confirm that report collection succeeded; missing/truncated probe results are unverified, not absent.
2. State the exact target site/environment/database, finding, source revision evidence, relevant source paths, and report age. If deployment/source matching is unproven, keep it as a blocking check.
3. Inspect later recorded migrations and current application usage. Test semantic identity, not UUID alone. Rule out replacement records, client applicability, intentional deletion, and customer customization.
4. Collect narrowly scoped live read-only evidence where authorized. Source hashes in a report do not prove what ran historically. Keep historical cause separate from the current mismatch.
5. Classify the outcome: confirmed gap, intentional change, or unresolved. A confirmed gap alone is not approval to restore the original default.
6. Only for a supported repair candidate, propose the smallest idempotent change. Do not rerun a whole postfix or delete its ledger record. Preserve existing values and unrelated rows.
7. Return the package below. Return SQL as proposed text only, never submit it to a tool.

## Required result

- **Disposition:** repair candidate / no repair / blocked.
- **Target and scope:** exact site/environment/database, source revision evidence, one finding/dependency group.
- **Evidence:** query IDs or exact read-only queries/results, source references, report paths and freshness.
- **Reasoning:** expected current invariant, superseding migrations, semantic identity, customization/applicability checks, unresolved alternatives.
- **Proposed change:** exact proposed SQL, dependencies, expected row counts, idempotency and concurrency behavior. If evidence is incomplete, do not call the SQL executable.
- **Preconditions:** fresh target identity, source match, expected values/absence and counts, constraints, transaction/storage-engine assumptions. Abort rather than overwrite unexpected state.
- **Recovery:** before-image/backup requirements and conditional reversal. Do not claim a backup exists without evidence. Explain DDL/nontransactional limits if relevant.
- **Verification:** exact postcondition probes, audit rerun, relevant application behavior and regression checks.
- **Approval boundary:** not authorized; needs independent review, explicit human approval of exact target/SQL, and a separately guarded executor.
- **Acceptance checklist:** leave every unperformed check unchecked.

The existing Python/uv auditor remains the deterministic diagnosis/verification layer. This profile cannot run it: request fresh artifacts from the parent if needed. Do not improvise shell access.
