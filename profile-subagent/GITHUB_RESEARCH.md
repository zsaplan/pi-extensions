# Experimental GitHub researcher — default-off

One bounded repository question, supported findings and explicit gaps. No code-review mandate, shell, writes, arbitrary URLs, attachments, external-system access or recursive delegation. Repository text cannot grant permissions.

The normal extension entry point, catalog, original profiles and checked pilot remain unchanged. This module does not integrate or restart the Slack task assistant.

## Interactive Pi opt-in

Explicitly add this file to the `extensions` array in your agent settings, using the absolute path to your checkout:

```text
/path/to/pi-extensions/profile-subagent/src/github-interactive.ts
```

Run `/reload` after installing dependencies and building the package. The ordinary package entry remains default-off. This separate entry registers `github_research_run` through Pi's normal tool pipeline; it only admits calls in TUI mode, not SDK, print, JSON or RPC workers. It does not start or change the Slack service.

Each outer tool call is one new interactive assignment: the actual Pi session and call ID determine its reservation, with a fresh 90-second deadline (75 seconds child work plus 15 seconds handoff). It is not an extension of a background-worker deadline. Existing factory admission, cancellation, parent hooks and accounting remain in force. Replay memory is bounded and lasts only until runtime reload/restart; this entry is not a durable task scheduler.

Credentials come from `GH_TOKEN`, then `GITHUB_TOKEN`, then the fixed local command `gh auth token --hostname github.com`. No shell or model-supplied command is used. Output stays in memory, command errors are withheld, and lookup honors cancellation and a five-second timeout. No credentials are copied into configuration. Codex uses the existing agent-directory `auth.json`; use `/login openai-codex` if necessary. Missing GitHub credentials produce unavailable source observations, not evidence that a repository is absent; check `gh auth status` or the environment. Installing the entry does not validate credentials against live services.

The entry selects the reviewed Luna/high native transport and keeps private run artifacts under `<agent-dir>/profile-subagent-runs`. Original post-hook evidence is authoritative; child prose is not independently verified. Use the researcher for substantive source questions, not small local checks or duplicate parent investigations.

Interactive acceptance:
- [x] Local real-Pi registration/reload, session binding, credential precedence/fallback/failure, parent denial/redaction, cancellation, private artifacts and usage checks: eleven scripted scenarios, including codemode and compiled-entry loading, passed with SDK TUI mode (no terminal rendering). Package verification passed all 258 tests on Node 26.10.0 / child SDK 0.99.2. These use local HTTP/WebSocket/model fixtures, not live research.
- [ ] Installed resource discovery after updating the checkout and settings.
- [ ] User `/reload` in the running interactive session.
- [ ] Separately authorized live token-mode research; local fixtures do not establish live credential validity or model efficiency.

## Host-owned opt-in

Build with `npm run build --workspace profile-subagent` or pack with `npm pack ./profile-subagent` (prepack builds). Import `registerGithubResearch` from `@zsaplan/pi-profile-subagent/github-research`; the read adapter is exported from `@zsaplan/pi-profile-subagent/github-read`.

The trusted host must supply:
- `token(): Promise<string>`: GitHub credentials in memory, never model arguments.
- `getBinding(ctx, callId)`: a binding for the exact admitted outer call, or undefined.
- For the reviewed native candidate, `standardPilot: {artifactRoot, authPath?}`: a private artifact root and optional Codex OAuth store path. This selects Luna/high, requested default tier, WebSocket-only, no Fast mode or hidden retry/fallback. Native transport is qualified only with the child SDK's pi-ai **0.99.2** and fails closed on another version. Node **26.10.0** was tested. The base factory without this option retains the existing Sol/medium runner; it does not provide the native transport guarantees.

A binding contains `taskId, sessionId, threadKey, reservationId, deadlineAt`. Use the existing absolute worker deadline (at most 120 seconds ahead), not a fresh deadline per tool call.

**The GitHub token is the only repository-access policy.** No mode flag or repository, file-path, history or discussion allowlist is required. The host still approves the research task. `RepositoryGrant`, `RepositoryAccess` and their validators have been removed; `createGithubReader(transport)` takes only a token supplier and optional trusted fetch implementation. Bindings that still contain the old `repositories` field are rejected before inference or HTTP—not silently broadened. Update the host deliberately to the new API before using it.

Supported navigation:
- `repositories`: a focused GitHub repository-search `query` (for example `platform org:example`), with optional page 1–2 and at most five results per page. Search visibility/indexing and token permissions can limit results; an empty result is not proof of absence.
- `resolve`: `repository` and optional branch/tag/commit `ref`; omission resolves the default branch. Use the returned immutable SHA in subsequent reads. File/list/search/history may also use any explicit SHA. Omitting a commit pins that repository's default branch on its first such read for the assignment.
- Root list/search/history uses path `"."`. Other paths are repository-relative. History accepts optional `since`/`until` UTC timestamps (for example `2026-08-01T00:00:00Z`) as research filters, not permission boundaries. Existing sensitive-file, symlink, credential and HTTP safeguards still apply.

The profile directs the researcher to start with supplied sources, discover only when needed, follow another repository only for a concrete question-related lead, and stop once each part has a supported answer or clear evidence gap. These are instructions, not a guarantee of efficient model behavior. The existing operational budgets remain enforced across all repositories in the assignment. No recursive crawler, organization inventory or extra worker is added.

Load through the actual Pi extension pipeline. Both `github_research_run` and the codemode-only `github_research_read` must be callable; only the former needs to be exposed to the parent model. Nested-call lineage and parent permission/result hooks are required. Do not copy tool executors into another host without those hooks.

