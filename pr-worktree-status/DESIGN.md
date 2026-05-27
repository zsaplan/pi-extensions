# PR Worktree Status Design

## Purpose

`pr-worktree-status` is a Pi extension for sessions dedicated to GitHub PR review. It keeps the PR associated with the current worktree visible above pi's model/thinking footer and offers a direct command for creating PR worktrees from PR URLs.

The extension is intentionally deterministic and command-driven. It does not ask the LLM to inspect PR state, create worktrees, or refresh status.

## Scope

In scope:

- current-worktree PR detection
- right-aligned PR status widget through `ctx.ui.setWidget(..., {placement: 'belowEditor'})`
- shared 5-minute cache backed by local files
- direct `gh` CLI polling
- `/pr-refresh`
- `/pr-worktree <url>` using the `<repo>-pr-<number>` sibling-directory convention

Out of scope for the first build:

- global review-request inboxes
- global review/request widgets beyond the current-worktree status line
- PR opening commands
- interpreting opaque GitHub review-decision fields
- changing the current pi process working directory after creating a worktree

## Detection model

The extension first resolves the git root, branch, and GitHub remote for `ctx.cwd`.

If the shared cache contains a worktree mapping for that git root, the extension refreshes the PR by URL. This is the most reliable path for worktrees created by `/pr-worktree`.

If no mapping exists, the extension falls back to `gh pr view` from the current worktree and lets GitHub CLI infer the PR associated with the current branch.

If no PR is found, the PR status line is cleared.

## Cache model

The cache lives under `~/.cache/pi-pr-status/` by default and can be overridden with `PI_PR_STATUS_CACHE_DIR`.

The cache stores:

- PR status entries keyed by PR URL or repository branch
- worktree-root mappings produced by `/pr-worktree`

Status entries expire after 5 minutes. A short per-key lock file prevents multiple concurrently open pi sessions from running the same `gh pr view` refresh at the same time. Whole-file cache writes also take a cache-wide lock so unrelated status and worktree mapping updates are merged instead of racing last-writer-wins.

Cache state is surfaced intentionally:

- an unexpired found entry renders as a normal PR status line
- a refresh blocked by another session renders as `PR status refresh in progress…`, or keeps the cached PR line with a `refreshing: using cached status` prefix
- a refresh error with a previous found entry keeps the previous PR visible with a `stale: refresh failed (...)` prefix
- a refresh error without a previous found entry renders `PR status error: ...`
- a cache write failure renders a cache warning/error rather than silently claiming success

## Worktree creation model

`/pr-worktree <github-pr-url>` parses the PR URL, finds a local base checkout for that repository, and creates a sibling worktree named `<repo>-pr-<number>`.

The command prefers the current checkout when it matches the PR repository. Otherwise it checks common local locations, including `~/BriteCore/<repo>`.

The worktree is created by fetching GitHub's pull request ref from the base checkout remote and checking it out on a local `pr-<number>` branch.

If the target sibling path already exists, the extension validates that it is a checkout for the requested repository, is on the expected `pr-<number>` branch, and has `HEAD` matching a freshly fetched `pull/<number>/head`. If any check fails, `/pr-worktree` reports a collision and does not write a worktree mapping.

## PR status line model

The PR status line renders as a `belowEditor` widget so it appears above pi's built-in model/thinking footer. The widget right-aligns itself to the current terminal width.

The status line favors concrete fields:

- PR state or draft marker
- whether review is currently requested
- check summary
- full PR URL

The extension deliberately does not display a separate PR number because the full PR URL already contains it. It also deliberately does not display GitHub's `reviewDecision` field because its values are not obvious enough for the first build.

On narrow terminals, truncation tries to preserve the trailing PR URL first so command-click remains available when possible.
