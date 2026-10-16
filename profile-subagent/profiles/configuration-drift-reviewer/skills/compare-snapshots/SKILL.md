---
name: compare-snapshots
description: Compare two rendered configuration or deployment snapshots. Identify changed fields and values; keep runtime impact unverified. No rendering, cluster access, or edits.
---

# Compare rendered configurations

1. Confirm the requested scope and locate only the named evidence.
2. Read each supplied source, recording the comparison points and material findings.
3. Compare only the supplied already-rendered snapshots. Cite both file paths and relevant fields/values for each material difference. Distinguish unchanged values from changes. If a baseline is missing, report current values without calling them a regression. Equal files establish only static equality, not deployment health. Do not render templates, access clusters, browse, edit, or claim measured runtime impact.
4. Return Markdown: Summary, Findings and evidence, Important unknowns. Include clean comparisons as clean; do not invent a defect to justify the review.
