# @zsaplan/pi-slack

Pi extension for reading/researching Slack with `SLACK_USER_TOKEN` and writing Slack messages with `SLACK_BOT_TOKEN`.

## Configuration

Set these environment variables before starting pi:

```bash
# Used by read/list/research/auth tools.
export SLACK_USER_TOKEN=xoxp-...

# Used by Slack write tools such as slack_post_message.
export SLACK_BOT_TOKEN=xoxb-...
```

Optional write-safety overrides:

```bash
# Skip interactive send confirmation. Defaults to false.
export PI_SLACK_SKIP_SEND_CONFIRM=1

# Permit non-interactive message sends when tool input also has confirm=true.
# Defaults to false.
export PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1
```

## Recommended Slack token scopes

Add only the scopes each token needs:

- `SLACK_USER_TOKEN` for reads: `channels:read`, `channels:history`, `users:read`; add `groups:read`/`groups:history`, `im:read`/`im:history`, and `mpim:read`/`mpim:history` only when private channels, DMs, or group DMs should be readable/listable
- `SLACK_BOT_TOKEN` for writes: `chat:write`; add read scopes such as `channels:read`, `channels:history`, `im:read`, or `im:history` only when bot-token reads or `#name` resolution are needed

The user token must be able to access conversations before pi can read them. The bot token must be able to access target conversations before pi can write them.

## Tools

- `slack_auth_test` — validate `SLACK_USER_TOKEN` or `SLACK_BOT_TOKEN` and show workspace/token identity.
- `slack_resolve_channel` — resolve an exact name/ID using membership-first lookup, bounded visible fallback, and a revalidated short-lived cache.
- `slack_list_conversations` — list conversations visible to the selected user or bot token; `membership=member` uses Slack `users.conversations` for conversations the identity belongs to.
- `slack_read_messages` — read recent messages, including structured blocks, using the selected token; `formatMode=verbatim` keeps readable line breaks, while `blocks` exposes source JSON.
- `slack_read_thread` — read thread replies with the same compact/verbatim/blocks modes.
- `slack_read_permalink` — parse a Slack archives permalink and read thread context, falling back to nearby history on `invalid_arguments`.
- `slack_post_message` — post text, native Markdown, or a static block layout using `SLACK_BOT_TOKEN`. Only ordinary text can use `longTextMode=split`.
- `slack_update_message` — replace a message by URL or channel/timestamp. Supply a complete rich layout, or explicitly opt into clearing it with `clearBlocks=true`; otherwise text edits inspect the existing message using `SLACK_USER_TOKEN`.
- `slack_delete_message` — delete one or more Slack messages by URL or channel/timestamp using `SLACK_BOT_TOKEN`.
- `slack_research_messages` — scan bounded recent channel history for a topic with general filters for token kind, channels/source, time bounds, threads, and permalinks.
- `slack_create_canvas` — create a titled native-Markdown Canvas; optional channel placement adds a channel tab with write access.
- `slack_edit_canvas` — append/prepend, replace the entire Canvas, or rename it (one operation per call; no revision guard).
- `slack_read_canvas` — read bounded pages of readable blocks (or original HTML), with exact IDs, heading context, and a full-document revision hash.
- `slack_find_canvas_sections` — find exact section IDs with readable previews and heading context.
- `slack_edit_canvas_section` — re-check the revision and edit one block; return change summary/timestamp without appending a visible note by default.
- `slack_delete_canvas_section` — preview and delete one exact block with fresh revision checks and separate approval; no batch or whole-Canvas deletion.
- `slack_set_canvas_access` — set read/write access for explicitly selected regular channels or users; no ownership transfer.
- `slack_upload_file` — upload one local file or inline text, optionally syntax-formatted as a snippet, privately or to a channel/thread.
- `slack_get_file_info` — retrieve allowlisted file/Canvas metadata and available permalinks using the bot token.

## Command

```text
/slack-bot
/slack-bot test
```

