# polish-solution

A pi extension and skill for iterative multi-category review of a selected git worktree, defaulting to the session directory.

## What it does

- registers `polish_solution_review`
- ships a checked-in `polish-solution` skill that teaches the iterate/remediate/rerun workflow
- runs a fixed suite of isolated reviewer sub-sessions: adversarial, simplify, standardize, prune, and DRY
- gives each reviewer the fixed review scope and read-only tools to inspect its diff and repository context
- returns structured JSON using the upstream status names:
  - `needs-attention`
  - `approve`
- includes elapsed time and aggregate reviewer token usage in the visible JSON result metadata
- writes a per-run JSONL debug artifact under `~/.pi/agent/data/polish-solution-review/`

## Tool

- `polish_solution_review(worktreePath?, baseRef?, largeDiff?)`

`worktreePath` is an optional absolute or session-relative directory. It selects the checkout without moving or restarting the session; omitting it preserves the existing current-directory behavior. An invalid explicit path never falls back to another checkout. `baseRef` selects lineage within that checkout, not a different worktree.

For example, a session started elsewhere can review a known worktree with:

```json
{"worktreePath": "/path/to/feature-worktree"}
```

The tool shows the selected repository and branch before reviewers start. The visible result also includes the repository, branch, and base ref in `scope`. Artifacts retain the session directory, requested path, and resolved scope separately. Keep edits and validation on that same target when following up on findings; read its repository instructions before remediation.

The tool:

- defaults to `origin/main` when available, otherwise `main`
- diffs against the merge-base with the selected worktree, not the base tip directly
- includes uncommitted tracked changes and non-ignored untracked files
- accepts diffs up to 6,000 lines or 150 KiB by default
- supports an explicit `largeDiff: true` opt-in for diffs up to 10,000 lines or 250 KiB; this costs more, takes longer, and may reduce review quality through context dilution
- respects `.gitignore`
- uses the currently active model
- runs the five review categories sequentially in fixed order: `adversarial`, `simplify`, `standardize`, `prune`, `dry`
- creates a separate isolated child reviewer session for each category, each with its own internal `submit_review` call
- retries invalid or schema-invalid reviewer output up to 3 times per category
- returns compact JSON in visible content and the parsed review object plus hidden artifact metadata in `details`
- emits hidden artifact reference updates in the tool session stream so external consumers can capture the run file without polluting the visible JSON content

### Failure cases

The tool fails fast when:

- an explicit `worktreePath` is blank, or the selected directory is missing/not inside a git repo or worktree
- the requested base ref cannot be resolved
- no merge-base can be found
- there is no effective diff to review
- the diff is too large for a single category reviewer pass

Selecting a different target does not disable fixed-snapshot, submodule, or reviewer-control checks. A clean external reviewer source is still required when those self-review protections apply; a skipped/failed review is not approval.

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

Package-local `verify` runs GTS lint, TypeScript, existing unit checks, and a native SDK E2E test of checkout selection and scope boundaries. The E2E test uses real Git worktrees and a local scripted model, not a live reviewer. It prints an ignored `tmp/worktree-target/run-*` directory containing `evidence.json` and native JSONL artifacts for repeatable inspection.

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
