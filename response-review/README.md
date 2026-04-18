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
- Inline notes are exclusive by covered line range. If a line is already covered by an existing inline note, the UI reopens that note instead of creating an overlapping one.
- Keyboard-driven review is supported in the native window, including line navigation into existing notes and confirm prompts for destructive/finalize actions.
- Copy, cut, and paste inside note textareas use a host clipboard bridge instead of relying solely on WebView-native shortcuts.

## Notes

- The generated feedback prompt is meant to work retroactively. It always includes targeted excerpts, and it conditionally includes the full original assistant response with line numbers when needed.
- Session review uses the branch currently stored in the chosen session file; there is no in-window branch picker.
- Assistant messages without visible text are skipped.
- `response-review/web/app.ts` is the source-of-truth browser code. `response-review/web/app.js` is generated from it at install/build time and is not tracked in git.
- If you load this package directly from a repo checkout with `pi -e ./response-review`, run `npm install` in `response-review/` first so `glimpseui` is available and the generated web bundle is built. Using `pi install .` handles that for installed package flows.

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
