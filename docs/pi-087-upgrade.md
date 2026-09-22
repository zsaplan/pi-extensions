# Pi 0.87.1 verification

## Scope

Pi development dependencies are pinned to 0.87.1. Polish-solution and Rainman create isolated `ModelRuntime` instances, preserve the selected provider's registration/configuration, and disable cache warming in their in-memory settings. Peer dependency ranges remain `*` as recommended by Pi's package documentation.

## Repeatable checks

```bash
npm ci --ignore-scripts
npm run verify               # repository checks plus offline credential/config checks
npm run verify:upgrade       # offline SDK/HTTP fixture
npm run verify:live          # real CLI: read, resume, polish review, Rainman lookup
npm run verify:live -- --quick # real CLI: read and resume only
```

The offline SDK fixture uses a disposable repository and localhost provider, exercises all five reviewer categories, and verifies restored session context. It writes `tmp/pi-upgrade-smoke.json`. Additional trusted extension paths may follow the artifact path; these run extension code and are not a sandbox.

The live harness invokes the pinned `node_modules/.bin/pi` with synthetic inputs and only the tool needed for each stage. It uses defaults from `settings.json` or `PI_LIVE_PROVIDER` and `PI_LIVE_MODEL`; a missing settings file is allowed, but malformed JSON is rejected. Custom `models.json` and provider extensions are not copied. These are real subscription/paid model calls, not cost-capped simulations.

### Credential handling

- API-key providers can use their environment variables or a selected non-OAuth credential in the temporary agent directory.
- OAuth testing is supported for **OpenAI Codex**. The harness runs `pi auth print-bearer-token --min-expiry 20m` against the original credential store, allowing Pi to refresh under its normal store lock and persist rotated credentials there.
- Only the exported access token is written to a private temporary `models.json`. No OAuth refresh token is copied. Other OAuth providers fail explicitly rather than assuming their authentication can be represented by a bearer token alone.
- Each model invocation has a 180-second timeout and process-group termination. A stage cannot start unless the exported token has sufficient guaranteed lifetime for the stage and shutdown grace period.
- Temporary credentials are deleted on ordinary completion, failure, or handled interruption. Export failures omit credential stdout/stderr from reported errors. `PI_OFFLINE=1` disables startup/catalog traffic, not requested model calls or credential refresh.

Private `tmp/pi-live-*/` directories retain JSONL events, stderr, the synthetic persisted session, and `report.json`. Inspect artifacts before sharing them. The harness checks tool-completion events, expected tool counts, model identity, assistant errors, and `agent_settled`; JSON-mode exit status alone is insufficient.

## Evidence

- Repository verification: 144 existing tests passed.
- Credential/config verification: five offline checks passed using synthetic credentials. Actual Pi authentication commands exercise environment-only startup, original-store OAuth refresh, access-only export, rejection of insufficient token lifetime, and redacted export failures; malformed settings are also rejected. The token endpoint is intercepted; no real accounts are used.
- Offline SDK acceptance: five reviewer categories, 18 fixture HTTP requests, and session restoration passed.
- Live CLI acceptance on 2026-09-22: Pi **0.87.1**, **openai-codex/gpt-6-astra**, parent thinking **low**:

| Stage | Result |
| --- | --- |
| Read | Exact generated token returned through one `read` call |
| Resume | New CLI process recalled the token after source-file deletion, with tools disabled |
| Polish | All five isolated reviewer categories completed and approved |
| Rainman | Answered with exact `PI__UPGRADE.md:3` citation |

The live rerun after credential remediation completed in approximately 72 seconds; all four stderr files were empty. Evidence: `tmp/pi-live-2I9iLv/report.json` and adjacent JSONL logs. The offline expiry checks establish refresh behavior; the live run establishes actual provider/tool interoperability. Neither certifies other models, interactive rendering, or external service APIs.

## Outstanding acceptance

- [ ] Triage dependency advisories: the updated lockfile reports 10 advisories, including 5 high, versus 12 / 7 high before the update. Passing tests do not establish exploitability or a security-clean baseline.
- [ ] Verify the complete interactive extension set, TLDR/fast-mode behavior, approval dialogs, and notification boundaries without unsolicited service writes. Fast-mode support for additional models remains a separate package follow-up.
- [ ] Verify browser image results and resume/branch/compaction of a copied representative session; confirm tools remain callable afterward.
- [ ] Before deployment, stop active sessions, back up sessions/configuration, retain the previous executable, select the prepared extension source, and confirm the distribution supplies 0.87.1. Do not assume older Pi understands sessions written with newer entry types.
- [ ] Review diagnostics before any `/bug` upload; redaction alone does not establish that internal data is safe to disclose.

References: [SDK](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/sdk.md), [CLI authentication](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/cli.md#credential-commands), [models](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/models.md), [packages](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/packages.md).
