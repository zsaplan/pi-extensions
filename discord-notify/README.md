# discord-notify

A minimal pi extension that sends a one-way Discord webhook notification when pi finishes working.

## Current behavior

- Sends a Discord webhook when pi reaches `agent_end` by default, which matches the “agent finished and is waiting for me again” use case
- Supports `PI_DISCORD_NOTIFY_EVENT=turn_end` if you really want a notification after every assistant turn instead
- Sends only basic metadata by default: project, session label when available, and elapsed time
- Accepts no input back from Discord; this extension is outbound-only
- Adds `/discord-notify` for status and `/discord-notify test` for a test ping

## Configuration

Required:

```bash
export PI_DISCORD_NOTIFY_WEBHOOK_URL='https://discord.com/api/webhooks/...'
```

Optional:

```bash
export PI_DISCORD_NOTIFY_ENABLED=true          # default true
export PI_DISCORD_NOTIFY_EVENT=agent_end       # or turn_end
export PI_DISCORD_NOTIFY_USERNAME='pi'
export PI_DISCORD_NOTIFY_AVATAR_URL='https://example.com/pi.png'
```

A legacy fallback env var is also accepted:

```bash
export PI_DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
```

## Install

From this repo root:

```bash
pi install /Users/zach/zsaplan/pi-extensions
```

Or just this package:

```bash
pi install /Users/zach/zsaplan/pi-extensions/discord-notify
```

For quick testing from a checkout:

```bash
pi -e ./discord-notify
```

## Development

From the repo root, run the package-local validation contract with:

```bash
npm run verify --workspace discord-notify
```

The package-local contract runs lint, typecheck, and unit tests. Webhook send failures are best-effort: they are reported as warnings and must not interrupt normal Pi work.
