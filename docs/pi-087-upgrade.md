# Pi 0.87.1 upgrade preparation

## Scope and current state

Prepared on 2026-09-22, Node 26.8.1, macOS. Daily Pi is still Homebrew **0.84.4**; Homebrew advertised 0.86.1 while public npm advertised 0.87.1. No core upgrade, Slack/Jira mutation, merge, or source-path switch was performed. Subsequent live CLI acceptance made explicitly requested model calls using OpenAI Codex.

Prepared source: the `pi-extensions-pi-087-upgrade` sibling worktree, branch `prepare/pi-087-upgrade`. The daily settings still point to the original checkout, not this worktree. Land these changes or explicitly select this worktree when cutting over.

## Implemented

- [x] Pin the personal extension repo's Pi AI, coding-agent, and TUI development dependencies to 0.87.1 and update the lockfile. Peer ranges remain `*`, as Pi's package documentation recommends.
- [x] Replace obsolete `createAgentSession({modelRegistry})` calls in polish-solution and Rainman with explicit `ModelRuntime` instances. Carry over the selected provider's native registration and configuration overrides so isolated sessions retain custom providers; do not reach into private registry fields.
- [x] Disable cache warming in those isolated sessions' in-memory settings. They do not inherit global settings.
- [x] Pin the Slack worktree's current-namespace coding-agent development dependency to 0.87.1. Preserve existing work and the legacy namespace dependencies used by its other, older packages; this is not a wholesale migration of that dirty branch.
- [x] Back up global settings, npm manifests, fast-mode configuration, and Slack root manifests under `~/.pi/agent/backups/pre-pi-087/` (private directory).
- [x] Set global `cacheWarming` to `off` for initial cutover.
- [x] Review and install `pi-openai-fast-mode@0.5.0`, pinned in global settings. Its source diff from installed 0.3.0 adds GPT-6 Astra for OpenAI and Codex; no other source changes. It still does not list GPT-6 Sol/Luna. Do not assume `/fast` works for those models.

## Automated evidence

- [x] `npm run verify`: repository lint, workspace typechecks/tests and package checks passed; 144 existing tests, zero failures.
- [x] `npm run verify --workspace slack` in the separate Slack worktree (not part of this PR): lint/typecheck and 107 tests passed, including denied-approval/no-write paths.
- [x] Explicit lint of `scripts/verify-pi-upgrade.mjs` passed.
- [x] Offline SDK end-to-end fixture passed on Pi 0.87.1: 16 real extensions plus one fixture provider loaded; 18 localhost HTTP requests; all five isolated reviewer categories executed `git_status`, `git_diff`, and `submit_review`; parent tool returned approval; in-memory session restoration preserved provider context.
- [x] `git diff --check` passed; daily `pi --version` remains 0.84.4.
- [x] Compared public-registry npm audits: original personal repo lockfile reports 12 advisories (7 high); prepared lockfile reports 10 (5 high, 2 moderate, 3 low). Remaining high-severity package families are brace-expansion, js-yaml, smol-toml, tmp, and undici. The mixed legacy Slack install reports 21 advisories (12 high). Passing tests do not clear these advisories; no broad `npm audit fix --force` was applied.

The end-to-end provider is deterministic and local, not a real model review. It tests SDK wiring, extension-defined provider propagation, tool execution/termination, and history reconstruction. It does **not** certify paid-provider authentication, live service APIs, UI dialogs, browser images, or semantic review quality. Additional locally installed packages were loaded from their configured entrypoints, including existing `dist` bundles, not rebuilt artifacts.

Repeat the portable fixture from this worktree:

```bash
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run verify
npm run verify:upgrade
```

To include additional trusted local extensions, append their paths after the artifact path (replace the example paths with your own):

```bash
npm run verify:upgrade -- tmp/pi-upgrade-smoke.json \
  /path/to/trusted-extension \
  /path/to/another-trusted-extension
```

The private smoke artifact records the exact entrypoints used for the recorded 16-extension run; workstation-specific paths are intentionally not published.

Evidence lives in ignored `tmp/pi-upgrade-smoke.json`, `tmp/pi-upgrade-verify.log`, and `tmp/pi-upgrade-slack-verify.log`. The fixture writes pass/fail evidence and uses a disposable agent directory and git repository. It neither reads personal Pi credentials nor contacts a paid model API; all model requests use its localhost provider. It runs extension factories, so only pass trusted extension paths.

## Live CLI acceptance

Run actual pinned `pi` processes rather than the SDK fixture:

```bash
npm run verify:live            # read, resume, five-category polish review, Rainman
npm run verify:live -- --quick # read + resume only
```

The script uses `node_modules/.bin/pi` (requires 0.87.1), the provider/model from personal Pi settings, and a private temporary copy of only the selected provider's `auth.json` credential. API-key environment variables also remain available. `PI_LIVE_PROVIDER` and `PI_LIVE_MODEL` can select a different built-in provider/model. It does not copy custom `models.json` or provider extensions. The temporary credential copy is removed on ordinary completion, failure, or handled interruption; refreshed credentials are not copied back to personal auth storage.

