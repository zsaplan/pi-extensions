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

## Failed-interactive-use follow-up — local remediation only

The bundled Pi host and a separately imported native provider module can have different WebSocket caches even at the same version. Closing only the imported cache leaves the source-extension socket open. Cleanup now calls Pi's mapped session-resource registry for the exact research session ID as well as the pinned native helper used by compiled hosts. It still waits for actual close events, retains the original deadline, and blocks later native admission if sockets remain. Both the mapped coding-agent SDK and the pinned native pi-ai must be 0.99.2. No model, transport protocol, tier, limit or retry policy changed.

A close-deadline failure is retained in transport evidence and the base result. The wrapper preserves that primary error and reports separate `handoffIssues` for cancellation, work-deadline expiry, truncation or profile revalidation. A work-deadline flag raised while waiting for cleanup does not establish that inference itself timed out.

Every adapter observation now reports remaining adapter calls and HTTP attempts separately. The parent should supply known path/ref leads and label unverified leads. The specialist should jump directly to useful deep paths, avoid repeated shallow root searches, reserve calls for decisive file windows, and stop after a budget refusal. These are navigation instructions, not proof of live model efficiency. Limits remain sixteen adapter calls and fifty HTTP attempts. A cleanly completed invocation with a useful partial report is still partial research.

- [x] Local bundled-source and compiled-host regression checks: completed native responses, actual socket closure, private evidence and reconciled usage. The old bundled-source behavior was reproduced before the fix: no close request, a live socket at the 90-second handoff deadline, and a masked outer error.
- [x] Separate adapter-budget exhaustion and supplied-path fixtures. The former refuses calls 17–19 without hitting fifty HTTP attempts or reading decisive files; the latter uses two supplied file paths. Scripted path-seeded success is not blind discovery qualification.
- [x] Native work-deadline, cancellation, delayed/abnormal close, close-deadline and denied-readmission checks, including matching base/outer close-deadline causes. Package verification passed 264 tests on Node 26.10.0.
- [ ] Separately authorized publication/installation and current interactive acceptance of this remediation.
- [ ] Separately bounded live qualification: execution/cleanup and useful research answer are different acceptance checks. No new live run or higher budget is authorized by these fixtures.

## Source references and immutable reuse

Citation-bearing observations now return assignment-local `sourceId` values. The researcher cites `[[S...]]`; the wrapper renders the exact observed URL and whole observed window, without asking the model to copy a SHA. Only intact, retained **post-hook** evidence enters the reference map. Modified, credential-redacted or omitted observations cannot be recovered from raw receipts. A source ID identifies an observation, not an endorsement of its contents; mutable discussion and repository-search results remain mutable.

`referenceValidation.status` is `valid`, `invalid` or `unreferenced`. It checks explicit source markers and URL targets, not the truth of claims, bare prose mentions, or completeness of the research. Unobserved URLs, unknown IDs and invented ranges produce explicit issues, not guessed corrections. An invalid report returns a warning in place of the rendered prose; the original remains private in `result.json`. The final `github-result.json` includes these issues and authoritative post-hook observations. Execution/cleanup status and `verification: "unverified-report"` stay separate. Parent review is still required.

Observations containing an immutable commit also return a `revisionHandle`. File/list/search/history accept that value as `revision` **instead of** `commit`. The assignment resolves it before the normal parent permission hooks, so those hooks see the actual repository and SHA. Unknown, previous-assignment, wrong-repository and conflicting handles are refused without HTTP. Handles do not grant access; direct reader users still supply explicit SHAs or use default-head pinning.

Within an assignment, overlapping root/tree/blob work shares one producer. Verified blobs can serve later windows or searches, including another regular path with the same blob SHA. Path, type and size checks still run; every admitted logical read consumes its allowance, passes parent hooks again and receives a fresh bounded observation. Cached data is redacted again before clipping. No final tool response is cached. A later permission denial or redaction is not bypassed.

Successful mutable requests remain fresh. Immutable cache payloads are capped at the existing 768 KiB budget scale (serialized retained payload, not total JavaScript heap); additional values are used without retention. `github.immutableReuse` reports cache hits, shared loads and retention size/skips. File/search observations report `reuse.blob` and the original `reuse.verifiedAt`; `observedAt` is the logical observation time, not a fresh fetch claim. Physical requests and response bytes are charged once. Cancelled waiters detach; producer cancellation/failure is shared without a replacement fetch. Existing failed-GET provenance remains available. All caches and handles end with the assignment.

