# discord-notify Design

## Purpose

This document defines the package-level design for `discord-notify`.

It should be read alongside the repo-level design in [`../DESIGN.md`](../DESIGN.md). That root document defines the monorepo and orchestration model. This file defines the design of this package specifically.

---

## Package role

`discord-notify` is a **small outbound notification extension** for Pi.

Its job is to send a one-way Discord webhook notification when Pi finishes a turn or when the agent becomes ready for more user input.

This package is intentionally simple. It is meant to be a lightweight convenience extension, not a workflow engine.

---

## Responsibilities

This package owns:

- reading notification-related environment configuration
- validating the configured Discord webhook URL enough to fail safely
- observing Pi session lifecycle events relevant to notification timing
- computing simple elapsed durations for the current turn or agent run
- sending one-way webhook payloads to Discord
- exposing a small `/discord-notify` command surface for status and test sends

This package does **not** own:

- bidirectional Discord integration
- message threading or interactive controls
- long-term persistence of notification history
- queueing, retries, or guaranteed delivery semantics
- broader repo orchestration or shared package tooling policy

---

## Design goals

### 1. Be minimal and dependable

The extension should remain easy to understand and cheap to operate.

### 2. Never block normal Pi work

Notification failures should degrade to warnings instead of disrupting the session.

### 3. Keep configuration explicit

All runtime behavior should come from a small env-var surface and a small command surface.

### 4. Stay stateless across sessions

This package should avoid persistent storage unless a future need clearly justifies it.

---

## Runtime model

`discord-notify` is an **event-driven observer**.

It listens to Pi lifecycle events and computes notification payloads from current session context:

- `agent_start`
- `turn_start`
- `turn_end`
- `agent_end`
- `session_shutdown`

The package keeps only small in-memory timestamp maps keyed by session id so it can compute elapsed duration when the corresponding end event arrives.

When the configured event fires:

1. read and validate current config
2. decide whether notifications are enabled and whether the event matches
3. format a compact human-readable message
4. send the webhook asynchronously
5. surface only a warning if send fails

This keeps the extension passive and low-risk.

---

## Extension surface

## Event behavior

The package supports two notification modes:

- `agent_end`
  - default
  - optimized for “Pi is ready for me again”
- `turn_end`
  - optional
  - optimized for “notify after every assistant turn”

## Command surface

The package exposes:

- `/discord-notify`
  - show current status
- `/discord-notify test`
  - send a test webhook using current config

The command surface is intentionally narrow. Operational complexity should remain in environment configuration rather than in interactive command options.

---

## Configuration model

Configuration is environment-driven.

Current effective concerns are:

- whether notifications are enabled
- which lifecycle event should trigger sending
- which webhook URL to use
- optional message identity decoration such as username or avatar URL

The design assumes configuration is read on demand rather than cached globally. That keeps behavior simple and avoids stale in-process config if the environment changes between runs.

---

## State model

This package maintains only ephemeral runtime state:

- per-session start timestamps for agent runs
- per-session start timestamps for turns

This state exists only to compute elapsed durations and should be cleared on session shutdown.

There is no persistent storage, no session custom-entry history, and no cross-session coordination.

---

## Failure model

Failure handling is intentionally forgiving.

### Expected failure behavior

- invalid or missing webhook config should result in status warnings, not crashes
- webhook send failures should surface to the user as warnings when possible
- network timeouts should be bounded
- notification delivery should be best-effort only

### Non-goal

This package does not attempt to guarantee eventual delivery. If Discord is unavailable or the webhook fails, the package should fail safely and return control to the user quickly.

---

## Coupling and dependencies

## External coupling

This package is coupled to:

- Pi's extension event model
- Discord's webhook HTTP contract

## Internal repo coupling

This package has **no intended runtime coupling** to other repo packages.

It should remain a self-contained extension package. Its only shared relationship to the rest of the repo should be the repo-level development and validation conventions defined in [`../DESIGN.md`](../DESIGN.md).

---

## Validation model

This package has no generated artifacts and no known need for heavyweight testing infrastructure.

Its eventual package-local `verify` contract should stay lightweight, likely centered on:

- linting
- typechecking
- optionally a minimal packaging smoke check

The root should orchestrate that verification, not re-encode its internals.

---

## Packaging model

`discord-notify` should be usable as an independently understandable package.

It should not depend on sibling source-tree imports or hidden repo-root logic for correctness. The package is simple enough that its public extension entry and README/design docs should explain nearly all of its behavior.

---

## Tradeoffs

This design intentionally favors:

- simplicity over feature depth
- best-effort notification over durable delivery
- env-based configuration over runtime UI complexity
- small human-readable Discord messages over rich structured embeds

Those are appropriate defaults for a small personal productivity extension.

---

## Summary

`discord-notify` is designed to stay a small, low-risk, outbound-only convenience extension:

- observe Pi lifecycle events
- compute a simple message
- send a Discord webhook
- fail safely without interfering with normal Pi work

That simplicity is the core design constraint and should be preserved unless a clearly valuable use case requires more.