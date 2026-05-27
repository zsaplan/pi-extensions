# PR Worktree Status Design

## Purpose

`pr-worktree-status` is a Pi extension for sessions dedicated to GitHub PR review. It keeps the PR associated with the current worktree visible in the footer and offers a direct command for creating PR worktrees from PR URLs.

The extension is intentionally deterministic and command-driven. It does not ask the LLM to inspect PR state, create worktrees, or refresh status.

## Scope

In scope:

- current-worktree PR detection
- footer status through `ctx.ui.setStatus`
- shared 5-minute cache backed by local files
- direct `gh` CLI polling
- `/pr-refresh`
- `/pr-worktree <url>` using the `<repo>-pr-<number>` sibling-directory convention

Out of scope for the first build:

- global review-request inboxes
- always-visible widgets
- PR opening commands
- interpreting opaque GitHub review-decision fields
- changing the current pi process working directory after creating a worktree

## Detection model

The extension first resolves the git root, branch, and GitHub remote for `ctx.cwd`.

If the shared cache contains a worktree mapping for that git root, the extension refreshes the PR by URL. This is the most reliable path for worktrees created by `/pr-worktree`.

If no mapping exists, the extension falls back to `gh pr view` from the current worktree and lets GitHub CLI infer the PR associated with the current branch.

If no PR is found, the footer status is cleared.

## Cache model

The cache lives under `~/.cache/pi-pr-status/` by default and can be overridden with `PI_PR_STATUS_CACHE_DIR`.

The cache stores:

- PR status entries keyed by PR URL or repository branch
- worktree-root mappings produced by `/pr-worktree`

Status entries expire after 5 minutes. A short per-key lock file prevents multiple concurrently open pi sessions from running the same `gh pr view` refresh at the same time.

## Worktree creation model

`/pr-worktree <github-pr-url>` parses the PR URL, finds a local base checkout for that repository, and creates a sibling worktree named `<repo>-pr-<number>`.

The command prefers the current checkout when it matches the PR repository. Otherwise it checks common local locations, including `~/BriteCore/<repo>`.

The worktree is created by fetching GitHub's pull request ref from the base checkout remote and checking it out on a local `pr-<number>` branch.

## Footer model

The footer status favors concrete fields:

- PR number
- PR state or draft marker
- whether review is currently requested
- check summary
- full PR URL

The extension deliberately does not display GitHub's `reviewDecision` field because its values are not obvious enough for the first build.
