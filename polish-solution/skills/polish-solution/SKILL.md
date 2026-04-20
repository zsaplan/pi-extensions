---
name: polish-solution
description: Run iterative adversarial review passes on the current git worktree with polish_solution_review, then remediate and rerun until material design and robustness findings are exhausted.
compatibility: Requires a git repository or worktree with a meaningful diff against a main-like base ref.
---

# polish-solution

Use this skill when the user wants the current change set polished through deliberate adversarial review rather than a single quick self-check.

## Goal

Keep the primary coding agent in control of the loop:

1. run `polish_solution_review`
2. study only material findings
3. remediate while preserving the intended architecture
4. run relevant validation commands for the changed code
5. rerun adversarial review only after validation is back to green or any pre-existing failures are clearly understood
6. stop when the review approves or repeated findings require user direction

## Workflow

1. Start with `polish_solution_review` using the default base unless the user explicitly wants a different lineage.
2. Do not invent extra reviewer context or a task summary. The tool already provides the fixed reviewer instructions plus the current diff.
3. If the tool returns `approve`, report that there are no material adversarial findings and stop unless the user wants more changes.
4. If the tool returns `needs-attention`, address the findings deliberately:
   - prefer code changes over comments
   - add comments only when they genuinely preserve design intent
   - prefer replacing unclear code over layering more code onto it
   - keep the solution aligned with intended architecture instead of over-hardening irrelevant edges
5. After every substantial remediation pass, run the relevant validation commands before rerunning adversarial review:
   - prefer the repo's canonical validation entrypoint when one exists, such as `verify`, `test`, or another documented umbrella command
   - otherwise run the narrowest meaningful lint/typecheck/test commands that cover the changed surface area
   - do not pile up known validation failures across passes; either fix them or call out clearly why they are pre-existing or currently out of scope
6. Only after validation has been checked should you rerun `polish_solution_review`.
7. Continue with no fixed iteration cap.
8. Ask the user for direction only when:
   - the same underlying finding keeps recurring across passes
   - the right fix is ambiguous and you cannot reason through it confidently
   - a tool failure, validation ambiguity, or diff-scope issue blocks the workflow

## Tool notes

- `polish_solution_review` automatically reviews the full current worktree state, including uncommitted tracked changes and non-ignored untracked files.
- The default base is `origin/main` when available, otherwise `main`.
- Use `baseRef` only when the user wants a different comparison base or the default lineage is wrong.
- The tool fails fast when there is no effective diff, when the base ref cannot be resolved, when no merge-base exists, or when the diff is too large for one reviewer pass.

## Review interpretation rules

- Treat only material design, robustness, and correctness findings as iteration drivers.
- Ignore findings that would only ask for out-of-scope external supports such as tests.
- Prefer one strong remediation over several cosmetic changes.
- Keep user-facing status updates concise. Surface progress mainly when there are meaningful findings, blockers, or the user asks.

## Response pattern

After each pass, summarize briefly:

- review status
- material findings addressed or remaining
- whether another pass is being run now or user input is needed
