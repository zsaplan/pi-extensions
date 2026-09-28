# Codex Research

Pi extension that delegates public-web research to the locally installed and authenticated OpenAI Codex CLI. Codex performs native live web searches in an isolated read-only working directory, while the calling Pi agent receives only the final cited report and bounded metadata.

## Tool

### `codex_web_research`

Inputs:

- `question` — the research task
- `depth` — `quick` or `thorough` (default); controls research breadth
- `reasoningEffort` — `low`, `medium` (default), or `high`; controls model deliberation independently of depth
- `threadId` — optional Codex thread UUID returned by an earlier call

The tool returns a report, sources, uncertainties, an artifact path, and a thread ID. Pass that thread ID in a later call to continue the same research conversation.

## Prerequisites

Install and authenticate the official Codex CLI:

```bash
brew install --cask codex
codex login
codex login status
```

The login may use a supported ChatGPT plan. The extension does not read or copy Codex credentials. The current extension contract requires Codex CLI 0.158.0 or newer and checks the installed version before starting the first research call.

## Isolation and context boundaries

Each invocation:

- runs in a newly created empty temporary directory
- enables Codex's native `--search` capability
- selects the read-only sandbox and disables approval prompts
- ignores Codex user configuration and exec-policy rules
- instructs the researcher not to inspect the local filesystem or execute shell commands
- checks CLI compatibility before spending a research turn
- forwards cancellation to the Codex subprocess and removes its temporary workspace
- stores the full structured result locally, but only returns a bounded result to Pi

Research artifacts default to `~/.pi/agent/codex-research`. Override the location with `PI_CODEX_RESEARCH_DIR`. Override the executable for testing or a nonstandard installation with `PI_CODEX_RESEARCH_BIN`.

The Codex sandbox primarily restricts writes; it is not a confidentiality boundary against a malicious model process. Do not delegate secrets, private-company data, or tasks where local filesystem visibility would be unacceptable.

## Local usage

From the repository root:

```bash
npm install
pi -e ./codex-research
npm run verify --workspace codex-research
```
