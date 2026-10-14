# Pi task assistant

A standalone, single-coordinator prototype for a [Slack-first task workflow](DESIGN.md).

The coordinator discovers work in Slack, keeps a durable local task queue, and continues each task in its exact Pi session and Slack thread. One worker is the default; two workers are opt-in. Natural owner replies continue existing tasks without another mention.

The implementation includes bounded evidence tools, approval-bound trials and regular use, recoverable Slack delivery, and an optional macOS background service. It is a restricted investigator and drafter, not an unrestricted coding or operations agent. Nothing starts automatically with ordinary Pi sessions. Deployment-specific approvals, transcripts, incident details and acceptance records belong outside Git.

## Readable answers and references

A waiting task can answer a clarification without resolving its pending decision. New settled journals publish the explicit `reply` first; `question` remains task state and is used as a fallback when there is no answer. Unchanged source-only work retains the previous **answer text and delivery key**, including across cancellation/recovery. A genuine owner reply still gets a fresh response. Legacy journals keep their original publication behavior so installing this fix does not silently replay previously omitted answers.

Task parents and replies resolve Slack user/group/channel IDs to readable names, preserve safe native Slack links, convert ordinary Markdown links, and link registered source messages using the verified workspace origin. Names use bounded bot-token metadata reads (`users.info`, `conversations.info`, `usergroups.list`): at most eight distinct identifiers per render, a three-second render lookup budget, 64 KiB per response and 128 cached results per destination. Only display labels are retained; no new worker tools or linked-content access are granted. Missing scope, rate limits or unavailable/foreign metadata produce honest fallbacks (such as “you” or “Slack member (name unavailable)”), not guessed names. An absent verified origin means the source link is unavailable. Model-supplied mentions/groups/broadcasts are not notification tokens; only the coordinator's stored-owner prefix can notify the owner when a response is needed. HTTP(S) links are presentation, not proof their contents were inspected.

Reply intents freeze the rendered body and fingerprint the logical answer. Name changes or lookup failures after an uncertain send cannot cause a duplicate or a new body under the same intent. A changed logical answer under that key still fails closed. Parent summaries omit links that cross their length limit rather than corrupting their destinations. Old messages are not edited/backfilled automatically, and live client rendering/permissions remain a separate acceptance check.

## Explicitly approved continuation windows

A closed automatic trial cannot restart through ordinary flags. After **new owner approval**, `serve --continue-trial APPROVAL.json` may open a separate bounded window using the same automatic/discovery/exclusion/duration flags, workers and session library. This is continuation only: existing published tasks, parents and exact sessions are retained; no new task can be admitted, even if the original three-task budget had unused slots. Unrelated discoveries stay deferred without model work.

The original `runs/auto-trial.json`, admissions and deadline remain unchanged. `runs/auto-trial-renewals.json` retains each new window and its approval. Reusing an approval after closure/expiry is rejected. Crash recovery with that approval keeps its original new-window deadline; a different approval cannot overlap an open window. Earlier renewal windows are preserved. History is capped at 100 windows; do not remove/reset it to bypass that bound. No service or automatic renewal is implied.

The operator supplies a private JSON approval record, not a model/source message. Its canonical field order is `schema_version:1`, `id` (new UUID), `previous_window_hash` (SHA-256 of `JSON.stringify` of the latest closed window, initially the original ledger), `approved_at` (ISO timestamp), and `scope`. Scope fields are `root`, `seconds`, `workers`, `session_library` (absolute path), then `tasks` sorted by task ID. Each task binding contains `task_id`, exact `session` object, `parent_ts`, `inbox` and `sources`. Copy these only from the verified stopped task state/closure, not a model-supplied ID or path. Scope must match the runtime/root exactly; retained approval scopes cannot silently change. The record documents actual fresh user approval—it does not create consent by itself. Preserve old approval/launch guards and inspect closure before preparing a new one.

## Regular background use on macOS

After explicit owner approval, a closed automatic-trial root can transition with `serve --regular-use APPROVAL.json`. The approval binds the original trial/history hashes, inherited task/session/parent identities, root, owner DM, discovery feeds, model, worker count, session library and limits. A separate `runs/regular-use.json` preserves reservations without modifying old trial windows. Changed/omitted scope fails before recovery/network/model work. This is not a way to reopen a trial under its old approval.