Local acceptance for this increment:
- [x] Focused package and full repository verification: 291 profile tests pass; full root verification passes with one existing optional task-assistant skip. Node 26.10.0 / child SDK 0.99.2; no live model or GitHub calls.
- [x] Repeatable before/after comparison against identical fixture Git objects and logical read sequences. Four direct-adapter integration cases separately check cancelled waiters/producers, retention capacity and forbidden cached paths; real-Pi source/compiled hosts check reference handling and hooks.
- [ ] Publication, installation/reload and separately authorized live acceptance. Local implementation approval does not authorize these actions.

The fixtures cover source/revision corruption, omitted/modified evidence, cache-hit hooks, immutable sharing and failures, cancellation ownership, retention and HTTP bounds, history/introduction/rename, settings-to-consumer tracing, conflicting documentation and inaccessible evidence. Additional scripted cases include supplied paths and no supplied paths. They test mechanisms, **not** autonomous discovery or model judgment.

To compare two successful offline snapshots, retain the first `tmp/github-research/latest.json` before changing the reader, run the suite again, then use:

```bash
node profile-subagent/test/compare-github-reuse.mjs BEFORE.json AFTER.json NEW_COMPARISON.json
```

Use a private, git-ignored output path. The comparison checks identical fixture commits and actions, records requests/bytes and returned handoff size, and refuses to overwrite an existing result. It does not estimate live latency, model cost or parent review effort.

Measured offline results (before → after):

| Scripted read sequence | HTTP requests | Response bytes |
| --- | ---: | ---: |
| Introduction/edit/rename | 20 → 19 | 6,472 → 6,327 |
| Overlapping default-head reads | 7 → 4 | 2,449 → 1,581 |
| Repeated file windows | 8 → 6 | 2,111 → 1,769 |
| Nine five-file scans, shared blob | 49 → 5 | 7,370 → 2,046 |
| Two distinct supplied paths | 6 → 6 | 2,551 → 2,551 |

Mutable-success and repeated-failure controls remain at two and one HTTP requests respectively. Adapter calls, scripted model requests and retained observation counts are unchanged in all seven comparisons. The repeated-scan handoff grows from 23,466 to 35,640 bytes, including reference/reuse metadata and a changed scripted citation format. This is not evidence of reduced parent context or whole-workflow savings; live judgment and correction effort remain unmeasured.

## Operation-specific child tools and recorded activity

The child sees seven narrow tools instead of one multi-operation union schema:

| Child tool | Input focus |
| --- | --- |
| `github_file` | File `path`; optional `start` and `limit` **1–40** (default 30) |
| `github_search_directory` | `directory` and literal `term`; at most five direct files |
| `github_list_directory` | `directory`; root is `"."` |
| `github_history` | `path`, optional page and UTC date filters |
| `github_repositories` | Focused repository query |
| `github_resolve` | Repository and optional ref |
| `github_discussion` | Repository, kind, number and optional page |

Each tool has only its own fields, so schema errors concern the requested operation. Directory arguments are translated to the existing adapter's `path`; operation names are supplied by code, not the model. All seven interfaces dispatch through the **same** `github_research_read` parent pipeline. That adapter and the exported direct-reader API retain their existing union contract. No permissions, model/transport settings, budgets, retries or default discovery behavior change. `tools` in child results now lists these actual model-visible names; the profile's authorized parent dependency remains the single adapter.

The final wrapper attaches `activitySummary`, generated from child tool-result events and **retained intact post-hook** observations. It counts returned/failed child tool results (including schema rejections), groups them by tool, and reports retained/omitted/unknown evidence plus observed operations and coverage flags. Failure counts remain accurate when individual failure details exceed their existing 20-entry cap. Unknown tool names share one bounded `other` bucket. No raw argument, error text or discarded evidence is recovered for the summary.

Child failure counts and adapter outcomes overlap; do not add them. Coverage counts are per observation, not unique files or a merged inventory. A successful shallow search can still contain inaccessible files. Partial windows, pagination, clipped content, omitted records and modified observations remain limitations. No summary declares that the research question is complete or that a citation supports a claim. Original model prose is preserved; parents should use host counts instead of any model-written totals.