Shows user/bot token configuration status or runs `auth.test` with `SLACK_USER_TOKEN`.

## Per-session approvals

Interactive replies, uploads, and verified message edits offer **Approve once**, **Approve thread for this session**, or **Cancel**. A thread grant covers new replies, file/snippet uploads, and edits to the bot's messages in that exact thread—including its root—without another approval dialog. Concurrent tool calls queue their approval checks, so the first thread grant can cover the next waiting call.

The scope is the current Pi session ID, verified Slack workspace/bot identity, API base URL, channel ID, and parent thread timestamp. Identity is verified with `auth.test` and cached for the current runtime/token. If identity verification fails, the tool falls back to approval-once rather than granting a bypass.

- Grants survive `/reload`, compaction, tree navigation, and resuming the **same saved Pi session**. They do not carry into `/new`, another session, `/fork`, or `/clone`.
- Grants and revocations are stored as Pi custom session entries—not global settings. Tokens/token fingerprints are never persisted. Revocations remain effective when navigating an earlier conversation branch.
- Thread grants do **not** cover new top-level posts, channel broadcasts (including edits to broadcast replies), message deletes, private or other-destination uploads, Canvas content changes, or Canvas access changes. Those still require their own approval.
- Edit coverage applies to existing v1/v2 thread grants after `/reload`; no new grant or global bypass is needed. The tool reads the exact target with `SLACK_USER_TOKEN` and derives its parent from Slack. A supplied `threadTs` is a lookup hint, not authority: a mismatch is rejected. If membership cannot be verified, an explicit rich/clear-layout edit needs approval-once; ordinary text's layout guard still fails closed. Verified split continuations stay in that same thread. A grant never authorizes editing another author's messages; Slack's ownership rules still apply.
- Conversational pre-approval alone does not create a stored grant. Select the thread option once, or explicitly pre-approve via the command below.
- Non-interactive mode still requires both `PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1` and `confirm=true`; stored interactive grants do not authorize unattended execution. The existing explicit `PI_SLACK_SKIP_SEND_CONFIRM=1` global bypass is unchanged.

Canvas append/prepend/rename and guarded section edits offer **Approve once**, **Approve Canvas content for this session**, or **Cancel**. This separate grant covers one exact Canvas with the same workspace/bot/API/session boundaries, including targeted-edit revision notes. It does **not** cover whole-document replacement, creation, deletion, or sharing/access changes. Targeted edits still check the revision even when a grant removes the prompt. Legacy append/prepend/rename remain unguarded; prefer targeted edits for reconciliation. Existing v1 thread grants remain readable after upgrading to the v2 combined grant format.

Commands (interactive UI required):

```text
/slack-approvals                          # inspect grants; select one to revoke
/slack-approvals clear                    # confirm revoking all session grants
/slack-approvals allow <parent-permalink> # confirm pre-approval without posting
/slack-approvals allow-canvas <ID-or-link> # confirm content approval without editing
```

Use the parent thread permalink, or a permalink with the correct `thread_ts` query parameter. Pre-approval does not send a message. Normal Slack permissions and membership checks still apply.

## Writing voice

Message posts, edits, and upload comments share drafting instructions in `src/writing-guidelines.ts`: adapt to the audience, lead with the outcome or request, use plain language and light Slack formatting, and make follow-ups about what changed. Routine updates should usually fit in a short paragraph or a lead plus a few bullets. Requested reports/plans and important qualifications take priority over brevity.

The [publishing skill](skills/slack-publish-report/SKILL.md) includes the writing workflow and [fictional message examples](skills/slack-publish-report/references/message-examples.md) for mixed audiences, operators, requests, follow-ups, and release handoffs. Formatting-only edits preserve the strength and scope of claims, not just numbers. A brief source/message/fallback check verifies count-to-environment/checkpoint relationships, uncertainty, ownership, and permission. Inspect the final assembled body after scripted changes and the actual body on readback—not just fallback previews or block types—and remove redundant wording without weakening qualifications. It is available for ordinary messages as well as Canvas reports.