Each invocation has a 180-second timeout with process-group termination. A full successful run uses four CLI invocations; `--quick` uses two. These are **real subscription/paid model requests**, not cost-capped simulations. Automatic parent retries and cache warming are disabled, but the review/lookup extensions retain their own bounded repair/retry behavior. `PI_OFFLINE=1` suppresses startup/catalog traffic; it does not disable the requested model calls.

Inputs are a synthetic git diff, a random token, and a one-fact KB. Only the specific tool for each stage is enabled; no Slack, Jira, browser, or notification extension is loaded. Test credentials and fixtures live in a disposable directory. Private `tmp/pi-live-*/` directories retain JSONL events, stderr, the synthetic persisted session, and `report.json` on pass or failure. Do not publish raw artifacts without inspecting them. No personal sessions or daily configuration are modified.

The script checks actual tool-completion events, expected tool counts, model identity, error/aborted assistant messages, and `agent_settled`—not merely the exit status (JSON mode can exit zero on a provider failure). Resume is verified in a new process after deleting the token file, with all tools disabled. Review acceptance requires results from all five categories, not a particular model opinion. Rainman must answer with the exact fixture citation.

### Recorded execution — 2026-09-22

Pi **0.87.1**, Node **26.8.1**, **openai-codex/gpt-6-astra**, parent thinking **low**:

| Stage | Result | Duration | Evidence |
| --- | --- | --- | --- |
| File read | Passed | 9.21 s | One actual `read`; exact unpredictable token |
| Resume in new CLI process | Passed | 6.22 s | Recalled token after deleting source file; zero tools |
| Isolated polish review | Passed | 39.90 s | All five categories completed and approved |
| Isolated Rainman lookup | Passed | 15.51 s | Answered with exact `PI__UPGRADE.md:3` citation |

All four stderr files were empty. Total CLI elapsed time: approximately 71 seconds. Artifact directory: `tmp/pi-live-BFrMBx/`; summary: `tmp/pi-live-BFrMBx/report.json`. This validates the prepared child-session migration with real provider authentication and responses. It does not validate UI-only behavior, other models/providers, or live service APIs. Daily `pi --version` remained **0.84.4** afterward.

## Outstanding cutover and live acceptance

- [ ] Triage remaining dependency advisories separately before claiming a security-clean baseline. Personal-repo audit details are retained in `tmp/pi-upgrade-audit.json`; the comparison does not establish exploitability or certify the Homebrew runtime dependency tree.
- [ ] Land or select the prepared source changes before relying on child reviewers after upgrade. Recheck Homebrew's available version; prefer 0.87.1 rather than 0.86.1, which lacks the subsequent context/tool preservation fixes. Avoid installing a competing global npm binary accidentally.
- [ ] Stop active sessions and take a consistent session backup immediately before cutover (currently approximately 1.9 GiB). The preparation backup does not include sessions, and the active conversation is still being written.
- [ ] Preserve a usable 0.84.4 binary and the pre-upgrade session/config backup. Test newer Pi on copies; do not rely on older Pi understanding sessions written with new entry types.
- [x] Invoke the real 0.87.1 CLI with prepared polish/Rainman extensions and verify OpenAI Codex GPT-6 Astra authentication and model identity; see recorded live execution above.
- [x] Run a bounded real polish review and Rainman lookup against synthetic fixtures; five review categories and an exact KB citation passed.
- [ ] Start the full configured extension set in the interactive 0.87.1 UI and confirm no loader or rendering errors.
- [ ] Confirm TLDR generation and `/fast` on GPT-6 Astra in the UI. GPT-6 Sol/Luna fast-mode support remains an upstream package follow-up, not a reason to block Astra use.
- [ ] Verify Slack's interactive approval and denial dialogs without authorizing a live mutation merely for testing.
- [x] Resume a synthetic persisted session in a separate CLI process and verify retained context with tools disabled.
- [ ] Exercise a browser screenshot/image tool result, and resume/branch/compact a copy of a representative existing session. Confirm tools remain callable afterward.
- [ ] Confirm Discord notifications at configured turn/run boundaries, without posting unsolicited test notifications.
- [ ] Keep `/bug` local-only for internal work unless a report has been reviewed and external upload explicitly authorized. Redaction is not proof that business data has been removed.

## Registry and rollback notes

The default npm registry returned E401 during discovery. Public-package preparation used a per-command `--registry=https://registry.npmjs.org` override (or `NPM_CONFIG_REGISTRY` for `pi install`); global npm registry configuration was not changed. This does not repair authentication for a private registry. Renew private-registry credentials through the appropriate local workflow only when private package installation is needed.

Before cutover, global changes can be undone by restoring the backed-up settings and fast-mode configuration, then reinstalling `pi-openai-fast-mode@0.3.0` and restoring the original unpinned declaration if desired. Restoring npm manifests alone does not restore installed package files. Slack's original dirty manifests were backed up separately; do not use `git reset` to discard existing Slack work. No runtime source paths were changed by preparation.

References: [release notes](https://pi.dev/news/releases), [0.87.1 SDK](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/sdk.md), [settings](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/settings.md), [packages](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/packages.md).
