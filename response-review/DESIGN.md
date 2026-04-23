# response-review Design

## Purpose

This document defines the package-level design for `response-review`.

It should be read alongside the repo-level design in [`../DESIGN.md`](../DESIGN.md). The root document defines repo orchestration and package contracts. This file defines the design of the `response-review` package itself.

---

## Package role

`response-review` is a **native-window review extension** for assistant responses.

Its job is to let an operator review assistant output after the fact, attach targeted comments, and turn that review into an editable prompt for follow-up feedback inside Pi.

The package is intentionally centered on human-guided review rather than automated scoring.

---

## Responsibilities

This package owns:

- loading assistant responses from the current session or a selected retroactive session
- opening and managing a native review window
- presenting response metadata and lazily providing full response text to the window
- collecting whole-response and line-targeted review notes
- generating a follow-up feedback prompt and inserting it into the Pi editor
- bridging clipboard operations between the native host and the web UI
- owning the web bundle generation and runtime artifact used by the native review window

This package does **not** own:

- automated quality scoring of assistant responses
- persistent storage of review comments outside the immediate review flow
- session navigation beyond selecting current or explicit session sources
- generalized browser-host infrastructure for unrelated extensions

---

## Design goals

### 1. Keep human review first-class

The package should help a human produce focused feedback, not replace their judgment.

### 2. Make targeted review practical

Line-targeted notes, excerpts, and contextual previews should make precise critique easy.

### 3. Support both current-session and retroactive review

The package should work for immediate review and for reviewing older saved session files.

### 4. Keep package-specific build ownership local

The native window and web bundle are this package's responsibility and should not be hidden in root scripts.

### 5. Maintain a single coherent review interaction at a time

The extension should keep its window/session state simple and avoid multi-window complexity by default.

---

## Extension surface

Primary command:

- `/response-review`
- `/response-review current`
- `/response-review <session-id-prefix>`
- `/response-review <path-to-session.jsonl>`

The command opens a native review window, allows the user to annotate assistant responses, and inserts a generated feedback prompt into the editor when review is finalized.

This package does not expose a tool because its main value is an interactive operator workflow.

---

## Runtime architecture

`response-review` has three main layers.

## 1. Host extension layer

The host layer runs inside Pi and is responsible for:

- command handling
- session resolution and loading
- active-window lifecycle management
- waiting/cancel UI in the terminal
- host-side clipboard integration
- receiving review results and inserting the final prompt into the editor

This is the authoritative runtime controller.

## 2. Native window layer

The package uses a native window host via `glimpseui`.

That layer is responsible for:

- rendering a separate focused review surface
- sending typed messages back to the host
- receiving host responses such as requested response text or clipboard results

The window is intentionally transient and tied to a single review session.

## 3. Embedded web UI layer

The actual review interface inside the native window is an embedded web application.

This layer is responsible for:

- response list and selection UI
- line-based note interactions
- local in-window review state
- final submit/cancel payloads

The web UI should remain focused on review ergonomics, while session loading and editor mutation stay in the host layer.

---

## Data-flow model

The review workflow is intentionally staged.

1. host resolves the session source
2. host loads assistant-response metadata and previews
3. host opens the native window with lightweight initial data
4. window requests full response text only when needed
5. user creates review notes in the window
6. window submits structured review payload back to host
7. host generates a review prompt and inserts it into the editor

This lazy data flow keeps the initial window payload smaller and preserves a clear host/window boundary.

---

## Session model

The package supports two main session sources:

- current live session context
- explicit saved session file / matched session id

The package intentionally does not own broader in-window branch or session navigation. It relies on Pi's session infrastructure for that and focuses only on the review step.

Assistant messages without visible text are ignored so the review surface stays relevant.

---

## Review interaction model

The UI is designed around whole-response and whole-line review.

Important design choices include:

- the smallest inline selection unit is a full line
- inline notes are exclusive by covered line range
- overlapping inline comments are prevented by reopening the existing note
- keyboard-first interaction is supported
- escape/cancel behavior is explicit in both the native window and waiting terminal UI

These choices reduce ambiguity and keep the review model easy to reason about.

---

## Clipboard model

Clipboard behavior is handled by a host bridge rather than assumed to work natively inside the WebView.

That bridge is owned by this package because clipboard interoperability is part of the review experience, not a generic repo concern.

The host layer translates platform-specific clipboard operations for:

- macOS
- Linux
- Windows

This keeps browser-side note editing predictable across supported environments.

---

## Build and artifact model

This package owns generated runtime web artifacts.

Current design:

- `web/app.ts` is the tracked source of truth
- `web/app.js` is the generated runtime artifact used by the native window
- `src/ui.ts` ensures the bundle exists and then inlines it into the window HTML
- the package's scripts are responsible for building and checking this artifact

This is an important package boundary. The repo root may orchestrate verification, but it should not own the implementation details of this build pipeline.

---

## State model

## Host-side state

The package keeps small transient host state for:

- the currently active review window
- the waiting terminal UI dismissal handle
- loaded response maps for the active review operation

## Window-side state

Review note state lives inside the window/web app for the duration of the review and is submitted back to the host when complete.

There is intentionally no persistent external database or long-lived review history.

---

## Coupling and dependencies

## External coupling

This package depends on:

- Pi session and UI APIs
- `glimpseui` for native window hosting
- the generated web bundle and HTML template it owns
- platform clipboard commands when clipboard shortcuts are used

## Internal repo coupling

This package has no intended runtime dependency on local Rain packages or other extensions.

Its main relationship to the repo root is that the root should orchestrate, not own, this package's package-local build and verification contract.

---

## Failure model

The package should fail explicitly and safely.

Expected behavior includes:

- only one active review window at a time
- review cancellation should cleanly close the window and return control
- missing or ambiguous session resolution should surface a clear error
- clipboard failures should be reported without crashing the overall review flow
- window errors should be surfaced to the user and cleaned up

The design goal is a recoverable operator workflow rather than silent failure.

---

## Validation model

`response-review` is a build/artifact-producing extension package and should own a correspondingly richer package-local `verify` contract.

That verification should eventually center on:

- linting
- typechecking host-side source
- typechecking web-side source
- building the web artifact
- validating the generated runtime artifact syntax
- any package-specific packaging smoke checks that prove useful

The package should own those steps locally. The root should only orchestrate them.

---

## Packaging model

`response-review` should remain understandable as a standalone extension package with:

- a host extension entry
- a native-window dependency
- a package-owned web build pipeline
- package-local documentation describing the workflow and artifact rules

Its build logic should remain local so the package can evolve without leaking special cases into repo-root scripts.

---

## Tradeoffs

This design intentionally favors:

- human-guided review over automation
- a focused single-window workflow over concurrent review sessions
- package-local artifact ownership over root-level convenience scripts
- explicit host/window boundaries over fully unified in-process UI

Those tradeoffs are appropriate because the package's value comes from a coherent operator experience.

---

## Summary

`response-review` is designed as a native-window review workflow for assistant responses:

- load responses from current or retroactive sessions
- let the operator annotate them precisely
- convert that review into an actionable feedback prompt in the editor
- own its native-window and web-bundle mechanics locally

Its core design principle is precise, human-centered response review with package-local ownership of its UI and build surface.