This is prompt guidance, not automatic rewriting or a hard word limit. There is no extra model call, and existing posting permissions and verbatim-text requests are unchanged. Run `/reload` in an existing Pi session to load updated tool instructions and skill metadata.

## Long reports and formatting

Slack write tools preflight message length, code-fence balance, and code-block size before calling Slack. Messages over the safe limit are rejected by default so the agent can shorten them before causing Slack-side `msg_too_long` failures or accidental auto-splitting. If a multi-part message is acceptable, pass `longTextMode=split`; the extension splits on line/code-block boundaries, labels parts, closes/reopens code fences across chunks, and returns every posted timestamp.

### Rich message layouts

The existing post/update tools accept optional `markdown` or `blocks` (mutually exclusive). Required `text` is the ordinary message when neither is supplied; with a rich layout it is the accessible fallback and must contain all essential facts, caveats, and links—not just a title. Write agent-authored fallbacks separately in plain language, without pipe tables or code fences, rather than mechanically stripping Markdown. No new OAuth scopes or interactivity service are needed. Writes still use `chat:write` on the bot token, and approvals are unchanged.

- `markdown`: standard Markdown sent as a native Slack Markdown block, including headings, tables, dividers, and links. Slack performs the translation; there is no local Markdown renderer.
- `blocks`: a static subset for dashboards: header, section text/metric fields, divider, context, and table. Table cells accept `raw_text` (`text`) or `raw_number` (both numeric `value` and display `text`); Markdown handles more elaborate table formatting. No interactive elements or arbitrary block passthrough.
- Limits: up to 12,000 Markdown/content characters, 50 static blocks, and 10,000 characters across table cells. Static block JSON is capped at 50,000 characters. Individual block limits also apply. The fallback must be nonblank and at most 4,000 characters, and is still subject to `maxChars` (default 3,500). Slack validates translated Markdown and may reject a layout beyond its own limits.
- Rich messages cannot use `longTextMode=split` or `mrkdwn=false`. Approval shows the fallback and full rich source, not just a short summary. Rich edits replace the complete layout; there is no atomic stale-edit check. Verified edits in an approved thread reuse its session grant, but layout checks still apply.
- Text-only updates inspect the exact target with the configured user read token. Existing blocks cause a refusal unless `clearBlocks=true` explicitly permits replacing the top-level layout with text. Supply `threadTs` when needed to locate a reply. Missing access or an unavailable target fails closed; tokens never switch automatically. Legacy attachments are retained and are not edited by this tool.
- Read/thread/permalink tools and research include table cells, metric fields, rich-text lists, and attachment content. `formatMode=verbatim` is a readable projection with line breaks, **not** lossless replacement Markdown. `formatMode=blocks` exposes source JSON subject to normal output limits. Unsupported read content is marked rather than silently treated as complete. Returned blocks may exceed the limited authoring schema.
- API readback is not proof of desktop/mobile rendering or screen-reader usability. For layout acceptance, spot-check one already-authorized routine update, dashboard, and report on desktop/mobile for hierarchy, wrapping, labels, and caveat placement. Record results or explicitly pending checks in the existing plan/runbook; this does not authorize new test posts. On uncertain writes, inspect the known message before retrying.

