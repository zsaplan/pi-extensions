# response-review

A pi extension for reviewing assistant responses with line-targeted comments, similar in spirit to `pi-diff-review`.

## What it does

Adds a `/response-review` command to pi.

The command:

1. opens a native review window
2. lists assistant responses from the current session branch or a selected retroactive session
3. lets you comment on whole responses, individual lines, or selected line ranges
4. tracks comments per response with line pointers and quoted excerpts
5. inserts a self-contained feedback prompt into the pi editor when you submit

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

## Notes

- The generated feedback prompt includes the original response with line numbers so it can be used retroactively, not only when the original response is still in context.
- Session review uses the current leaf branch of the chosen session file. In practice that means the JSONL session is treated like a tree, and `/response-review <session-id-or-path>` reads the branch that session currently points at rather than opening an in-window branch picker.
- Assistant messages without visible text are skipped.
- If you load this package directly from a repo checkout with `pi -e ./response-review`, run `npm install` in `response-review/` first so `glimpseui` is available. Using `pi install .` handles that for installed package flows.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- internet access for the Tailwind and Monaco CDNs used by the review window

### Windows notes

Glimpse supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
