# polish-solution

A pi extension and skill for iterative adversarial review of the current git worktree.

## What it does

- registers `polish_solution_review`
- ships a checked-in `polish-solution` skill that teaches the iterate/remediate/rerun workflow
- runs an isolated reviewer sub-session with a fixed adversarial-review instruction set
- gives the reviewer only the current diff by default, plus read-only inspection tools if it needs repository context
- returns structured JSON using the upstream status names:
  - `needs-attention`
  - `approve`

## Tool

- `polish_solution_review(baseRef?)`

The tool:

- defaults to `origin/main` when available, otherwise `main`
- diffs against the merge-base with the current worktree, not the base tip directly
- includes uncommitted tracked changes and non-ignored untracked files
- respects `.gitignore`
- uses the currently active model
- retries invalid or schema-invalid reviewer output up to 3 times
- returns compact JSON in visible content and the parsed review object in `details`

### Failure cases

The tool fails fast when:

- the current working directory is not inside a git repo or worktree
- the requested base ref cannot be resolved
- no merge-base can be found
- there is no effective diff to review
- the diff is too large for a single reviewer pass

## Skill

- `polish-solution`

Use the skill when you want pi to keep control of a deliberate polishing loop:

1. run adversarial review
2. address material findings
3. rerun review
4. repeat until approval or a real ambiguity needs user direction

## Usage

```bash
# load just this package from the repo checkout
pi -e ./polish-solution

# or load the whole repo-backed package
pi -e .
pi install .
```

Then either:

- ask pi to use the `polish-solution` skill, or
- call `polish_solution_review` during implementation work

## Notes

- The reviewer prompt is fixed and inline in the extension code.
- No extra situational summary is passed to the reviewer by default.
- Out-of-scope feedback such as tests and other external supports is intentionally excluded from review findings.
