# Private task-assistant release — native Apple Silicon macOS

This is an application release, not a Pi extension install and not a state backup.
It includes compiled task-assistant code and the frozen GitHub profile/code snapshot.
Parent SDK/CLI **1.1.0** and researcher SDK/CLI **0.99.2** install separately.
No global Pi command, developer checkout, copied node_modules, Cloudflare or Pi Durable is used.

## Install without starting anything

Use native arm64 **Node 26.10.0 and npm 11.19.1**, the tested pair recorded in release.json.
The existing application floor is Node 22.19.0; other versions are not qualified by this release.
Install Node/npm separately from a trusted distribution. Resolve any version-manager shim to the
actual npm CLI JavaScript file for --npm-cli. The installer invokes it with the selected Node.

Transfer the .tgz and .sha256 through a private approved channel. Compare the hash with the
separately supplied RESULT.md before unpacking. Do not transfer auth, state or development folders.

```sh
umask 077
# In the directory containing the release and its checksum:
shasum -a 256 -c task-assistant-RELEASE-darwin-arm64.tgz.sha256
mkdir unpacked
tar -xzf task-assistant-RELEASE-darwin-arm64.tgz -C unpacked
mkdir -p "$HOME/Applications/task-assistant/releases"
node unpacked/install.mjs \
  --prefix "$HOME/Applications/task-assistant/releases/RELEASE" \
  --npm-cli "$(command -v npm)"
RELEASE="$HOME/Applications/task-assistant/releases/RELEASE"
PRIVATE="$HOME/.local/share/task-assistant"
node "$RELEASE/manage.mjs" init-config --file "$PRIVATE/config.json" --private-base "$PRIVATE"
node "$RELEASE/manage.mjs" check --config "$PRIVATE/config.json"
```

Install uses the included lockfiles, public registry tarball integrity and destination-local npm ci,
with lifecycle scripts disabled and no inherited npm authentication/config. It needs registry access.
No credentials, tasks, approvals, LaunchAgent or listener are created. Existing destinations are
refused. Keep a failed partial destination and its .install logs for inspection; never enable it.
Checks are local only; missing prerequisites are expected on a fresh host. Hashes are integrity
checks, not signatures: transfer the release and trusted checksum securely.

## Configure the service account (later explicit step)

Keep private directories 0700 and files 0600. Edit config.json to set the exact owner DM conversation,
data root, session library, auth directories, service directory and approval paths. All must be
absolute. State/auth/service directories must be separate from one another and from the release.
Code releases are immutable after installation; do not run npm update in them.

Authenticate locally through each pinned CLI, with separate deliberate logins. Do **not** copy a
rotating OAuth session between machines or assume cross-version refresh locking works.

```sh
mkdir -m 700 "$PRIVATE/auth-parent" "$PRIVATE/auth-researcher" "$PRIVATE/session-library"
cd "$PRIVATE"
PI_CODING_AGENT_DIR="$PRIVATE/auth-parent" \
  node "$RELEASE/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
    --no-extensions --no-skills --no-prompt-templates --no-themes
PI_CODING_AGENT_DIR="$PRIVATE/auth-researcher" \
  node "$RELEASE/researcher/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
    --no-extensions --no-skills --no-prompt-templates --no-themes
# In each CLI use its supported /login flow, then exit.
```

Create credentials.json with your editor under umask 077. Supported fields are SLACK_USER_TOKEN,
SLACK_BOT_TOKEN and, only when GitHub research is enabled, GH_TOKEN. Never put values in argv,
plist, release files, shared logs or this document. Local login availability, provider/model access,
expiry and refresh under launchd remain target acceptance checks. No API-key billing fallback is added.
Optional researcher=false disables new research capability; it cannot remove a binding from an
existing research-enabled task store. Jira/Zendesk links are navigation only, not ticket access.
Grafana/config/Tempo capabilities are not enabled by this service configuration; missing tools
are not replaced with broader ones.

### Fresh state is not ongoing-use approval

Installation does not manufacture trial/renewal/regular-use/backlog approvals.
The existing application requires a completed bounded trial **and closed renewal history** before
RegularUse.open accepts ongoing operation. Use the existing application onboarding procedure under
separate explicit scope/Slack-write authorization; the archive's app/dist/cli.js --help describes
the bounded trial switches. Then supply the exact owner-approved regular-use JSON and, when approved,
backlog JSON. Configure validates that existing history and preserves its limits.

A blank installation therefore cannot jump straight to a production listener. If no qualifying
trial/history/approval exists, configure must fail; obtain a separately planned onboarding run.
For existing tasks, follow MIGRATION.md instead. Do not generate synthetic history for real use.

### Service installation stays paused

After required local files and approvals exist:

```sh
node "$RELEASE/manage.mjs" check --config "$PRIVATE/config.json"
node "$RELEASE/manage.mjs" configure --config "$PRIVATE/config.json"
node "$RELEASE/manage.mjs" status --config "$PRIVATE/config.json"
# Explicit read-only live Slack checks; no model or posts:
node "$RELEASE/manage.mjs" preflight --config "$PRIVATE/config.json"
# Only after old coordinator is stopped and startup is separately authorized:
node "$RELEASE/manage.mjs" start --config "$PRIVATE/config.json"
node "$RELEASE/manage.mjs" status --config "$PRIVATE/config.json"
node "$RELEASE/manage.mjs" stop --config "$PRIVATE/config.json"
```

Configure writes one LaunchAgent and a paused service snapshot. It never calls launchctl,
connects to Slack, authenticates or invokes a model. Research paths/hashes are generated from the
installed release; an existing different manifest is refused, not overwritten. No second pool,
scheduler, budget or restart loop is added. Dependency symlinks in the service point only at this
destination's retained release. Do not delete that release while its service is installed.

The LaunchAgent uses RunAtLoad=true and KeepAlive=false. It runs at user login, not before it.
Paused control and the failure latch survive login; only explicit start releases them. Start/stop
also verify that the plist names this exact service directory. One service label/coordinator per
user is supported. Status reports fresh/stale intake separately from process liveness and budget
holds. A crash, auth/identity failure or uncertain write is not automatically replayed; ordinary
temporary Slack reads retain their existing bounded recovery. Never remove an uncertain intent
to make startup succeed.

Keep the Mac plugged in and awake with the lid open; configure power settings separately.
FileVault unlock/login after reboot, network loss, sleep/wake, graceful shutdown and multi-day
operation are not established by isolated tests. No watchdog, pre-login daemon or host-setting
change is included. Personal subscription use by coworkers and company-data handling on a home
host require a separately approved policy; packaging does not settle either question.
