# Experimental GitHub researcher — default-off

One bounded repository question, supported findings and explicit gaps. No code-review mandate, shell, writes, arbitrary URLs, attachments, external-system access or recursive delegation. Repository text cannot grant permissions.

The normal extension entry point, catalog, original profiles and checked pilot remain unchanged. This module does not integrate or restart the Slack task assistant.

## Host-owned opt-in

Build with `npm run build --workspace profile-subagent` or pack with `npm pack ./profile-subagent` (prepack builds). Import `registerGithubResearch` from `@zsaplan/pi-profile-subagent/github-research`; grant types/validation are exported from `@zsaplan/pi-profile-subagent/github-read`.

The trusted host must supply:
- `token(): Promise<string>`: GitHub credentials in memory, never model arguments.
- `getBinding(ctx, callId)`: a binding for the exact admitted outer call, or undefined.
- For the reviewed native candidate, `standardPilot: {artifactRoot, authPath?}`: a private artifact root and optional Codex OAuth store path. This selects Luna/high, requested default tier, WebSocket-only, no Fast mode or hidden retry/fallback. Native transport is qualified only with the child SDK's pi-ai **0.99.2** and fails closed on another version. Node **26.10.0** was tested. The base factory without this option retains the existing Sol/medium runner; it does not provide the native transport guarantees.

A binding contains `taskId, sessionId, threadKey, reservationId, deadlineAt, repositories`. Use the existing absolute worker deadline (at most 120 seconds ahead), not a fresh deadline per tool call.

Set **`repositories: "token"`** to let the researcher's GitHub token determine repository access. No repository, file-path, history or discussion allowlist is required in this mode. The host still approves the research task; the child cannot select or change this access policy. Existing hosts that pass an explicit grant array remain restricted—omitting the field does not enable broader access.

Token access supports these additional operations:
- `repositories`: a focused GitHub repository-search `query` (for example `platform org:example`), with optional page 1–2 and at most five results per page. Search visibility/indexing and token permissions can limit results; an empty result is not proof of absence.
- `resolve`: `repository` and optional branch/tag/commit `ref`; omission resolves the default branch. Use the returned immutable SHA in subsequent reads. File/list/search/history may also use any explicit SHA. Omitting a commit pins that repository's default branch on its first such read for the assignment.
- Root list/search/history uses path `"."`. Other paths are repository-relative. Existing sensitive-file, symlink, credential and HTTP safeguards still apply.

The profile directs the researcher to start with supplied sources, discover only when needed, follow another repository only for a concrete question-related lead, and stop once each part has a supported answer or clear evidence gap. These are instructions, not a guarantee of efficient model behavior. The existing operational budgets remain enforced across all repositories in the assignment. No recursive crawler, organization inventory or extra worker is added.

For narrower access, continue supplying a grant array. A grant contains:
```ts
{
  repository: "owner/repository",
  head: "<immutable lowercase 40-character commit>",
  paths: ["config/example.yml", "sites/"],
  history: true,
  since: "<optional ISO timestamp>",
  until: "<optional ISO timestamp>",
  discussions: [123]
}
```
In explicit-grant mode: one/two repositories, at most four paths each and ten approved discussion numbers. Exact files never imply folder access. History may use explicit directory roots with/without a trailing slash. Pinned heads, observed permitted history and direct parents are supported; supplied lead SHAs alone do not authorize historical reads. Repository discovery and branch/tag resolution are refused in explicit-grant mode.

Load through the actual Pi extension pipeline. Both `github_research_run` and the codemode-only `github_research_read` must be callable; only the former needs to be exposed to the parent model. Nested-call lineage and parent permission/result hooks are required. Do not copy tool executors into another host without those hooks.

The host owns question approval, selection of token-wide versus explicit-grant access, durable replay prevention, worker/budget reservations, permission/redaction hooks, once-only accounting and delivery. The factory only remembers reservations in memory (up to 1,000); restart does not preserve that memory. It is not a sandbox or a durable scheduler. Native standard-pilot transport permits one active run per loaded module; base factory capacity is two, with one per session and no queue.

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

- [x] Packed E2Es: multi-repository discovery/resolution/reads/history/discussions, immutable citations, denied access, empty repositories, sensitive/unsafe paths, parent hooks and unchanged explicit-grant restrictions. All fifteen packed scenarios passed using local SDK/WebSocket/GitHub fixtures.
- [x] Full repository verification after adding token access: 249 profile tests passed; one unrelated optional task-assistant test skipped.
- [ ] Broader-access live behavior and interactive Pi activation, if separately requested. Scripted fixtures do not qualify the model's ability to follow efficiency guidance; historical grant-scoped live runs do not establish token-mode acceptance.

Historical prototype studies are preserved privately in their original worktrees, not published with this package. Prior successes are not blanket repository grants or broad reliability evidence.
