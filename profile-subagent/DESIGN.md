# Profile subagent design

## Mission

Let a parent discover and run a trusted narrow specialist with explicit context and capabilities. Postfix investigation/repair is one application, not the runner's architecture. Search advises; the parent chooses and remains responsible for verification and authorization.

The public development contract is recorded in the repository's OpenSpec change `search-trusted-specialists`. [RESEARCH.md](RESEARCH.md) preserves the historical architecture comparison; [README.md](README.md) describes current behavior.

## Trust boundary

One call creates one fresh in-process Pi SDK session. A bundled JSON manifest fixes the role, eagerly loaded AGENTS/skills, exact tool names and limits. Profiles are reviewed package code, not user prompts or project-discovered configuration.

Children independently require `openai-codex/gpt-6.1-sol` / medium. Unknown models or unsupported thinking fail without substitution. No parent history, ambient AGENTS, skills, packages, extensions, MCP or prompt templates are discovered.

An explicit resource loader supplies only trusted instructions. Both `builtinTools` and `parentTools` resolve against currently callable parent tools and become wrappers using `ctx.executeTool`. There are no child-local fallback implementations. This preserves parent validation, permission/approval hooks, redaction and nested accounting. The exact active child tool set is checked after session creation.

The content digest includes manifest, resources and shared child instructions, not absolute checkout paths. Search digests are provenance, not grants; queue admission reloads definitions and tools. Current leaf manifests reject duplicate tools, recursive runner tools and broad dispatch/discovery.

This is **not an OS sandbox**. The parent's file tools and hooks govern filesystem access, and provider code shares the process/environment. Instructions cannot enforce filesystem secrecy or database row scope. Future shell/write-capable profiles would require a new authority review; current bundled roles have neither.

Only runtime credentials for the child's selected provider are copied in memory. A key from another parent provider is never forwarded. Registered provider implementations/configuration are preserved. Stored keys/OAuth use Pi's normal credential and refresh path. Credentials do not enter task/profile/artifacts.

## Discovery and execution

Discovery validates entries independently, excluding malformed/conflicting definitions while reporting bounded diagnostics. It returns metadata, matching terms, source/digest and missing tools—not full instruction bodies. Ranking is deterministic and does not auto-launch a child. Known IDs remain directly runnable.

Run calls have direct exposure and parallel execution, gated by parent tool enablement. A per-extension three-slot FIFO queue bounds active children. Queue wait is outside the execution timeout; cancelled waiters create no session/artifacts. Slots remain occupied through cooperative cleanup/persistence. Details and cancellation-accounting rationale are in [ORCHESTRATION.md](ORCHESTRATION.md).

There are no background jobs, automatic retries, resume, mutable catalogs, repair executor, nested teams or approval UI. Incomplete, empty, aborted and length-limited responses fail rather than becoming successful plans.

## Evidence and lifecycle

Each run saves private input/profile snapshots, messages, full Markdown and result metadata under the agent directory. Completion metadata is persisted last. Failure to save evidence makes the result failed. Returned output is bounded with an explicit truncation flag.

Results include actual model/tools, profile digest, parent session, timing, status and usage. Parent nested usage is a cross-check; it is not added a second time. Cancellation propagates to the SDK and bridged tools but cannot hard-kill a tool that ignores its signal. No artifact cleanup policy is automated.

## Verified failure cases

The real CLI/SDK E2E suite covers:
- Ambient resources or parent conversation leaking into a child.
- Invalid IDs/manifests, resource traversal, missing resources and conflicting profiles.
- Unlisted tools, broad dispatcher/recursive delegation, missing or disabled parent tools.
- Parent denial/redaction bypasses, temporary credential precedence and cross-provider separation.
- Missing model, unsupported thinking, provider failure, empty/truncated responses and limits.
- Concurrent isolation, queue revalidation/cancellation and accounting through codemode cleanup.
- Large results with complete private artifacts, shared-instruction digest changes and handoff isolation.
- Packed installation outside the checkout, default-tool prerequisites and removal.

A scripted provider exercises integration mechanics, not useful model decisions. Separate real-model synthetic sweeps covered selection, abstention and bounded quality. A read-only live connectivity smoke and limited live investigation trials also passed. Full transcripts, targets and operational findings are retained privately, not shipped or linked as public artifacts.

## Acceptance and limits

- [x] Bounded trusted discovery, named execution and five bundled roles.
- [x] Deterministic E2E, original held-out retrieval and two bounded real-model synthetic sweeps.
- [x] Independent child defaults with matching-provider auth and all-tools parent mediation.
- [x] Parent codemode, bounded queue, cancellation and nested-accounting acceptance.
- [x] Optional shared-context delegation trial, with targeted parent verification and aggregate results in [DELEGATION.md](DELEGATION.md).
- [x] Clean dependency installation, full repository validation and packed install/delegation/removal checks; see [RELEASE.md](RELEASE.md).
- [ ] Repeated and genuinely different-context comparisons before general usefulness claims.
- [ ] Normal installed-session acceptance after approved merge/installation.
- [ ] Independently installed operator catalogs, child-scoped codemode and bounded recursion.

### Separate repair/application acceptance

- [ ] General real-tool SQL compatibility and multi-statement rejection/recovery. An offline check rejected one of eight synthetic requests for containing two SELECT statements; the synthetic transport had accepted it without executing SQL. Other live trials recovered from SQL keyword-guard rejections. Neither establishes general compatibility.
- [ ] Independently match deployed source/revision and verify a current candidate.
- [ ] Run the planner for that confirmed candidate and independently review its saved plan.
- [ ] Obtain explicit approval of exact target, SQL, preconditions and recovery.
- [ ] Build/review a separate guarded write interface before any repair.
- [ ] Capture before/after evidence and rerun the relevant auditor/application checks.

Missing current outcomes do not prove migration failure, user impact or repair authorization. Synthetic success and complete OpenSpec tasks are not production readiness.
