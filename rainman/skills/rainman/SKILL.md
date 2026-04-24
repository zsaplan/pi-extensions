---
name: rainman
description: Use Rainman lookup deliberately for stable previously-derived project knowledge, then either trust cited answers or pivot to normal investigation when evidence is insufficient or conflicting.
---

# Rainman lookup workflow

Use this skill when a user asks about stable project knowledge that may already be captured in Raincatcher, such as workflows, conventions, ownership, source-of-truth paths, durable conclusions, or recurring explanations.

## Workflow

1. Decide whether the request is stable knowledge or live state.
2. For stable knowledge, call `rainman_lookup` before re-deriving the answer from files, logs, databases, or external systems.
3. If Rainman returns `answered`, use the cited answer and include the relevant caveat if warnings are present.
4. If Rainman returns `insufficient_evidence`, say the KB does not have enough evidence and continue normal investigation when the user still needs an answer.
5. If Rainman returns `conflict`, summarize the conflict and investigate the source of disagreement before choosing a conclusion.
6. Do not use Rainman as the first step for active incidents, current logs, very recent code changes, live dashboards, reproductions, or transient operational state.

## Output discipline

- Treat `find` and `grep` activity from Rainman as navigation, not evidence.
- Treat cited `read` output as the only Rainman evidence.
- Do not invent unstated rationale when Rainman says the KB is insufficient.
- Preserve the distinction between cached durable knowledge and live investigation.

## Diagnostics

- Use `/rainman` when you need current KB root, session counters, last run metadata, or artifact mode.
- Use `/rainman test` when you need a smoke test of the lookup path.
- When Rainman behavior is surprising, inspect any artifact path surfaced in tool details or session metadata.
