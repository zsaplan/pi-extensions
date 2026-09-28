# Codex Research Design

## Purpose

Provide Pi with an explicit, bounded web-research capability backed by the official Codex CLI and the user's existing Codex authentication. The parent agent should not receive a general browser, search tool, DOM snapshots, or Codex's intermediate event stream.

## Runtime model

`codex_web_research` starts one non-interactive `codex exec` turn with native live search enabled. Codex writes a schema-constrained final document and emits JSONL lifecycle events. The extension extracts the thread ID from those events, validates the final document, persists the complete result, and returns a bounded copy to Pi.

A later invocation can supply that thread ID to run `codex exec resume`, preserving the research conversation without keeping a subprocess alive.

## Boundaries

- Public-web research only; local and private authoritative systems remain the responsibility of other tools.
- No browser automation or private ChatGPT web endpoints.
- No credential handling; authentication remains owned by Codex.
- Empty temporary working directory and read-only sandbox for every turn.
- No shell interpolation; command arguments are passed directly to Pi's process executor.
- Web content is explicitly treated as untrusted prompt content.
- Full outputs are local artifacts; model-facing output is size-bounded.

## Known limitations

- Codex web research is not ChatGPT's Deep Research product workflow.
- Codex CLI flags and JSONL event contracts can change between CLI releases.
- The read-only Codex sandbox prevents mutation but is not a strict local-read confidentiality boundary.
- Persistent Codex threads remain in Codex's own session storage until removed with Codex tooling.
