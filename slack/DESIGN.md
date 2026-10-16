# @zsaplan/pi-slack Design

## Purpose

`@zsaplan/pi-slack` gives pi explicit Slack capabilities without teaching the model to hand-roll Slack Web API calls.

The extension registers bounded tools for:

- validating the configured Slack user or bot token
- listing conversations visible to the selected token or conversations the selected token identity belongs to
- reading recent channel messages, thread replies, and Slack archives permalinks with the selected read token
- posting, updating, and deleting messages with a human confirmation gate when UI is available
- preflighting long Slack text, code-fence balance, and code-block size before writes
- safely splitting accepted long writes into labeled chunks that preserve code fences and return every timestamp
- researching a topic by scanning recent accessible channel history with general filters for token kind, time bounds, channel source, thread replies, and permalinks

## Runtime model

The extension reads Slack tokens at tool execution time, not at module load time. This keeps reloads and shell-level token changes simple.

Read/list/research/auth tools default to `SLACK_USER_TOKEN` and can opt into `SLACK_BOT_TOKEN` with a `tokenKind=bot` parameter when the bot token has the required read scopes. Write tools such as `slack_post_message`, `slack_update_message`, and `slack_delete_message` use `SLACK_BOT_TOKEN` for Slack chat methods and must not fall back to `SLACK_USER_TOKEN`.

Tokens are never returned in tool output or details.

## Slack API scope assumptions

The extension uses Slack Web API methods with the selected token and normal Slack visibility rules. It can only read conversations that Slack allows the selected read token to access and can only write conversations that Slack allows `SLACK_BOT_TOKEN` to access.

Recommended scopes depend on desired coverage:

- `SLACK_USER_TOKEN`: `auth.test`, `users.conversations`, `conversations.list`, `conversations.history`, `conversations.replies`, `chat.getPermalink`, `channels:read`, `channels:history`; add `groups:*`, `im:*`, and `mpim:*` read/history scopes only when those conversation types should be readable/listable
- `SLACK_BOT_TOKEN`: `chat.postMessage`, `chat.update`, `chat.delete` / `chat:write`; add conversation read scopes if bot-token read tools should work or write tools should resolve `#names` instead of receiving channel IDs

This package intentionally does not use Slack's `search.messages` endpoint. Research is implemented by bounded scans over accessible conversation history. The research tool stays general-purpose: mention checks are performed by querying Slack mention syntax like `<@USER_ID>` rather than by adding a narrow mention-only tool.

## Safety boundaries

Slack writes are external side effects. `approvals.ts` provides the shared gate. Writes require interactive confirmation unless `PI_SLACK_SKIP_SEND_CONFIRM=1` is set, a new reply/upload targets an explicitly approved thread in this Pi session, or an eligible content edit targets an independently approved Canvas. Message edits/deletes, broadcasts, and Canvas mutations cannot use thread grants.

In non-interactive modes, writes are blocked by default. Set `PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1` and pass `confirm: true` to allow non-interactive writes.

Write tools reject text over the safe per-message limit by default before calling Slack. Callers may opt into `longTextMode=split` when multi-part posts or update continuations are acceptable. Splitting is line/code-fence aware: chunks are labeled, open code fences are closed and reopened across chunks, and tool output includes every affected timestamp. Slack success warnings such as truncation warnings are surfaced in tool output and details.

## Message writing guidance

`writing-guidelines.ts` supplies one shared set of `promptGuidelines` to `slack_post_message`, `slack_update_message`, and `slack_upload_file` for agent-authored messages and upload comments. Pi deduplicates identical guidelines across active tools. The publishing skill covers audience, purpose, brevity, factual preservation, and fictional examples; its description includes ordinary message drafting so the examples are discoverable outside Canvas workflows.

This is instruction-only. No payload transformation, additional model, required audience parameter, or new send gate is introduced. Existing approval rules, verbatim requests, and evidence bytes are unchanged. Routine updates favor a short lead and a few bullets, but requested reports/plans and material qualifications take precedence. Canvas documents retain their separate Markdown and report structure.