Local failure cases verified on Node 26.10.0 / SDK 0.99.2:
- [x] Three oversized reads and two searches aimed at files: focused errors, five failures counted despite deliberately inaccurate model prose, then valid follow-up reads/searches.
- [x] Missing/wrong fields, invalid limit types/ranges (including fractions before SDK coercion), maximum 40-line and short final windows; no parent dispatch or HTTP for schema failures.
- [x] More than 20 failed tool results: 25 counted, 20 details retained, five details omitted and no HTTP.
- [x] Parent denial/redaction, omitted evidence, partial searches/windows and pagination: no recovered content or false coverage; counts reconcile with original messages.
- [x] Existing source, compiled/native, bundled/interactive, cancellation/accounting, capacity and default-off checks; 295 package tests and full repository verification pass, with one existing optional task-assistant skip.
- [ ] Installation/reload and separately authorized live acceptance. Offline fixtures do not establish improved model decisions, smaller context or whole-workflow savings.

Private local evidence: `tmp/tool-contract/verified-kQSBOg/VERIFICATION.md`, linked to the original source, packed and interactive fixture outputs. Reproduce with the package/root verification commands below. The first root run was interrupted by a 300-second command timeout while the unrelated task-assistant suite was still passing; a fresh full run completed with exit 0. Original failed/interrupted logs remain preserved.

## Retention before child delivery

Source results pass the normal parent permission/result hooks, then a synchronous retention check before delivery to the child. The 49,152-byte record cap is unchanged. Accepted records are never evicted. Concurrent completions share the same check/commit, rather than each receiving a separate allowance.

The exact post-hook content remains in `sourceEvidence.records`. The child view adds host `evidenceRetention` metadata: `retained`, `usableReferences`, `limitBytes`, `usedBytes` and `remainingBytes`. Intact JSON gets this field alongside the source; modified content is preserved with a separate notice and `usableReferences: false`. It is never parsed back into trusted evidence. The final `sourceEvidence.budget` reports the serialized record-array size, including its brackets, escaping and record metadata. Budget snapshots are after each result; parallel results can arrive in a different order.

When a record cannot fit, the child gets an explicit failed gap result instead of the omitted source body, source IDs, newly issued handles or alternate details. A source that would exceed the existing 16 KiB child-content ceiling once its notice is included is also withheld without spending packet capacity. Both cases count as omitted observations and failed child tool results; the underlying adapter/HTTP work remains charged normally. No raw receipt/cache reconstruction, eviction, automatic retry or larger budget is introduced. A deliberately smaller subsequent read still passes the normal hooks and limits and creates a new observation; it does not restore an omitted reference.

This prevents silently presenting packet-omitted sources as usable evidence. It does not force the model to honor a gap, choose useful windows or support each claim. Unknown/modified references still fail final validation, and the full report is still withheld on invalid references. Host notices add child context; whole-workflow savings are not established.

Acceptance for this increment:
- [x] Source E2E: transcript-to-packet reconciliation, parallel completions, smaller follow-up windows, redaction/denial, UTF-8 byte boundaries, exact/full and one-byte-over packets, child-content overflow, and rejection of a guessed omitted ID.
- [x] Packed/native and bundled/interactive SDK E2E, preserving cleanup and once-counted usage.
- [x] Focused package: 303 tests passed. Complete repository verification passed with one existing optional task-assistant skip. Node 26.10.0 / SDK 0.99.2; no live model or GitHub calls.
- [ ] Separate installation/reload and authorized live acceptance. No live run is authorized by this local implementation.

Private verification record: `tmp/evidence-retention/verified-SoLlGH/VERIFICATION.md`. `test/github-retention-check.ts` checks actual child transcripts against retained post-hook records in source, packed and bundled fixtures. Reproduce through the package/root commands below; these are scripted mechanism tests, not model-quality acceptance.

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
- `resolve`: `repository` and optional branch/tag/commit `ref`; omission resolves the default branch. Use the returned `revisionHandle` as `revision`, or the immutable SHA as `commit`, in subsequent reads. File/list/search/history may also use any explicit SHA. Omitting a commit pins that repository's default branch on its first such read for the assignment.
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
