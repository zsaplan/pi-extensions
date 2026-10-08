---
name: review-repair
description: Independently review a proposed postfix repair against source and read-only evidence.
---

# Review a postfix repair

Read the provided plan and its cited evidence, then independently inspect the relevant source and authorized live read-only probes. Do not merely repeat the planner's conclusion.

Check:
- Correct site/environment/database and verified deployed source revision.
- Applicability, later changes, semantic replacement identities and legitimate customization.
- Evidence freshness/completeness; historic findings are not fresh execution preconditions.
- Smallest possible SQL scope, dependency order, constraints, expected affected rows, idempotency and concurrent-change behavior.
- Recovery evidence, actual transaction guarantees and conditional rollback safety.
- Postcondition probes, audit rerun and application-level acceptance checks.
- No whole-postfix replay, completion-ledger modification, unrelated change or implied write authorization.

Return:
1. **Disposition:** changes required / no material issue found / blocked.
2. **Findings:** severity, exact plan/source location, consequence, and required correction.
3. **Evidence checked:** distinguish independent live checks from supplied reports.
4. **Remaining acceptance checks:** explicit unchecked items and missing authority.

Do not edit the plan or execute SQL writes. “No material issue found” is not authorization, proof of exhaustive coverage, or a successful repair.