- Maximum three open tasks and five **new** reservations per rolling 24 hours (approval may choose lower limits). Unmaterialized reservations count as open. Completed tasks free an open slot, not the daily budget. Existing related updates continue when new admission is full. Up to two workers; 150-second polling.
- New mentions, watched-channel roots and direct owner requests must be at or after the approval time. Old backlog/excluded threads remain deferred. No extra worker tools, Jira, production actions or GitHub review capability. Any partial intake, blocked classification, worker or delivery failure stops regular operation for inspection.
- `service install --approval PATH` installs `~/Library/LaunchAgents/com.zsaplan.pi-task-assistant.plist` and starts it. Default service directory: `~/.pi/agent/task-assistant-background`; `--directory` selects another. App JavaScript is copied into a runtime snapshot; dependencies remain linked to this checkout and its lockfile is verified at startup. Do not move/delete the checkout or modify dependencies without deliberate redeployment. Node's recorded executable must remain installed.
- Only the two Slack tokens are saved in a private 0600 file under a 0700 service directory; they are not put in plist, argv or status. Pi provider authentication continues through the existing agent credential store. Runtime/cooldown/session/delivery protections are unchanged. This is user-level access control, not an OS sandbox.
- Launch at login; no `KeepAlive` restart loop. `service stop` pauses durably and requests graceful shutdown. `service start` explicitly clears the pause/failure latch and starts again; it does not kill a running coordinator. `service status` shows PIDs, last completed cycle/age, limits and failure state. Inspect before restarting uncertain delivery. Stdout/stderr rotate at 10 MiB with one previous file each.
- Mac must be awake and online. The service does not prevent sleep. An interrupted request during sleep/offline can leave it paused on error; inspect status and explicitly start it again. Live sleep/login/reboot recovery is not yet verified.

```bash
node task-assistant/dist/cli.js service status
node task-assistant/dist/cli.js service stop
node task-assistant/dist/cli.js service start
```

