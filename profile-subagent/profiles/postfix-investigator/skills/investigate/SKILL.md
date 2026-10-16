---
name: investigate-postfix-findings
description: Classify a fixed set of postfix findings for one target using read-only evidence.
---

# Investigate postfix findings

1. Confirm the exact site/environment, assigned finding list, source tree, auditor documentation and evidence paths. Read shared setup once and reuse it across the assignment.
2. For each finding, inspect the original change, relevant successors/semantic replacements and current consumers. An applied ledger row alone does not establish the outcome; a missing outcome does not establish migration failure.
3. Check fresh database metadata or presence/counts where needed, through the approved tools. Keep each SQL request to one read-only statement. If a query is rejected, preserve the failure and use an allowed alternative only when it answers the same question. Prioritize checks that could change the classification; do not expand into a general schema or application audit.
4. Classify each assigned group as current missing outcome, intentional supersession, conditional/not applicable, or unresolved. Keep evidence separate from inference, and do not assume source matches the deployed version or absence proves user impact.
5. Return one report with a row/section for every assigned group, specific source/DB citations and observed counts, and material uncertainty. Include the decision checklist below so the parent can inspect decisive evidence without repeating every query. Reuse common evidence without hiding per-finding gaps. Do not add repair plans or readiness claims.

## Decision checklist

For each relevant check, report verified with evidence, unresolved, or not applicable with a reason:

- **Identity:** check natural/semantic identities, not only original UUIDs. Search alternate identities only when source/evidence gives a plausible replacement lead; an exhaustive alias hunt is not required.
- **Successor and consumer:** inspect what the relevant successor actually changes and whether current consumers still require the outcome. A ledger row alone is not proof of a successful outcome or deployed-source matching.
- **Active state:** when claiming seeded records are usable by consumers that filter active records, check expected active-state counts. Mere presence does not prove usability.
- **Replacement structure:** when claiming the replacement structure is valid, inspect exact PK/FK columns and referenced targets, not just a constraint count. Mere replacement-table presence supports only that narrower observation.
- **Applicability/completeness:** check relevant location/association metadata or counts when making a coverage claim. Current counts cannot prove historical transfer completeness or historical applicability.

Use only the assigned site and permitted metadata/presence/count queries. Do not inspect settings values, secrets or customer rows to fill checklist gaps. Preserve failed/unperformed checks and narrow the conclusion when an essential check cannot be completed.