Validation (2026-10-16): all five polish categories approved the voice-only diff against baseline `45c025f`. Slack lint, typecheck, and all 107 tests passed again from installed trunk at `a99aa9b`. The integrated root verification reached its 300-second command limit during the unchanged task-assistant suite; its separate completion passed (93 tests, one intentional skip), as did `verify:live-config`. Earlier integration blockers were an expired private npm registry token and a missing generated task-assistant build; public locked dependencies and the package build resolved them without changing unrelated source.

Live acceptance in the [authorized test thread](https://britecore.slack.com/archives/C01F7L63F9P/p1792167642567769):

- [x] A fresh Pi process loaded the installed trunk Slack package without warnings and generated four fictional drafts. Generation had no Slack credentials; posting remained a separate authorized operation.
- [x] The mixed-audience and engineering messages preserve the same counts and open incident. The engineering version adds the duplicate-submission safeguard.
- [x] The follow-up reports new acceptance without repeating the investigation. The request invents no reviewer, deadline, or approval.
- [x] Four labeled test replies (24–58 words) were posted without broadcast and read back with exact text matches, including line breaks and bullets. No existing messages were edited or deleted.
- [ ] Have the user judge readability and desktop/mobile rendering; API readback and package checks do not establish reader preference or visual quality.

Installed package: `/Users/zach/zsaplan/pi-extensions/slack`. Existing sessions need `/reload` to switch their source path; the posting implementation in the test session was byte-identical to installed trunk. Repeatable local evidence in that checkout: `slack/tmp/voice-live-20261016/` contains `draft-request.md`, `drafts.json`, `readback.txt`, `report.json`, and `verify.log` (gitignored). `report.json` records each message timestamp and the limits of the checks.

## Rich message layouts

Add optional `markdown` or static `blocks` to existing post/update tools. Required `text` remains the ordinary message or the accessible fallback containing all essential information. Markdown is translated by Slack, not a local parser. Static blocks cover headers, sections/metric fields, dividers, context, and simple tables; interactive elements are out of scope. Upload comments remain mrkdwn.

Rich messages are single-part, bounded, and fully represented in approval previews. They do not change grants, channel access, or OAuth scopes. Text-only edits inspect the existing message using the configured user read token and refuse to flatten blocks unless `clearBlocks: true` explicitly authorizes it. Rich replacements supply a complete new layout. This is not an atomic concurrency guard. Numeric table cells require both `value` and display `text` per Slack's [RawNumberElement contract](https://docs.slack.dev/tools/node-slack-sdk/reference/types/interfaces/RawNumberElement/); limits and read projections use display text. Reads and research include structured content; `formatMode: "blocks"` exposes source for inspection, not a promise of lossless round-tripping through the limited writing schema.

Failure cases to verify through the registered tools and HTTP transport:

- [x] Ordinary text posting, splitting, and thread routing still work.
- [x] Markdown and dashboard layouts reach Slack with the intended fallback and no extra posts.
- [x] Approval previews include the actual rich content; cancellation and missing approval prevent writes.
- [x] Invalid/conflicting layouts, unsupported interactive blocks, excessive sizes, and rich splitting fail before writes.
- [x] Text-only updates cannot silently remove blocks; an explicit clear is allowed. Missing read access or an unavailable target fails closed.
- [x] Read/thread/permalink and research find table cells, metric fields, rich-text lists/links, and attachment content even when fallback text is only a summary.
- [x] Unsupported read content is marked, and exact source is available subject to normal output limits.
- [x] Package and repository verification pass; all five review categories approve.
- [x] Installed trunk loads the new schemas in a fresh Pi process.
- [x] After the user reported `/reload`, authorized live API tests created two fictional replies, updated one, and verified that text-only flattening was blocked without changing the dashboard.
- [ ] Desktop/mobile appearance and human readability still require visual assessment; API acceptance and source readback do not establish those.

Automated evidence (2026-10-16): `npm run verify --workspace slack` passed all 108 tests, including the registered-tool/local-HTTP workflow. Final root `npm run verify` passed all workspaces and live-config checks (task-assistant retains one intentional skip). All five polish categories approved against pre-change local `main` (`ca0dec1`), including a second pass after checking Slack's numeric-cell contract. Gitignored evidence in the feature checkout: `slack/tmp/message-layout-e2e/report.json` (repeatable command, checks, previews, requests) and `slack/tmp/rich-messages-20261016/` (verification logs and review results). Implementation/installation validation made no live Slack writes. Subsequent authorized live acceptance is recorded below; desktop/mobile appearance and human readability remain unchecked.

Installation acceptance: implementation commit `2705401` was fast-forwarded into local `main`, and the existing package setting still resolves to `/Users/zach/zsaplan/pi-extensions/slack`. No dependencies, credentials, scopes, or package settings changed. Installed Slack verification passed all 108 tests. A fresh Pi 0.99.2 SDK process loaded the actual installed configuration without errors/warnings, confirmed the new schemas, and validated both rich example payloads. An isolated bound Slack session confirmed skill discovery; a bare loader alone does not emit `resources_discover`. This check had no Slack credentials and made no model calls or tool executions. Installed evidence: `slack/tmp/rich-messages-20261016/installed-load.json`, `installed-verify.log`, and `check-installed.mjs` (rerun with the trunk checkout as its argument and Slack token variables removed). The user subsequently reported reloading this session; other existing Pi sessions still need `/reload`. Nothing was pushed to GitHub.

Live API acceptance (2026-10-16, installed `edf1a0b`): [Markdown report](https://britecore.slack.com/archives/C01F7L63F9P/p1792174619949659?thread_ts=1792167642.567769&cid=C01F7L63F9P) and [dashboard](https://britecore.slack.com/archives/C01F7L63F9P/p1792174620148699?thread_ts=1792167642.567769&cid=C01F7L63F9P) were posted in the authorized test thread with `replyBroadcast:false`. Slack translated Markdown into native header/rich-text/table/divider blocks and retained dashboard metric fields, numeric display text, values, and column settings. A text-only dashboard edit was refused and its source stayed unchanged. A complete Markdown replacement changed only the fictional acceptance status, retaining counts, the open incident, downstream uncertainty, and retry safeguard. Both essential-content fallbacks survived Slack's URL normalization. No additional reply was created by the update; no earlier messages were edited or deleted. Initial raw comparisons differed only in generated block IDs on four older plain-text messages, not their content.

Live evidence is in installed trunk at `slack/tmp/rich-live-20261016/`: requests, update/guard results, before/after source, readable output, and `report.json` with checks and API-returned permalinks. Observed limitations: Slack added a thread-link preview to each example; the readable projection repeats an unfurl body when Slack supplies it in both attachment text and blocks. These observations do not establish how the two layouts look on desktop/mobile.

## Session-scoped grants

The interactive gate receives a structured `threadScope` only from new non-broadcast replies and file uploads with a channel/parent timestamp. No user/model tool parameter can grant consent. A human selects approval-once or thread-for-session in the UI, or confirms `/slack-approvals allow <parent-permalink>`.

A separate `canvasScope` is supplied only for append/prepend/rename and guarded section edits (including revision notes). The user can approve Canvas-content-for-session or confirm `/slack-approvals allow-canvas <ID-or-permalink>`. Creation, whole-document replacement, sharing/access changes, and deletion are excluded. Grants do not skip revision checks. Only tool implementation code supplies these scopes; model parameters cannot manufacture approval.

Grant keys include Pi session UUID, verified workspace ID, bot user/bot IDs, API base URL, scope kind, and either channel/parent timestamp or exact Canvas ID. `auth.test` binds consent to the configured bot; the runtime caches identity by API base and token digest but never persists tokens/digests. Verification failure falls back to confirmation-once. The selected scope appears in the approval prompt.

Pi custom entries (`slack-approval-v2`) persist grant/revoke/clear events. Legacy `slack-thread-approval-v1` events remain readable; legacy clear applies to thread grants only, while v2 clear revokes both kinds. The gate rebuilds active grants from all current-session entries, not just the current branch. Thus reload/compaction/resume preserve consent, and tree navigation cannot resurrect revoked grants. Events also carry their originating session UUID, so inherited fork/clone entries never apply to a different session. The command can inspect, selectively revoke, or revoke all session grants. Concurrent approval decisions are serialized to prevent duplicate dialogs from parallel tool calls.

Non-interactive runs never consume interactive grants; the existing environment flag plus explicit per-call confirmation remain required. The explicit global skip flag still bypasses all approvals as before. Existing conversational approvals are not automatically parsed into extension state.

## Canvas and file publishing

`publishing.ts` owns native Canvas payloads, metadata allowlisting, upload validation/snapshots, and the external-upload flow. `publishing-tools.ts` registers publishing tools and delegates iterative Canvas tools to `canvas-tools.ts`, injecting the existing bot-client factory, confirmation gate, and truncated result formatter from `index.ts`. No new credential storage or Slack SDK is introduced.

- Canvas create/edit/access mutations use `canvases:write`. Metadata uses the bot token and `files:read`. Uploads use `files:write`. Conversation read scopes are needed for name resolution and regular-channel validation.
- Canvas Markdown is passed unchanged. Each edit API call is exactly one operation; whole-document replacement is explicitly destructive. Whole-Canvas deletion and ownership transfer are excluded. Section deletion uses the separate guarded tool.
- Channel-tab placement grants write access and is not interchangeable with publishing a read-only link. Share/access changes remain explicit, separate tool calls. DM/MPDM IDs are rejected for Canvas placement/access.
- Uploads read at most the configured size plus one byte into a snapshot before confirmation. Paths must resolve to regular files. The confirmed snapshot is uploaded even if the local path later changes.
- Upload URL allocation, raw byte upload, and completion are distinct stages. Only authenticated API calls use the token. Byte uploads are restricted to HTTPS `files.slack.com`, reject redirects, and never include Authorization. Signed URLs never appear in results/errors.
- Publishing writes are not retried. Errors name the last stage and known artifact ID where available. Uncertain completion is not treated as a safe reason to create another artifact. Completion must return the allocated file ID.
- `conversations.list`, `users.conversations`, `files.info`, `conversations.info`, and `files.getUploadURLExternal` use form encoding. Live testing found JSON bodies rejected by the metadata endpoints despite general JSON API support; mutation payloads with nested objects remain JSON.
- Network operations are abortable and have two-minute deadlines. Metadata returns an allowlist without file content/download URLs; sharing arrays are capped at 50 entries each, with an explicit truncation indicator.
- Upload completion can precede file processing/sharing metadata. Results describe the requested destination and surface Slack warnings, rather than claiming another reader already has access.
- The publishing skill is contributed through `resources_discover`, so direct `slack/src` installs also discover it. Package tarballs include the skill and opt-in live smoke script.

## Iterative Canvas updates

`canvas.ts` owns authenticated content reads, revision hashes, section lookup, per-Canvas in-process write serialization, and targeted updates. `canvas-tools.ts` exposes read/find/edit tools with the existing shared confirmation gate.

- `files.info` supplies the Canvas export URL. `readCanvas` validates the Canvas MIME/ID, HTTPS host and requested-file path before attaching the bot token. Redirects are refused. HTML is bounded to 4 MiB while streaming, and the observed Canvas wrapper is required to reject login/error pages. URLs/tokens are never included in diagnostics/results.
- Live testing confirmed the HTML export includes Slack section IDs and preserves table/paragraph content. `canvas-view.ts` uses parse5 only for read-only presentation: readable text, IDs, heading paths, links, and table coordinates. It deduplicates Slack's repeated list-item IDs and retains source offsets for exact raw section reads. It never serializes parsed HTML back into a mutation.
- Default reads paginate whole blocks (up to 50/~30 KB). Previews flag clipped text/links; raw HTML remains available in 12,000-character pages, optionally restricted to a section. Legacy offset/limit calls remain HTML reads. `hasMore` is distinct from `isPartial`. Every mode retains the SHA-256 digest of the full original export and title, checked via `expectedRevision` on subsequent reads.
- `canvases.sections.lookup` supplies matching IDs (`canvases:read`); the tool also reads current content (`files:read`) to enrich matches with previews/context. It caps output by count/bytes and advises narrowing truncated queries. IDs absent from the content snapshot are explicitly flagged. A heading is one block, not a subtree/chapter; previews cannot safely serve as replacement Markdown.
- A targeted edit requires the read digest and a present section ID. The tool re-reads after confirmation, rejects stale content, writes the single block, and returns a change summary/timestamp. Only explicit `appendRevisionNote: true` adds a visible timestamped note in a second API call. Partial failures explicitly distinguish successful edits from uncertain/failed revision notes.
- There is no documented Slack conditional-version edit field. Hash preflight and serialization prevent many stale/local parallel edits but do not provide distributed locking or eliminate the check/write race against other clients. Agents must not promise lossless concurrent collaboration.
- The legacy whole-document tool shares the local write queue but is still unguarded by a digest for backward compatibility. Skill/tool guidance directs ongoing polishing to the guarded section tool.

## Guarded section deletion and editorial status

`canvas-delete.ts` implements one section deletion per tool call, matching Slack's documented one-operation-per-edit constraint. Before approval it validates the full-document digest and constructs a complete bounded HTML preview with descendant IDs. After separate approval (never a Canvas session grant), it acquires the shared Canvas queue and repeats the read/validation before issuing one `delete` operation. It never sends replacement Markdown or deletes the Canvas itself. Oversized previews and ambiguous targets fail closed.

Read-back verifies target IDs are absent. Mutation failure is conservatively uncertain; acknowledged mutation plus failed verification is explicitly unverified. Both return structured error results and never trigger another deletion/retry. There is no atomic conditional-version API or batch transaction, so external races remain possible.

Skill and tool prompts distinguish substantive investigation findings from editing status. Routine formatting, verification, and tool-limit messages stay in Pi unless explicitly requested in Slack. No automatic summarizer or outbound-message classifier is added.

## Channel resolution

`channel-resolution.ts` provides exact-name/ID lookup with membership-first and bounded visible fallback. It shares the guarded `conversationPages` iterator with existing listing helpers. Page size is independent of the requested match count: 200 items per request. Default lookup budgets are six listing pages and 60 seconds; ordinary listing helpers default to 20 pages. Repeated nonempty page signatures or cursors fail closed as incomplete. Empty filtered pages with advancing cursors remain valid.

Active public channels are the default; private/archived inclusion is explicit. Results distinguish incomplete and rate-limited scans from a completed scoped absence. Missing scopes do not cause token switches. Existing name-based actions delegate to this resolver rather than using a silent 1,000-conversation cutoff; callers can explicitly resolve private names and pass the resulting ID.

The in-memory positive cache is limited to 200 entries, has a five-minute TTL, and is keyed by a nonpersisted API/token digest plus name/options. Every hit uses `conversations.info` to revalidate name, flags, and visibility. No negative results, secrets, or cache state are persisted; lookup success is not write authorization.

Live probes showed JSON listing requests ignored page-size/archive filters. Both listing endpoints now use form encoding, with regression tests for limits, filters, and cursor transport. Automatic rate-limit retries are intentionally excluded.

## Output limits

Tools bound Slack pagination and cap rendered output. Final text is also truncated with pi's standard output truncation utility so large Slack responses do not overwhelm model context.

## Non-goals

- full Slack administration
- OAuth installation flows
- Slack search API integration
- bulk uploads, file/whole-Canvas deletion, or ownership transfer
- atomic cross-client edit locking, automatic conflict merges, or lossless HTML-to-Markdown conversion
- automatic session publishing, interactive Block Kit elements, and arbitrary layout passthrough
- long-running full-workspace archival