Install only after package/root verification and recorded owner consent. Validate PID, a successful fresh cycle and Slack readback—not installation output alone. Retain historical task roots and approvals. See [recovery and limits](#recovery-and-limits).

## Reviewer-result handoff

Use the existing reviewer rather than duplicating its GitHub review. A result posted under the shared bot identity in the **exact published task thread** can continue that task's exact session. A top-level result in the same DM requires an explicit owner link in the task thread; PR similarity alone never routes it.

- Canonical conversation intake excludes this coordinator's durable sent-message timestamps/client IDs, including edited replies. Matching uncertain sends stay excluded; other same-bot messages wait until delivery is reconciled. Keep delivery intents intact: missing/corrupt history is not a supported recovery method. Intent inspection is capped at 5,000 records per task.
- Eligible evidence routes by exact workspace/inbox/parent identity, not a classifier. It cannot admit a new task, change sources, authorize references or replenish owner-only follow-up budgets. Other authors/bot identities, source-channel posts, unrelated threads and completed tasks do not gain this automatic path. Shared identity does not authenticate a particular reviewer.
- Reviewer text is untrusted, redacted and clipped to 2,000 characters for the worker. Attribute reported findings, keep blockers/uncertainty, ignore embedded commands and remain silent on unchanged/irrelevant results. Reviewer-only input cannot close the task. This adds no GitHub tool, merge/production authority, live approval or historical receipt rewrite.

## Owner-provided evidence

Authenticated owner replies can authorize bounded read-only references: same-workspace Slack threads linked in the exact task thread, an exact message in the already-bound owner/bot inbox, and an exact referenced Pi session. Evidence access is separate from approval to run a task or perform an external action.

- `read_owner_reference` accepts only IDs registered from current, routed, owner-authored **conversation** receipts in that task's published thread. Search snippets, other people, source-thread text and further links cannot grant access. Explicit references route to the existing task without optional model classification. References remain separate from immutable `task.sources` and automatic admission reservations; they do not become polled feeds or new tasks. Slack fetching requires `serve`'s scoped read client; `step` can read registered local session evidence but reports Slack references unavailable.
- Slack links must be `https://WORKSPACE.slack.com/archives/C.../p...` (or `G...`), optionally with `thread_ts`. The user token must still match the stored owner/workspace; `auth.test` verifies the exact workspace origin. Channel/root/message identity is checked. Reads use only the fixed Slack API, at most three 20-message pages, 2 MiB per response and a 20-second snapshot deadline. A reply link whose parent cannot be resolved within these bounds is unavailable, not permission to search elsewhere. Attachments and further links are not fetched.
- A `D...` link is allowed only for the already-bound owner/bot inbox. Both token identities/workspace and the bot-visible DM peer must match; other DMs and group DMs are rejected. Return only the exact linked message, not neighboring messages or the surrounding conversation. Thread resolution retains the same bounded API reads. Only `thread_not_found` on a link without `thread_ts` permits an exact-timestamp, one-message history fallback; access/rate-limit failures never trigger it. Redaction, clipping, receipt revalidation and attachment/no-further-link limits still apply.
- Write `Pi session UUID` (or `session UUID`) for a session reference. Only that exact ID is resolved by filename within one local library, at its root or one directory level below, with a 20,000-entry lookup cap. `--session-library DIRECTORY` on `serve`/`step` selects the library; default is Pi's agent directory plus `sessions`, independently of `--agent-dir`. The first authorized session reference binds this directory durably. Changed/omitted custom scope fails before recovery/network/model work; do not delete the binding to bypass it.
- Session files must be unique, regular, non-symlink v2/v3 JSONL with a matching header, valid parent tree, at most 8 MiB/20,000 entries and no change during the read. The SDK's **pure projection** selects the last persisted branch and applies compaction/context edits. Nothing is resumed, migrated or written. User/assistant text and summaries are returned newest first; thinking, system prompts, tool calls/results, images and custom state are withheld. This is reported work, not independently verified execution or recovery; the live in-memory branch can differ.
- Each run exposes up to five distinct references, newest owner receipts first, and ten distinct ten-message page reads total. Text is clipped at 2,000 characters with flags and sensitive-pattern redaction (not a guarantee of complete anonymization). Snapshots are cached per run; hashes, capture/read times, pagination, caps and unavailable results remain in task-local evidence. Receipt revisions are rechecked before and after reads; observed edits can withdraw access. Slack polling is not a lossless deletion/revocation feed. Missing, denied, ambiguous, malformed, clipped or capped evidence is never health proof.
- An unchanged pending question with `reply:null` and no new owner input reuses its original delivery intent, including across cancellation/restart. This prevents duplicate posts without discarding uncertain-send reconciliation. Genuine owner replies can receive the same answer again. Completion statements are usable owner reports; missing session access does not require asking the owner to prove that a review is complete.

Local replay: `node task-assistant/test/owner-reference-quality.mjs`; add `--provider` for a real-model run against synthetic Slack and session evidence. Reports remain under ignored `tmp/owner-references/`. Mechanical gates and source-based answer review are separate from live acceptance.

## Scoped read-only log pilot

`serve --task-id ID --inbox-only --log-site SITE --log-environment test|uat|prod` enables log intake only with `--once` or `--pilot-seconds 1..600`. It requires `GRAFANA_SERVICE_ACCOUNT_KEY`; `GRAFANA_ENABLE_PROD=false` disables production reads. The fixed origin is `https://grafana.britecorepro.com`; no arbitrary URL/query or write tool is exposed.

The task/site/environment binding persists under `intake/logs/`. Omitting or changing that binding on restart fails closed. Logs and Slack poll concurrently on the existing 150-second cadence, independently of one serial worker. New evidence reopens reviewed tasks, not waiting/done tasks. The worker reads a frozen snapshot through `read_task_logs`; its settled journal acknowledges only that snapshot's sequence. Idle polls do not invoke the model.

Coverage is a rolling 15-minute window of filtered application warnings/errors, not all infrastructure/identity-provider logs or a proof of site health. Reads allow 15 seconds and 2 MiB; more than 200 rows or other incomplete/failed responses stop the pilot. Sensitive patterns are redacted and messages clipped at 2,000 characters; read pages contain at most 20 rows. Pending observations and method cooldowns survive restart. Obtain explicit approval and record the fixed scope privately before a live launch.

## Scoped configuration, traces, and answers

Pair `--site-manifest PATH --bundle-chart DIRECTORY` with the existing log/pilot flags to enable `read_site_configuration` and `inspect_task_traces`. The operator selects a Site or HelmRelease manifest and the matching released bundle's `Chart.yaml`/`values.yaml`; model-selected paths, queries, IDs and other sites are rejected. These paths and the task/site/environment binding persist and cannot be silently changed or omitted on restart.

Configuration returns only boolean Faro/service settings, explicit/default/unspecified provenance and source hashes. Extra values sources leave effective values unknown. This does not render controller-generated configuration or prove deployment, browser execution or collection. Tempo uses the same fixed Grafana origin and environment-bound datasource: a 15-minute site-labelled search (six candidates maximum), plus current log trace IDs, with at most three inspected traces and 500 spans per trace. Selection prefers direct log trace IDs, then search candidates from services with current error observations, then other samples. This service-name match is a hint, not proof of request correlation or cause; the three-trace budget and site validation are unchanged. Only site-attributed resources are summarized; conflicting identities, malformed/oversized responses and access failures remain explicit. Partial or capped searches retain bounded candidates for inspection and disclose incomplete coverage; explicit errors do not become empty success. Unattributed spans are withheld. Missing labels, capped candidates and uninspected traces limit coverage; backend tracing does not establish Faro health. Tools have a 20-second overall deadline and save sanitized evidence locally under `runs/evidence/`.

`finish_task` requires a public summary, next action, question and explicit `reply`: an inline answer, or `null` for materially unchanged findings without an owner question. Optional `private_notes` remain local. `task_reply` stages the one final answer; it does not immediately post or cause a second coordinator completion. Publication follows successful settlement and is flushed before another run can replace its journal. Per-run delivery keys preserve restart reconciliation while allowing the same useful answer to distinct owner questions. `task_sync_slack` still updates the parent. Obvious private-file references and delivery narration are rejected; this is a boundary check, not a guarantee of good judgment. No reports are uploaded automatically.

Slack answer guidance defaults to 40–60 words: a bold finding, one or two short evidence/limitation bullets, then a labelled next step when useful, separated by blank lines. Use native Slack `*bold*`, not Markdown headings or tables. Simple answers/questions can stay one line; requested detail or material evidence limits may need more space. This is a writing preference, not automatic truncation or a new rejection rule. Preserve time coverage and uncertainty; formatting-only changes do not justify another reply.

## Task discovery

Intake always searches exact mentions of the authenticated owner and accepts direct owner requests in the selected DM. Add `--mention-group ID --watch-channel ID` to `intake` or ordinary `serve` for team mentions and new roots in a selected channel. Verify the selected group and channel in the intended workspace; never commit real workspace identifiers or discovery records.

The bot token verifies active same-workspace group metadata, and the user token searches its current `@handle`. Slack search renders group tags as `<@S...>` while conversation reads use `<!subteam^S...>`; both ID-bound forms are recognized, not plain-text aliases. The user token validates/reads the watched channel. Missing access is an explicit partial feed, never an empty-success claim. Other feeds continue and keep independent checkpoints/cooldowns.

New-channel discovery begins at the first configured intake timestamp. Old roots bumped by replies and broadcast replies are not new threads. Mention discovery retains the existing initial one-day lookback and overlap. Scope is saved in `intake/discovery.json`; omission or changes on restart fail closed. Use a fresh root for a deliberate scope change, not deletion of the binding. `--inbox-only` excludes both new discovery sources.

Every non-done task's stored source threads are polled for updates without requiring another mention. Owner replies in the task's own thread continue in the same session. Matching is by stored channel/thread identity, not general link crawling. Duplicate paths produce one receipt/task; canonical conversation text outranks search formatting. Models distinguish actionable requests from chatter; discovery does not authorize operational actions. Search remains best-effort, not complete historical/edit/deletion coverage.

Opt-in classification check: build, then `node task-assistant/test/discovery-quality.mjs`. It uses synthetic receipts and a real model, without Slack access, task workers or live state.

## Automatic bounded discovery trial

`serve --discover-tasks 3 --workers 2 --pilot-seconds 600 --mention-group ID --watch-channel ID --exclude-threads PATH` admits at most three tasks in total, including finished tasks. Use a fresh root and the approved owner DM (`--conversation ID`); Slack publication still requires `--allow-slack-writes`. The exclusion file is a JSON array of validated Source identities: their entire threads are excluded, including protected prior tasks. An explicit `[]` means none need protection.

The coordinator considers recent actionable owner/team mentions and newly observed channel roots. It reserves a deterministic task identity before enqueueing, so restart cannot reset the task budget. Owner replies and stored-source updates continue admitted tasks in their exact sessions. Old/top-level DM requests, excluded threads and capacity overflow remain private/pending without model work; they do not stop this discovery trial. Partial intake, blocked classification, worker failures and uncertain publication do stop it. The original deadline survives crash recovery; stopped/expired trials and omitted/changed scope are rejected. Do not delete the ledger to restart.

This mode reads Slack sources and owner-authorized references described above, and writes local drafts plus approved task messages in the owner DM. It does not have general filesystem, shell, Jira, site telemetry or operational tools. It cannot combine with inbox-only/preselected-task/telemetry modes. New-channel history starts at initial intake; mention lookback remains one day. Completed tasks do not free admission slots. `node task-assistant/test/concurrency-quality.mjs --automatic` exercises real-model admission and continuation with synthetic Slack; compiled CLI tests cover actual scheduling/deadlines and three-source discovery.

## Bounded concurrent tasks

`serve --workers 2` opts into two separate task sessions at once; the default remains one. One coordinator captures up to ten queued tasks per parallel cycle, atomically claims each task once, refills a freed slot and publishes each finished task's answer without waiting for slower peers. Each task keeps its own session, files and Slack thread. Slack writes remain serialized and use the existing approval, destination, intent and cooldown guards.

Intake still runs every 150 seconds. Classification remains serial **between batches**: replies arriving during work are saved immediately, then routed on the next batch, not injected into active sessions. A slow batch can therefore delay continuation even though intake is healthy. A task failure waits for an owner decision while peers may finish; an uncertain publication holds new dispatch. Fatal errors/stop requests abort and await every running session before unlocking. Startup recovery runs once, before any workers start; never run it over live peers.

For a bounded pilot, `--task-ids ID,ID,ID --workers 2 --inbox-only --pilot-seconds 600` allows one to three existing published tasks in an exact-match state root. It admits owner task-thread replies and updates from those tasks' stored source threads; unrelated receipts stay pending and stop an incomplete pilot cycle. It cannot create new tasks. Duplicate/missing IDs, extra root tasks, incomplete session/parent mappings and an unbounded allowlist run are rejected before recovery or API calls. `--once` can instead run one bounded scoped cycle without a timer.

Two-worker mode still rejects legacy `--task-id` and all log/configuration flags. Existing single-task telemetry pilots remain unchanged. Multi-site investigation remains unavailable. For preselected-task trials, broader discovery runs separately in read-only intake before selection: discovery flags cannot be combined with inbox-only mode. The separate automatic trial above permits explicitly approved automatic selection. Scope/destination/deadline and posting approval remain required. Do not substitute unscoped continuous `serve` for a trial.

Opt-in real-provider proof: build, then run `node task-assistant/test/concurrency-quality.mjs`. It uses three synthetic projects, real Pi sessions/model calls, synthetic Slack and owner replies, exact-session reopen and an idle third cycle. Evidence and runtime snapshots are saved under ignored `tmp/concurrency/`. Review actual outputs alongside the gates; this is not live Slack acceptance.

## Durable investigation follow-up

With investigation enabled, `finish_task.investigation` records a private question, lead, result, tool-issued evidence references and stopping state. Code validates references and permits a next service check only from observed scoped errors. The checkpoint settles atomically with the outcome in `runs/<task-id>.json`; it survives directory moves and interruption without overwriting human `plan.md` or artifacts.

One pending check may reopen a reviewed task on the next work cycle, even when intake is unchanged. That run's `inspect_task_traces` searches the saved service within the same site/environment and rolling 15-minute window, instead of repeating old log IDs. It retains the three-trace cap and 20-second deadline; concurrent calls share one check. The budget is not replenished by polls or new logs. A new owner-thread request supersedes an older pending check and allows a newly justified plan. Cancellation retains unfinished work; waiting/done tasks are not reopened. `--once` remains one cycle, not an entire investigation.

Checkpoint states distinguish `follow_up`, `blocked`, `answered` and passive `monitoring`. Checkpoint edits alone do not warrant Slack replies. A same-service trace can concern another workflow or time; empty/rejected samples do not establish recovery. Historical windows and targeted dependency logs remain unavailable. Assessment version 4 requests a fresh assessment on a future authorized run; this is not restart approval.

Opt-in quality replay (real provider, synthetic Grafana, no live Slack): build first, then run `node task-assistant/test/investigation-quality.mjs` from the repository root. Use `--distractor`, `--foreign` or `--empty` for counterexamples. Reports and runtime snapshots go to ignored `task-assistant/tmp/followup-quality/`. Inspect actual evidence, conclusions and stopping reasons; a passed mechanical gate is not model-quality acceptance.

## Commands

Requires Node.js 22.19+. Build from the repository root:

```bash
npm run build --workspace task-assistant
node task-assistant/dist/cli.js --help
```

| Command | Behavior |
| --- | --- |
| `preflight` | One bounded, read-only Slack access check |
| `run` | Repeat preflight checks, not task execution |
| `enqueue` | Read one JSON request from stdin; create/find a complete local task |
| `list` / `move` | Inspect local task IDs/status or make an explicit status transition |
| `intake` | Read Slack and persist receipts/checkpoints; no model calls or posts |
| `step` | Classify pending receipts and run one local task; no Slack communication |
| `serve` | Intake, serial classification, bounded task work (one worker by default, opt-in two), and optional task-specific Slack updates |

Every stateful command requires `--root PATH`. Use one state root on a local filesystem, outside the checkout for real use. The root owns one coordinator lock. Do not open its task sessions in another writing Pi process while it is running.

For an approved bounded trial, `serve --inbox-only --task-id ID --pilot-seconds 600` limits work to owner replies in one existing published task thread and stops after ten minutes (up to 30 seconds for shutdown). It requires a single-task root; unrelated receipts remain pending and cause the pilot to stop rather than start new tasks. Slack writes still require `--allow-slack-writes`. Record the approved task, destination and deadline outside Git before starting. This does not install a service or start with normal Pi sessions.

### Read-only checks

Provide `SLACK_USER_TOKEN` and `SLACK_BOT_TOKEN` through the environment, never command-line arguments or checked-in files.

```bash
node task-assistant/dist/cli.js preflight --search-api legacy \
  --conversation DEXAMPLE --source-thread CSOURCE:1700000000.000001
node task-assistant/dist/cli.js run --once --search-api realtime
```

IDs above are placeholders. `TASK_ASSISTANT_SEARCH_API` and `TASK_ASSISTANT_CONVERSATION` can supply the preflight flags. Both search APIs remain available for explicit preflight; intake uses the selected `legacy` endpoint and never silently falls back.

Preflight authenticates both identities, checks workspace agreement, probes search using the user token, verifies the selected DM and history using the bot token, and reads a supplied source thread. Missing inputs stay unverified. Passing a bounded access probe is not proof of complete search coverage.

### Local queue

Queue commands need no Slack or model credentials:

```bash
node task-assistant/dist/cli.js enqueue --root /path/to/state < request.json
node task-assistant/dist/cli.js list --root /path/to/state
node task-assistant/dist/cli.js move --root /path/to/state --task-id task-HASH --status queued
```

`request.json` is one object, at most 64 KiB:

```json
{
  "request": "Investigate the supplied example and prepare a local note.",
  "outcome": "A local draft; no external actions.",
  "sources": [{"workspace_id":"TEXAMPLE","channel_id":"CSOURCE","message_ts":"1700000000.000001"}],
  "inbox": {"workspace_id":"TEXAMPLE","channel_id":"DASSIST","owner_user_id":"UOWNER","bot_user_id":"UBOT"}
}
```

Sources may include `thread_ts`. Unknown fields, duplicate sources, invalid IDs, and cross-workspace inputs fail validation. A repeated source returns `existing`, including after status moves. New aliases attach to that task; sources linking two existing tasks fail visibly. The coordinator-only `enqueue_task` tool wraps the same deterministic engine as the JSON CLI; models do not create directories themselves.

A task is assembled in `staging/` before atomic publication in `queued/`. It contains `task.json`, `plan.md`, `evidence.md`, `handoffs.md`, and `artifacts/`. Status exists only in the parent directory: `queued/`, `active/`, `waiting/`, `review/`, or `done/`. `sessions/`, `runs/`, and `intake/` stay outside moving task directories.

### Intake and task execution

```bash
# Persist Slack receipts only, then exit.
node task-assistant/dist/cli.js intake --root /path/to/state \
  --search-api legacy --conversation DEXAMPLE --once

# Process pending receipts and one local task. Provider/model are explicit.
node task-assistant/dist/cli.js step --root /path/to/state \
  --provider PROVIDER --model MODEL

# A supervised cycle; Slack writes remain disabled.
node task-assistant/dist/cli.js serve --root /path/to/state \
  --search-api legacy --conversation DEXAMPLE \
  --provider PROVIDER --model MODEL --once --inbox-only
```

`step` and `serve` use Pi's existing provider credentials. `--agent-dir PATH` optionally selects an explicit Pi credential/model configuration directory. No extensions, skills, project settings, context files, MCP servers, or general-purpose tools are discovered for task workers. A worker can write bounded Markdown artifacts, record its outcome, and use task-specific Slack tools. In `serve`, it can also read paginated context from its stored source threads. It cannot choose arbitrary Slack destinations, run shell commands, write Jira, or perform production operations. This is a restricted tool set, not an OS sandbox.

`serve --inbox-only` omits global mention discovery for a supervised DM trial. Normal `serve` also polls mentions and tracked source/task threads. Waiting tasks do not consume a worker. Replies are processed in the next settled run of the same session; this version does not steer an in-flight model run.

**Only after explicit approval**, adding `--allow-slack-writes` enables parent creation/updates and task-thread replies in the stored owner/bot DM. An owner mention is added only for a requested response; other text cannot inject Slack mentions. Read access, inbox selection, and `--inbox-only` are not write approval. Keep deployment-specific approvals and acceptance records outside this repository.

Without `--once`, `intake` and `serve` remain foreground processes. Intake starts on a **150-second schedule**, independently of classification and the bounded worker batches. Slow intake skips missed ticks; polls never overlap or catch up in a burst. Slack cooldowns can delay affected methods without stopping unrelated feeds. Multiple polls during busy work request one follow-up batch; captured replies reach the same session after the current batch settles. This is an awake-host timer, not a hard real-time guarantee. A sleeping/offline machine does not monitor Slack. Ordinary `serve` does not install a daemon; background installation is explicit.

Ctrl-C/SIGTERM cancels intake/model work and waits for active work to settle before releasing ownership. `serve --once` still completes one intake/work/publication cycle before exiting. Continuous `serve` emits separate intake and task-cycle JSON reports; intake can advance while the last task-cycle report remains unchanged. The separate `run` preflight command retains completion-to-start scheduling.

## Recovery and limits

- Intake checkpoints are independent per feed. Receipts are saved before a checkpoint advances. One failing thread does not prevent other feeds from succeeding.
- Search overlaps by ten minutes, uses an extra date-bound margin, filters exact mention markup/timestamps locally, and traverses result pages. First intake starts with a 24-hour window. Index lag beyond the overlap, legacy search coalescing, and old edits/deletions can still be missed. This is not a lossless change feed.
- Conversation history/thread text takes precedence over indexed search text for the same message. Search formatting or index lag must not reset reviewed work. New search-only messages remain discoverable; a failed conversation feed stays visibly failed rather than letting search replace its stored content. Genuine edits seen by that feed still create a new revision. A search-only “not a literal mention” filter does not suppress valid source-thread context.
- New information is classified once per receipt revision; saved decisions are replayed after interruption. Blocked classifications stay visibly `blocked` in the receipt and cycle report rather than silently disappearing or triggering endless model calls. Resolve their recorded cause before an operator resets them to pending; there is no broad automatic retry.
- Up to ten pending receipts are classified per cycle, each with a 60-second model deadline. A task run has a 120-second/eight-assistant-turn budget; an in-flight bounded tool may finish while cancellation settles. These are execution bounds, not a hard dollar/token cap.
- SDK sessions are opened by their exact ID/file, never by “most recent.” Interrupted active runs and persisted outcomes are reconciled before new replies are routed. Graceful stops remain resumable; model failures become waiting tasks with a visible reason.
- Posting intent is durable before transmission. A lost response is matched against bot history/thread content before accepting its result. If no unique match can be established, publication stops with `slack_write_needs_reconciliation`; it does not blindly repost. Delivery retries within a run are deduplicated; separate owner questions may receive identical answers. Explicitly silent outcomes produce no thread reply, and unchanged parent renderings are not edited repeatedly.
- The maintained filesystem lock recovers after approximately ten seconds without a heartbeat. Unpublished staging is discarded under the recovered lock. This is process-crash protection on one local filesystem, not a multi-host or universal power-loss guarantee.
- Queue/receipts/transcripts contain internal source content. Keep the state directory private and out of Git. stdout contains routing metadata and diagnostics, not source bodies or credentials.

## Verification

```bash
npm run verify --workspace task-assistant
npm run verify

# Optional real-clock check (~3 minutes), after the build above; synthetic APIs only.
TASK_ASSISTANT_REAL_CLOCK=1 node --test task-assistant/test/flow.test.ts
```

E2E suites build and exercise the compiled CLI. They cover access boundaries, queue replay and SIGKILL, pagination, independent failures, persisted rate limits, classification, real Pi session continuation, scoped tools, Slack write gating, owner/progress notifications, uncertain-post reconciliation, graceful/SIGKILL recovery, and run budgets. Scheduler cases also cover busy-worker intake, receipt edits, directory moves, merged rate limits, missed ticks, and clean shutdown on intake/work failures. Fast cases accelerate only the scheduler clock by 1,000; the optional check uses the actual 150-second interval during serial model work. Transport fixtures are injected by Node preload files in tests; production exposes no Slack endpoint override. Repeatable evidence is stored under `task-assistant/tmp/*-e2e-*/report.json` and `tmp/e2e-*/report.json`.

Exit codes: `0` succeeded/idle or graceful SIGTERM; `1` configuration/API/internal blocking error; `2` incomplete/partial/held work; `130` Ctrl-C where supported. A clean exit does not mean the entire product milestone is accepted. Keep live acceptance and its remaining gaps in private deployment records; synthetic scheduler checks do not authorize or establish unattended live operation.

## Private records and publication

This repository contains implementation, synthetic fixtures and reusable documentation—not operational history. Store real task state, Slack/customer content, approvals, credentials, session transcripts, dependency-investigation records and live runbooks outside the checkout. Ignored `tmp/` is for disposable local test evidence, not an access-control boundary.

Legacy operational-document filenames and local operations directories are ignored and excluded from package archives. Git ignore rules do **not** remove already tracked files or earlier commits. When publishing previously private development, use a clean snapshot on the current public base (for example, a reviewed squash), or carefully filter unpublished history. Do not merge or push the sensitive ancestry. Inspect the final tracked tree, reachable new commits and package contents before publication.

Remaining acceptance areas include natural background task execution, prolonged reliability, sleep/wake/login/reboot behavior, direct reviewer handoffs and live owner-linked session evidence. Keep each deployment's observations and unchecked items private; these are not claims of broad unattended readiness.
