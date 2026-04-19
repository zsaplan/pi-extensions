# response-review

A pi extension for reviewing assistant responses in a native window with line-targeted notes, similar in spirit to `pi-diff-review`.

## What it does

Adds a `/response-review` command to pi.

The command:

1. opens a native review window
2. lists assistant responses from the current session or a specific retroactive session
3. lets you add whole-response notes or inline notes for one line or a whole-line range
4. tracks comments per response with line pointers and quoted excerpts
5. inserts a self-contained feedback prompt into the pi editor when you finish review

## Install with pi

`response-review` ships from the repo-root pi package in this repository, so git/GitHub installs should target the repository root rather than the `response-review/` subdirectory.

```bash
# global install
pi install git:github.com/zsaplan/pi-extensions

# raw GitHub URL also works
pi install https://github.com/zsaplan/pi-extensions

# install into the current project's .pi/settings.json
pi install -l git:github.com/zsaplan/pi-extensions

# try it for one run without installing
pi -e git:github.com/zsaplan/pi-extensions
```

After installing, restart pi or run `/reload`, then use `/response-review`.

If you are loading directly from a local checkout instead, `pi -e ./response-review` still works; run `npm install` in `response-review/` first so `glimpseui` is available and the generated web bundle can be built locally.

## Command

```text
/response-review
/response-review current
/response-review <session-id-prefix>
/response-review <path-to-session.jsonl>
```

### Examples

- Review the latest/current session branch responses:
  - `/response-review`
- For normal interactive navigation, use `/resume` and `/tree`, then run `/response-review` from the branch you want to review.
- Open a saved session by ID prefix:
  - `/response-review 019d9776`
- Open a saved session by JSONL path:
  - `/response-review ~/.pi/agent/sessions/.../2026-04-18T12-00-00-000Z_uuid.jsonl`

## Review window behavior

- The smallest inline selection unit is a whole line; partial-line selections are normalized to full lines.
- `Shift+Up` / `Shift+Down` extend whole-line selections in either direction, but stop before overlapping an existing inline note.
- Inline notes are exclusive by covered line range. If a line is already covered by an existing inline note, the UI reopens that note instead of creating an overlapping one.
- Keyboard-driven review is supported in the native window, including arrow-key navigation into existing notes, immediate delete on `Escape` for empty notes, delete confirmation on `Escape` for non-empty notes, and confirm-before-finalize on `Cmd/Ctrl+Enter` from the read-only editor.
- Inline notes opened near the bottom of the response auto-scroll into view so they stay usable.
- Copy, cut, and paste inside note textareas use a host clipboard bridge instead of relying solely on WebView-native shortcuts.

## Notes

- The generated feedback prompt is meant to work retroactively. It always includes targeted excerpts, and it conditionally includes the full original assistant response with line numbers when needed.
- Session review uses the branch currently stored in the chosen session file; there is no in-window branch picker.
- Assistant messages without visible text are skipped.
- `response-review/web/app.ts` is the source-of-truth browser code. `response-review/web/app.js` is generated from it, rebuilt on demand when missing or stale, and is not tracked in git.
- `pi install` from git/GitHub handles package installs for you, just like `pi install .` from a local checkout.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- internet access for the Tailwind and Monaco CDNs used by the review window
- for Linux clipboard shortcuts in note textareas: `wl-copy`/`wl-paste`, `xclip`, or `xsel`

### Windows notes

Glimpse supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
