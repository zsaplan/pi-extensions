---
name: polish-solution
description: Run iterative multi-category review suites on the current git worktree with polish_solution_review, then remediate and rerun until material findings are exhausted.
compatibility: Requires a git repository or worktree with a meaningful diff against a main-like base ref.
---

# polish-solution

Use this skill when the user wants the current change set polished through a deliberate multi-category review suite rather than a single quick self-check.

## Goal

Keep the primary coding agent in control of the loop:

1. run `polish_solution_review`
2. study only material findings from the category suite
3. remediate while preserving the intended architecture
4. run relevant validation commands for the changed code
5. rerun the full review suite from category 1 only after validation is back to green or any pre-existing failures are clearly understood
6. stop when the suite approves or repeated findings/conflicts require user direction

## Workflow

1. Start with `polish_solution_review` using the default base unless the user explicitly wants a different lineage.
2. Do not invent extra reviewer context or a task summary. The tool already provides the fixed reviewer instructions plus the current diff.
3. If the tool returns `approve`, report that all review categories approved with no material findings and stop unless the user wants more changes.
4. If the tool returns `needs-attention`, address the findings deliberately:
   - prefer code changes over comments
   - add comments only when they genuinely preserve design intent
   - prefer replacing unclear code over layering more code onto it
   - keep the solution aligned with intended architecture instead of over-hardening irrelevant edges
5. After every substantial remediation pass, run the relevant validation commands before rerunning the review suite:
   - prefer the repo's canonical validation entrypoint when one exists, such as `verify`, `test`, or another documented umbrella command
   - otherwise run the narrowest meaningful lint/typecheck/test commands that cover the changed surface area
   - do not pile up known validation failures across passes; either fix them or call out clearly why they are pre-existing or currently out of scope
6. Only after validation has been checked should you rerun `polish_solution_review`; the rerun restarts the full suite from the first category.
7. Continue with no fixed iteration cap.
8. Ask the user for direction only when:
   - the same underlying finding keeps recurring across passes
   - the right fix is ambiguous and you cannot reason through it confidently
   - a tool failure, validation ambiguity, or diff-scope issue blocks the workflow

## Tool notes

- `polish_solution_review` automatically reviews the full current worktree state, including uncommitted tracked changes and non-ignored untracked files.
- The default base is `origin/main` when available, otherwise `main`.
- Use `baseRef` only when the user wants a different comparison base or the default lineage is wrong.
- The tool runs five isolated internal child reviewer sessions in order: `adversarial`, `simplify`, `standardize`, `prune`, and `dry`.
- Each category has its own read-only reviewer session and its own internal `submit_review` call; only the parent tool aggregates IDs, category metadata, conflicts, and the final suite result.
- Unresolved conflicts are represented as `status: "needs-attention"` with `conflicts[].resolution = "needs-user-direction"`; there is no top-level `blocked` status.
- The tool fails fast when there is no effective diff, when the base ref cannot be resolved, when no merge-base exists, or when the diff is too large for one category reviewer pass.

## Review interpretation rules

- Treat only material category findings as iteration drivers: correctness/robustness/design, avoidable complexity, convention drift, dead/redundant code, or risky duplication.
- Ignore findings that would only ask for out-of-scope external supports such as tests.
- Prefer one strong remediation over several cosmetic changes.
- Keep user-facing status updates concise. Surface progress mainly when there are meaningful findings, blockers, or the user asks.

## Response pattern

After each pass, summarize briefly:

- review status
- material findings or conflicts addressed/remaining
- whether another full suite pass is being run now or user input is needed
