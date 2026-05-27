# @zsaplan/pi-pr-worktree-status

Pi extension for PR-focused sessions. It keeps the current worktree's GitHub pull request visible above pi's model/thinking footer without involving the LLM.

## Behavior

- Detects the PR associated with the current git worktree.
- Displays a compact, right-aligned PR status line above the model/thinking footer when a PR is found.
- Refreshes from the local `gh` CLI every 5 minutes.
- Uses a shared cache under `~/.cache/pi-pr-status/` so multiple pi sessions do not all hit `gh` at once.
- Provides `/pr-refresh` to force-refresh the current worktree's PR status.
- Provides `/pr-worktree <github-pr-url>` to create a sibling PR worktree named `<repo>-pr-<number>`.

The PR status line intentionally includes the full PR URL so terminal command-click can open it directly:

```text
open · review requested · checks pending 1/12 · https://github.com/org/repo/pull/1234
```

If no PR is associated with the current worktree, the extension clears its PR status line.

## Error and cache states

The status line favors explicit state over silence:

- Fresh or valid cached PR: shows the normal PR line.
- Refresh in progress in another pi session: shows `PR status refresh in progress…`, or `refreshing: using cached status · ...` when a cached PR is available.
- `gh` error with a previous good PR: keeps the PR visible but prefixes it with `stale: refresh failed (...) · ...`.
- `gh` error without a previous good PR: shows `PR status error: ...`.
- Cache write failure: shows a cache warning/error instead of pretending the cache updated.

`/pr-refresh` also reports the same state through an info, warning, or error notification.

## Commands

### `/pr-refresh`

Force-refresh the current worktree's PR status using `gh pr view`.

### `/pr-worktree <github-pr-url>`

Create a sibling worktree for a GitHub PR URL. For example:

```text
/pr-worktree https://github.com/IntuitiveWebSolutions/platform/pull/1234
```

Given a base checkout such as:

```text
/Users/zach/BriteCore/platform
```

this creates:

```text
/Users/zach/BriteCore/platform-pr-1234
```

The command records the worktree-to-PR relationship in the shared cache, so sessions opened from the new worktree can refresh by PR URL instead of relying only on branch inference. If the target sibling path already exists, it is only reused after verifying that it is the matching repository, expected `pr-<number>` branch, and current PR ref; otherwise the command reports a collision instead of caching a misleading mapping.

## Requirements

- `git`
- GitHub CLI `gh` authenticated for the target repository
- a local checkout of the repository for `/pr-worktree`

## Notes

`/pr-worktree` creates the worktree but cannot change the running pi process's working directory. Start a new pi session from the created worktree to use it.