See the [fictional rich-format examples](skills/slack-publish-report/references/message-examples.md#investigation-summary-native-markdown) for payloads and layout choices. Upload comments remain ordinary Slack mrkdwn.

Repeat the local registered-tool/HTTP workflow checks from the repository root:

```bash
node --test slack/test/message-layout.test.ts
```

The test uses a local Slack-shaped server and fixture tokens, never live Slack. Its repeatable evidence is written to `slack/tmp/message-layout-e2e/report.json`, including checks, approval previews, and request payloads. Slack's Markdown translation and visual appearance remain separate live acceptance checks.

## Canvas reports, files, and snippets

The bot token needs `canvases:write` for Canvas mutations, `files:write` for uploads, and `files:read` for metadata/permalinks. Regular-channel checks and `#name` resolution also require the appropriate conversation read scopes (`channels:read`, and `groups:read` for private channels). Slack workspace/plan restrictions and channel membership still apply. Section lookup with previews requires `canvases:read` and `files:read`. Current-content reads use `files:read` on the bot token; the user token is not used or required.

Use the bundled `slack-publish-report` skill for human-readable report publishing. It is discovered by the extension, including when loaded directly from `slack/src`.

The default Canvas is a concise **current-state, findings-only report for decision makers**: Summary, Key findings and impact, Important unknowns, and References/appendix. Recommendations appear only when explicitly requested. Avoid the phrase “bottom line.” Technical discussion belongs in focused thread replies; keep long queries and investigative chronology in linked evidence or requested appendices rather than repeating them in updates. Material uncertainty stays prominent. Ongoing updates revise existing findings rather than accumulating follow-up chapters; preserve human contributions. Visible revision notes are opt-in. Thread announcements cover new evidence, changed conclusions, or material uncertainty—not editing steps, routine verification, or tool limitations. Keep operational status in the Pi session unless explicitly requested in Slack; editorial-only updates need no announcement.

- Canvas content is native Markdown, not Slack message mrkdwn. Tables, headings, and caveats remain in the document.
- Creating with `channel` adds a channel tab with **write access**. Omit it when that is not intended. No announcement is posted automatically.
- Link sharing and access changes are separate operations. Slack requires sharing with the target before changing its access; individual-user access requires direct sharing, not just membership in a shared channel. DM/MPDM channel IDs are not accepted for Canvas placement/access.
- Whole-Canvas `replace` overwrites human edits. Prefer guarded targeted edits for reconciliation, or `append` for a genuinely new entry. Replacement requires separate approval even with a Canvas session grant.
- Upload input is exactly one of `path` or `content`; inline content requires `filename`. Paths resolve relative to the session cwd and support `~/` and a leading `@`. Files are snapshotted before confirmation so the approved bytes are the uploaded bytes.
- Uploads without `channel` are private. `threadTs` requires a channel and must identify the parent message, not a reply. `initialComment` also requires a channel.
- Set `snippetType` to a Slack syntax identifier (e.g. `sql`, `python`, `text`). A `.md` snippet is source text, **not** a rendered Canvas.
- Upload limit: 20 MiB by default; set `PI_SLACK_MAX_UPLOAD_BYTES` to an integer from 1 through 104857600 (100 MiB). Empty files, non-regular files, and oversized files are rejected.
- Uploads use `files.getUploadURLExternal` → unauthenticated byte upload → `files.completeUploadExternal`. The retired `files.upload` API is not used. Signed upload URLs and private download URLs are not returned.
- Network operations have a two-minute deadline and accept cancellation. No mutation is retried automatically. On failure, inspect the reported stage and known ID before retrying: a lost response can mean the write succeeded. Upload completion can only be called once.
- Upload completion may precede file processing/sharing metadata. Results say `channel_share_requested`, not that another reader already has access. Sharing lists in metadata are capped at 50 entries each with `sharingTruncated` when applicable.
- Creation/upload results return IDs; use `slack_get_file_info` for a permalink if one was not returned. Metadata lookup failure is not a reason to recreate the artifact. Successful metadata retrieval does not prove another user has access.

All new writes retain the interactive approval/non-interactive opt-in policy; file uploads may reuse an exact session thread grant, and supported Canvas content edits may reuse a separate exact Canvas grant. They always use `SLACK_BOT_TOKEN`; metadata lookup also uses the bot token to see its newly created artifacts. Ownership transfer, file/whole-Canvas deletion, bulk uploads, and interactive Block Kit elements are deliberately excluded.

### Iterative Canvas polishing

Use `slack_read_canvas` → `slack_find_canvas_sections` → `slack_edit_canvas_section` → read back, retaining the same Canvas ID/link. The tools read the live authenticated HTML export rather than assuming previously generated Markdown is still current.

- Reads default to readable blocks with exact IDs, heading paths, links, and table coordinates. Pages contain up to 50 blocks with a ~30 KB block-data budget. Follow `hasMore` / `nextBlockOffset` using `blockOffset` and `expectedRevision`. `isPartial` identifies a document slice; `contentTruncated`, `textTruncated`, and `linksTruncated` identify clipped previews. Previews are not replacement Markdown.
- Use `format: "html"` for original export HTML (12,000 characters per page), optionally with `sectionId` to inspect the complete exact block. Follow `hasMore` / `nextOffset` with `expectedRevision`. Legacy calls supplying `offset` or `limit` implicitly select HTML mode. Exports over 4 MiB are refused. The full-document hash always includes the entire export and title, even for section reads; it is not a server revision number. Private export URLs/tokens are not returned, redirects are refused, and the download host/path is restricted to Slack and the requested Canvas.
- Lookup adds previews, heading paths, table coordinates, and a revision hash. Pass `expectedRevision` to reject a stale snapshot. Results default to 20 matches, capped at 50/~30 KB; narrow the query when `truncated`. `foundInSnapshot: false` can indicate a concurrent edit. A heading section is just the heading, not its entire chapter. Paragraphs, list items, and table cells can have their own IDs.
- Targeted edits require `expectedRevision`, `sectionId`, `operation` (`replace`, `insert_before`, `insert_after`), `markdown`, and `changeSummary`. After confirmation the tool reads again, checks the hash and target presence, applies one edit, and returns the change summary and timestamp in tool results. `appendRevisionNote` defaults to false; only set it when a visible change log is explicitly requested. Re-read before every subsequent edit.
- Content edits made through this extension process are serialized per Canvas. **Slack offers no documented atomic conditional-version write**, so a human/other agent can still edit between the final check and write. This is best-effort stale-read protection, not a guarantee against all concurrent overwrites.
- When opted in, the edit and revision note are separate writes. Partial failures report whether the edit succeeded; repair only the missing note after inspecting the document. No automatic retries occur.
- Preserve human contributions when reconciling findings. Do not blindly regenerate the whole document from old source or lossily convert exported HTML to replacement Markdown. The legacy `slack_edit_canvas` remains available for explicit append/rename/full-replacement operations and does not require a revision hash.

### Guarded section deletion

`slack_delete_canvas_section` requires `canvasId`, one exact `sectionId`, `expectedRevision`, and `changeSummary`. It reads the current export, previews the complete target HTML and contained section IDs, asks for separate approval, then re-reads/checks the revision under the per-Canvas write queue. Canvas content grants do not authorize deletion. Existing explicit global/non-interactive overrides are unchanged.

The complete HTML preview is limited to 4,000 UTF-8 bytes and 20 affected IDs; larger targets, ambiguous IDs, and unsupported blocks are rejected rather than clipped. A container includes descendants; a heading does not include its following chapter. Select smaller blocks when needed and read/approve again for each deletion. Existing revision notes are not removed automatically.

[Slack documents only one operation per edit call](https://docs.slack.dev/reference/methods/canvases.edit), so this first version deliberately has no batch or multi-block transaction. No whole-document replacement is used to simulate deletion. It retains best-effort, not atomic, concurrency protection. Results distinguish `section_deleted` (target IDs absent on read-back), `deletion_uncertain`, and `deletion_acknowledged_unverified`. Uncertain/unverified outcomes are tool errors with structured details; inspect before retrying. No further deletion or automatic retry occurs.

To exercise a targeted update on the existing synthetic Canvas created by the publishing smoke test:

```bash
PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1 \
SLACK_SMOKE_CANVAS_ID=F0123456789 \
node slack/scripts/smoke-canvas-update.ts
```

This requires the original synthetic test paragraph to remain unchanged. It updates that paragraph, adds a revision note, verifies the unrelated table/caveat survive, and verifies a stale repeat is rejected. It creates no new Canvas and stops rather than guessing if the fixture differs.

### Opt-in live smoke test

The script creates clearly labeled **TEST** artifacts: a Canvas, a private text file, a threaded SQL snippet, and a threaded PNG. It edits only the Canvas it creates, posts the Canvas link in the selected thread, and sets read access for the selected channel. It does not delete anything or modify pre-existing content. Save the output IDs for inspection/cleanup.

From the repository root, after explicitly authorizing writes to the destination:

```bash
PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1 \
SLACK_SMOKE_CHANNEL=C0123456789 \
SLACK_SMOKE_THREAD_TS=1234567890.123456 \
node slack/scripts/smoke-publishing.ts
```

The script requires the non-interactive opt-in even if the global skip-confirm setting is enabled. It runs once, stops on errors, and does not retry. If it stopped after Canvas edits but before uploads, `SLACK_SMOKE_CANVAS_ID=F...` reuses that test Canvas without re-editing it; additionally set `SLACK_SMOKE_CANVAS_ANNOUNCED=1` if its announcement already succeeded. Do not rerun the script after an upload failure: inspect the known file IDs and resume only the remaining operations explicitly. Check desktop/mobile rendering and access as another intended reader manually after the API test.

## Channel names and IDs

Use `slack_resolve_channel` before asking a human for an ID:

```json
{"name":"#mcp-testing","tokenKind":"user"}
```

Names are trimmed, normalized, and matched exactly—not by substring. Active public channels are the default. Set `includePrivate: true` for private channels (with appropriate read scopes), or `includeArchived: true` when archived channels are intended. Tokens never switch automatically. A user-token match does not prove the bot can read/post there.

Lookup tries `users.conversations` first, then `conversations.list`. The default budget is six listing pages total and 60 seconds; explicit `maxPages` accepts 2–20. Pages request 200 items, although Slack may return fewer after filtering. Repeated cursors/pages stop the operation. Results distinguish `found`, scoped `not_found`, `incomplete`, `rate_limited` (with `retryAfterSeconds` when provided), `missing_scope`, and `unavailable`. No automatic retry or unbounded scan occurs. Do not repeatedly restart searches or increase budgets automatically.

Successful mappings are cached in memory for five minutes, bounded to 200 entries and isolated by API/token identity and lookup options. Cache hits always revalidate current name, ID, and flags via `conversations.info`, so renames/archive changes do not silently return stale destinations. No cache or tokens are persisted. ID inputs also use metadata validation; existing message tools retain direct-ID passthrough and Slack's normal authorization checks.

The shared name resolver now uses this bounded lookup instead of checking only the first 1,000 conversations. For private-channel names, use the dedicated tool with `includePrivate: true`, then supply its ID to other tools. General listing requests use full 200-item pages even for a one-result name filter, normalize leading `#`, deduplicate IDs, and stop after 20 pages or repeated pagination rather than looping indefinitely.

Both listing methods now use form encoding. A live probe demonstrated that JSON requests ignored page-size/archive filters, returning archived channels despite `exclude_archived: true`; form-encoded requests honored those parameters. Tests verify the cursor and filters are transmitted in form bodies.

## Common patterns

Check today’s mentions for the user and bot without adding a one-off tool:

1. Run `slack_auth_test` with `tokenKind=user` and `tokenKind=bot` to get Slack user IDs.
2. Run `slack_research_messages` with a query such as `<@USER_ID> <@BOT_USER_ID> BotName`, `oldest=<today as ISO>`, `channelSource=member`, `channelTypes=public_channel`, and `includeThreadReplies=true`.
3. If bot DMs must be checked, use `tokenKind=bot` and grant the bot token the relevant read scopes first.

## Local development

From the repo root:

```bash
npm run verify --workspace slack
```
