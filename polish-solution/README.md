# polish-solution

A pi extension and skill for iterative multi-category review of the current git worktree.

## What it does

- registers `polish_solution_review`
- ships a checked-in `polish-solution` skill that teaches the iterate/remediate/rerun workflow
- runs a fixed suite of isolated reviewer sub-sessions: adversarial, simplify, standardize, prune, and DRY
- gives each reviewer only the current diff by default, plus read-only inspection tools if it needs repository context
- returns structured JSON using the upstream status names:
  - `needs-attention`
  - `approve`
- includes elapsed time and aggregate reviewer token usage in the visible JSON result metadata
- writes a per-run JSONL debug artifact under `~/.pi/agent/data/polish-solution-review/`

## Tool

- `polish_solution_review(baseRef?)`

The tool:

- defaults to `origin/main` when available, otherwise `main`
- diffs against the merge-base with the current worktree, not the base tip directly
- includes uncommitted tracked changes and non-ignored untracked files
- respects `.gitignore`
- uses the currently active model
- runs the five review categories sequentially in fixed order: `adversarial`, `simplify`, `standardize`, `prune`, `dry`
- creates a separate isolated child reviewer session for each category, each with its own internal `submit_review` call
- retries invalid or schema-invalid reviewer output up to 3 times per category
- returns compact JSON in visible content and the parsed review object plus hidden artifact metadata in `details`
- emits hidden artifact reference updates in the tool session stream so external consumers can capture the run file without polluting the visible JSON content

### Failure cases

The tool fails fast when:

- the current working directory is not inside a git repo or worktree
- the requested base ref cannot be resolved
- no merge-base can be found
- there is no effective diff to review
- the diff is too large for a single category reviewer pass

## Skill

- `polish-solution`

Use the skill when you want pi to keep control of a deliberate polishing loop:

1. run the full review suite
2. address material findings or conflicts
3. run the relevant validation commands for the changed code
4. rerun the full suite from the first category only after validation is back to green or any pre-existing failures are understood
5. repeat until approval or a real ambiguity needs user direction

## Usage

```bash
# load just this package from the repo checkout
pi -e ./polish-solution

# or load the whole repo-backed package
pi -e .
pi install .
```

## Local validation

```bash
npm run verify --workspace polish-solution
cd polish-solution && npm run verify
```

Package-local `verify` runs GTS lint, TypeScript, and deterministic unit tests for review-scope/path safety helpers.

Then either:

- ask pi to use the `polish-solution` skill, or
- call `polish_solution_review` during implementation work

## Notes

- Reviewer prompts are composed from shared safety/output-schema blocks plus category-specific objectives.
- No extra situational summary is passed to reviewers by default.
- Out-of-scope feedback such as tests and other external supports is intentionally excluded from review findings.
- Each saved debug artifact is a progressive JSONL trail: it is created at run start, appended during scope/category/reviewer progress and conflict analysis, and finished with a final success/error snapshot when the run ends cleanly.
- Interrupted runs keep the partial artifact trail that was flushed before interruption, so later debugging still has a checkpointed history even if there is no final snapshot line.
- The final artifact snapshot captures the fixed review scope, final review/error metadata, category results, conflicts, aggregate reviewer usage, and the isolated reviewer session messages for later debugging.
- The artifact path is kept out of the visible tool JSON content; it is stored in hidden tool details and a non-LLM custom session entry.
- The skill workflow still expects the primary coding agent to run relevant lint/test/verify-style validation after each remediation pass before rerunning the full review suite.
