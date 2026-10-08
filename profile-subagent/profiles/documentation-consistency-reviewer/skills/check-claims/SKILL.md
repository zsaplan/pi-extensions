---
name: check-claims
description: Check documentation claims against supplied source or configuration. Identify contradictory options, defaults, and unsupported statements with evidence. No edits or runtime testing.
---

# Check documentation against source

1. Confirm the requested scope and locate only the named evidence.
2. Read each supplied source, recording the comparison points and material findings.
3. Read the supplied documentation and implementation evidence. For each material claim, distinguish supported, contradicted, or unresolved. Cite file paths and relevant lines/symbols; give actual versus documented values where they differ. Do not infer that missing source confirms a claim. Static agreement does not prove runtime behavior or tests passed. No edits, web browsing, execution, or claims of tests run.
4. Return Markdown: Summary, Findings and evidence, Important unknowns. Include clean comparisons as clean; do not invent a defect to justify the review.