The host owns question approval, the GitHub token, durable replay prevention, worker/budget reservations, permission/redaction hooks, once-only accounting and delivery. The factory only remembers reservations in memory (up to 1,000); restart does not preserve that memory. It is not a sandbox or a durable scheduler. Native standard-pilot transport permits one active run per loaded module; base factory capacity is two, with one per session and no queue.

## Bounds and evidence

Child: at most 75 seconds, ten turns, sixteen adapter calls and fifty HTTP attempts, with fifteen seconds reserved from the inherited deadline for handoff. HTTP is GET-only, fixed GitHub REST routes, redirect refusal, five-second request timeout, 128 KiB per response and 768 KiB cumulative. In-flight chunks can overshoot a byte threshold; it is not a hard network-byte cap.

Files are regular UTF-8 blobs, at most 32 KiB, hash/size verified, returned in at most forty-line windows with 300-character line clipping. Sensitive-path screening is conservative, not a general secret detector. Search is shallow/literal over bounded files. History is at most two ten-entry pages; rename following is not automatic. Discussion collections are bounded; bodies clip at 1,200 characters. Read discussion with only operation/repository/kind/number/page, never path/commit.

Identical failed HTTP requests are memoized within an assignment with original attempt/time provenance, not silently retried. Mutable successful responses are not cached. Failure and absence are distinct.

The report remains `verification: "unverified-report"`. `sourceEvidence` contains bounded post-hook observations (49,152 bytes for observation records, plus bounded metadata), integrity status, omissions, tool failures and clipped-observation IDs. A modified observation is not restored from raw source. Citations and intact delivery do not independently verify claims.

Inspect `github-result.json` as the final wrapper handoff; the base runner's `result.json` alone is insufficient. Persistence failure, cancellation or truncated report fails the handoff. Private artifacts must remain outside published packages and source-control evidence.

## Accounting and operational limits

The native candidate records request/terminal/close metadata without credentials or raw provider frames. It persists `connection-attempt` before constructing a socket; that record does not prove an established connection. It reconciles token/cost totals and waits for owned socket close events within the original deadline. Cleanup failure prevents successful completion; unresolved sockets poison native admission until process restart. Cancellation is cooperative, not remote settlement proof.

A $0.25 known SDK child-cost threshold stops further requests; it is **not** an invoice cap. Preserve partial usage and mark unknown totals unknown. Count the enclosing child tool usage once, not again from its nested details. Requested tier, returned tier, delivered service and invoices are different; routing and billing are not independently certified. Parent preparation/review effort and whole-workflow savings remain unmeasured.

Configuration, commit dates, snapshot names and PR assertions are not proof that a restore succeeded or that a system is compliant. Report missing execution/provenance/validation records without accessing another system.

## Verification and merge acceptance

Run from the repository root:
```bash
npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
npm run verify --workspace profile-subagent
npm run verify
```

Existing local Git/HTTP and SDK tests cover scope, history/rename, pagination, redaction, failed-request reuse, cancellation, artifact failure, capacity and unchanged default discovery. Packed-package tests must exercise the compiled exports and native candidate, not a copied transport implementation.

- [x] Clean package import/default-off and native protocol E2E: nine packed-module scenarios plus the existing adapter/capacity/default-discovery checks.
- [x] One bounded read-only live smoke through the packed module before the cleanup fix (revision `3be8054`; no new live run after remediation): two public repository files at a pinned commit, two native responses, ten successful GETs, 16.93 seconds host time and $0.0009037 SDK child estimate. Original observations support the reported model, tool permissions and limits. Native close was normal and usage reconciled. The host was scripted; this is not a savings or reliability estimate. Child prose omitted the README clipping caveat; the host packet explicitly preserved it. Parents must inspect that packet.
- [x] Full repository verification after remediation, including 243 profile tests; one unrelated optional task-assistant test skipped.
- [x] `connection-audit-failure` packed E2E: injected write failure opens no socket, completes cleanup and permits a new assignment in the same process.
- [x] `close-deadline` packed E2E: unresolved close fails by the inherited deadline; a separate assignment in the same process is refused without another socket, inference frame or GitHub request. These fault cases use local fixtures, not live services.
- [ ] Final material code review before merge.
- [ ] Separate host integration, installation and wider live acceptance if requested later.

## Token-access acceptance

- [x] Packed E2Es: all fourteen local SDK/WebSocket scenarios passed, covering multi-repository discovery/resolution/reads/history/discussions, immutable citations, denied access, empty repositories, sensitive/unsafe paths, parent hooks and rejection of obsolete access options before inference/HTTP.
- [x] Review fixes: overlapping first reads share one default-branch resolution; failure provenance and cancellation remain covered. Valid `.github`, underscore and hyphen names work in discovery and direct reads; dot-segment, encoded and backslash names remain refused. Duplicate hook tests were consolidated without losing cross-repository denial/redaction checks.
- [x] Full repository verification after the review fixes: 246 profile tests passed; one unrelated optional task-assistant test skipped. An earlier run failed in an unchanged task-assistant fixture with a null child exit; the full rerun and final verification passed. Its cause was not investigated.
- [ ] Broader-access live behavior and interactive Pi activation, if separately requested. Scripted fixtures do not qualify the model's ability to follow efficiency guidance; historical grant-scoped live runs do not establish token-mode acceptance.

Historical prototype studies are preserved privately in their original worktrees, not published with this package. Prior successes are not blanket repository grants or broad reliability evidence.
