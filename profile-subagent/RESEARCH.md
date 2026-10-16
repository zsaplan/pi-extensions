# Narrow subagents: architecture research

Research snapshot: October 7, 2026. This is a recommendation, not an implemented redesign.

## Goal

**Enable the parent Pi agent to search for and run a narrow specialist whose role fits the task.** The postfix audit/repair investigation is the first application, not the purpose of the runner.

Recommended flow:

```text
Task → search trusted profile metadata → parent selects an aligned role
     → validate role and available tools → fresh child conversation
     → execute through parent permissions → return result and evidence
```

The parent remains responsible for selection, combining findings, and obtaining any required approval. A child completes a bounded assignment; it does not silently expand its role or assemble a team.

## Executive assessment

- Keep the existing SDK runner. Its fresh context, explicit resources, parent execution bridge, runtime-auth handling, limits and artifacts are appropriate foundations.
- The main missing component is **task-based profile search**, not another execution framework.
- Most examined systems expose an agent catalog and accept a role name. That is dynamic discovery, but not necessarily ranked task-to-specialist search.
- These mechanisms have released implementations and regression histories. There is not enough evidence to call this new extension, either Pi community package, or every combination of their features “battle-tested.”
- Do not adopt a full thread/team/workflow manager solely to obtain one bounded delegate. Reconsider adoption if its larger lifecycle becomes an actual requirement.

## Evidence and limits

Two public-web research passes examined documentation, releases, code and published tests. I also directly downloaded selected primary source files and inspected the locally installed Pi 0.99.2 example. No external project's tests or production workload were executed. Published test results are attributed evidence, not results reproduced here.

Versioned source used for the main comparisons:

| Project | Source boundary | What that evidence establishes |
|---|---|---|
| OpenAI Codex | `rust-v0.161.0`, especially MultiAgentV2 | Released child configuration/history mechanisms; not identical behavior across every backend/version |
| Pi upstream | Locally installed 0.99.2 and `v0.99.2` example | Supported SDK mechanisms and an illustrative subprocess extension; an example is not a hardened subsystem |
| championswimmer/pi-subagent-manager | `v0.17.0` | A published in-process manager, explicit inheritance bridge and regression tests |
| nicobailon/pi-subagents | `v0.76.1` | A maintained broader runner with documented integration APIs and reported operational fixes |
| OpenClaw | `v2026.9.8` policy implementation/docs | Released capability layering and leaf-role restrictions |
| T3 Code | `pingdotgg/t3code`, moving `main` inspected October 7 | Host/provider architecture; not a verified standalone specialist-search contract |

Tags are more reproducible than moving `main`, but are not immutable commit IDs. Downloaded comparison files, hashes and research transcripts are retained privately; they are not dependencies or shipped source. Public primary-source links are listed below.

**X-post limitation:** retrieval of [the supplied post](https://x.com/championswimmer/status/2107883453811233185) did not yield verifiable contents or an outbound repository link. The author's subagent-manager repository was found independently. This report does not claim it was the post's linked implementation.

**T3 interpretation:** “t3” is interpreted as [T3 Code (`pingdotgg/t3code`)](https://github.com/pingdotgg/t3code), not the unrelated T3 web-application stack.

## Findings by system

### 1. Codex: separate history and authority explicitly

Codex advertises configured role descriptions and resolves the caller's selected agent type. It does not establish the task-query catalog search proposed here. Roles and run configuration are separate concerns. [C1]

Pinned MultiAgentV2 supports a fresh conversation through `fork_turns: "none"`; omitted/`"all"` forks full history, and positive numeric values select recent turns in this version. Do not copy its default full-history behavior for a narrow independent specialist. Different versions/backends have different fork rules. [C2]

`prepare_agent_spawn_config` begins with parent configuration and reapplies live approval, working-directory and permission state. **Fresh history does not imply fresh or narrower authority.** This supports retaining the parent's permission boundary instead of treating a new agent as a new trust domain. [C3]

Transfer: a stable named role, explicit context policy, inherited live authority, visible lifecycle. Do not copy Codex's thread orchestration or broad configuration vocabulary into a small Pi extension.

### 2. Pi upstream: use the SDK foundation, not every example default

The installed example discovers Markdown definitions with names/descriptions/tools, resolves an exact agent name, and launches a new `pi --mode json -p --no-session` subprocess. It awaits output and handles cancellation. This is a useful small example of delegation, not ranked specialist search. [P1]

Two defaults are unsuitable for our strict runner:

- An empty or malformed tools list becomes unspecified; the runner omits `--tools` in that case. Empty must not accidentally mean default privileges in our design.
- The child arguments do not explicitly disable ambient extensions. A fresh process/conversation is not a clean resource or permission boundary.

Pi's full-control SDK example is a closer match: explicitly supplied resources, model runtime, tools, session storage, awaited prompt and disposal. Our implementation already follows this pattern. [P2]

Transfer: the SDK lifecycle and explicit resource loader. Keep `[]` as zero tools, reject invalid profiles, and keep ambient discovery disabled.

### 3. Championswimmer manager: closest confirmation of our bridge/auth pattern

`createInheritedToolSource` copies tool metadata but forwards execution through `bridge.executeTool(...)`, rather than calling a captured `execute` implementation directly. Pi's nested-call pipeline applies parent `tool_call` and `tool_result` hooks. This is the same supported boundary our runner uses. [M1, P3]

The manager creates a new `ModelRuntime`, copies registered provider configuration, and mirrors runtime-only API keys from the parent registry. That closely matches our recent authentication fix. It rejects virtual models it cannot reconstruct through the public API. [M2]

However, it replaces built-ins with child-local tools. Its inherited external-tool guarantee is therefore **not** proof that parent read/bash overrides or permission hooks protect those local built-ins. Our choice to bridge every selected tool, including file tools, is intentionally stricter. Keep it. [M1, M2]

Its discovery interface lists agent types. Its broader thread lifecycle includes inherited context, detached children, steering, retained sessions and notifications. Its spawn `timeoutMs` is explicitly report-only: the child keeps running. That is not the timeout behavior our bounded runner should adopt. [M3]

Published tool-inheritance tests exercise parent denial, filtering, single argument preparation, cancellation and rejection of unsafe model-only forwarding. These tests and the extension/MCP inheritance fix in PR #9 are useful hardening evidence, not a blanket security guarantee. [M4]

Transfer: parent execution bridge, auth reuse, explicit failure for unbridgeable capabilities. Defer the thread manager.

### 4. Nicobailon: a real adoption option, but a different policy/lifecycle contract

Foreground children use Pi SDK sessions; detached children run in a separate background process. The implementation reconstructs a child resource environment with selected extensions and child-local policy hooks. It does not generally replay every parent tool/permission/result hook through the parent's execution pipeline. [N1]

The package has a documented structured delegation API for running a configured foreground leaf and explicit capability ceilings. If it is already installed and its policies fit, use that public API rather than importing private runner internals. Its list/get operations are catalog inspection, not a verified task-ranked search endpoint. [N2]

Its changelog documents precisely the failure classes relevant here: extension-provided models not resolving, permission forwarding shared between independent roots, and differences over whether parent `--tools` should constrain children. In particular, a published fix intentionally stopped treating parent `--tools` selection as the general child ceiling. That is a different contract from ours, not inherently a defect in that project. [N3]

There is substantial machinery for workflows, background recovery, mutable profiles, multiple discovery roots and SDK compatibility. Adoption could save lifecycle work later, but would not eliminate the need to define our catalog search and permission boundary.

Transfer: metadata-first discovery, documented adapter boundaries, explicit capability ceilings and evidence artifacts. Do not depend on private implementation files or import its larger feature set without a need.

### 5. OpenClaw: restrictions should compose without granting more authority

OpenClaw lists configured, permitted agent identities and spawns selected targets. Its Gateway-managed sessions and completion delivery solve a broader long-lived/background problem than ours. [O1]

The pinned policy implementation combines configured restrictions with stored inherited capabilities and hard-denies orchestration/control tools for leaf roles. The useful principle is that delegation narrows authority rather than restoring default capabilities. [O2]

Do not copy field names while assuming their semantics: an ordinary empty allowlist and an explicit empty runtime capability cap have different meanings in the inspected version. Define and test our own zero-tools semantics. [O3]

Transfer: capability intersection, explicit leaf roles and deny precedence. Defer the Gateway, nested session tree and durable background delivery.

### 6. T3 Code: borrow boundaries, not its application architecture

T3 is an execution/control surface with real orchestration, not merely a visual skin. Provider adapters own harness behavior; the workspace's server owns processes, filesystem and credentials. Its event log, transactional outbox and effect workers support durable remote clients and execution state. [T1]

I did not establish an independent T3 specialist manifest and task-search runtime. Subagent behavior can come from its underlying provider harness. It is therefore not evidence that our Pi extension needs an event-sourced server or provider-agnostic control plane.

Transfer: keep profile selection separate from execution adapters. Defer server/client orchestration and event sourcing.

## Recommended smallest architecture

### A. Search one logical, operator-controlled catalog

Start with the existing bundled profiles. Add one explicitly configured operator-owned directory when needed to add specialists without changing extension code. These sources form one catalog; no automatic project scanning, remote installation or model-authored profile registration.

Keep the current JSON manifest plus `AGENTS.md`/selected skill files. Markdown/YAML is common upstream, but converting formats provides no needed capability. The durable parts are the stable ID, clear description, explicit tools and validation—not the serialization format.

Add a small amount of routing metadata:

- A precise description of what the role does and when to use it.
- A few task keywords/tags or example phrases where descriptions alone do not retrieve well.
- Existing tool requirements, limits, source path and profile digest.

Do not build a profile inheritance hierarchy or move database knowledge into the runner. Unknown/duplicate IDs must fail clearly. A malformed candidate must not become a broad default role; discovery should identify invalid entries without silently substituting another definition.

### B. Expose task search and named execution

Proposed model-facing contract:

```text
profile_subagent_search({ query, limit? })
  → bounded candidates: id, description, matching terms, required tools,
    current tool availability, source, digest

profile_subagent_run({ profile, task })
  → existing bounded result, status, usage and artifact references
```

Search IDs, tags and descriptions with simple deterministic ranking. Prefer exact role matches, then metadata matches; return a few candidates. Scores are ranking aids, not confidence estimates. The parent reads the descriptions and chooses; the runner must not auto-launch the highest score.

Return no match when no relevant profile exists. Do not silently select a generic unrestricted worker or generate a role. Improve metadata using observed missed matches before adding embeddings or a separate model-based router.

Search must be read-only and must not connect to databases, start children or write profiles. Tool availability means “callable in this parent,” not “credentials/connectivity verified.” Revalidate profile and required tools at run time. Do not silently drop a required tool to make a role runnable.

A known role can still be run directly. Mandatory search receipts add state but no needed authority boundary for a trusted catalog. Record the executed profile digest; a caller-supplied expected digest can be added if changing definitions between selection and execution becomes a demonstrated problem.

### C. Preserve fresh context and parent execution policy

The selected profile supplies role instructions and selected skills. The parent supplies a self-contained assignment and relevant evidence paths or a short summary—not its complete history. The parent keeps responsibility for the broader task.

Use one exact tool allowlist. The two current manifest fields (`builtinTools`, `parentTools`) now use the same bridge, so a future profile-format cleanup can unify them without introducing a policy framework. Effective tools cannot exceed what the parent can currently call. Missing required tools block the run; an explicitly empty set grants no tools.

All calls continue through `ctx.executeTool`, including reads and writes when a reviewed role legitimately grants them. Parent approval and redaction remain in effect. Do not load ambient extensions or invoke captured parent implementations directly.

Do not forward a broad parent orchestrator such as codemode/tool discovery into a narrow child: it could expose the parent's larger tool inventory. Keep these leaf profiles free of delegation tools. If child-local orchestration is ever needed, it must see only the child's permitted tools.

A tool allowlist is not a filesystem, database-row or OS sandbox. Broad shell/SQL tools can still access more than the intended task scope. Prefer existing narrow domain tools; add target/path enforcement at those tool boundaries when a task actually requires a hard resource restriction. Do not claim the role prompt enforces it.

### D. One awaited, bounded child with evidence

Keep the in-process SDK session, current model/auth behavior, cancellation, turn/output limits, failure propagation, private artifacts and disposal. The parent waits, then decides the next step. No nested team is required for task alignment.

Timeouts in an in-process runner are cooperative, not a guaranteed process kill. A subprocess is justified if hard termination, untrusted executable code, remote execution or crash isolation becomes a requirement. It would also require preserving the parent authorization boundary across IPC; a process boundary alone is not a sandbox.

Keep mechanical completion distinct from task success, approval and execution verification. Evidence references make a result reviewable, not automatically true.

## What this means for the current extension

| Keep | Add/change next | Defer |
|---|---|---|
| Explicit SDK resource loader; fresh child; all-tools parent bridge; temporary auth inheritance; limits and private artifacts | Bounded task-query profile search | Embeddings/vector database and autonomous routing service |
| Existing profile files and two repair profiles | Domain-neutral runner description: task/scope/evidence, not mandatory site/environment | Automatic profile generation, editing or remote installation |
| Revalidation and clear errors | Catalog provenance, duplicate/invalid-profile handling and unavailable-tool reporting | Project overrides, multiple precedence layers, inheritance trees |
| Awaited one-child operation | An operator catalog directory when profiles need independent installation | Background jobs, agent messaging, recursion, queues and dashboards |
| Explicit repair approval boundary | Evaluate retrieval with more than one domain of task | Guarded repair executor until separately authorized and designed |

The database profiles remain useful unchanged as one family in the catalog. A generic runner does not need a schema-repair abstraction, site field or SQL workflow of its own.

## Adoption decision

**Recommendation: continue the small custom adapter for this scope.** It already has the parent-tool boundary we need, 27 local E2E scenarios and a limited live read-only integration check. Those are local evidence, not proof of production-scale reliability.

Championswimmer is the closest source for our SDK/auth/bridge patterns, but adopting it changes context, built-in-tool and lifecycle semantics. Nicobailon has a public delegation API worth evaluating if workflows/background management become requirements. Neither removes the need for task search over our trusted roles.

This recommendation should change if maintaining the Pi SDK adapter becomes more work than a suitable public package integration. Do not fork a large runner merely to avoid writing a small search function.

## Next acceptance checks — not implemented yet

- [ ] A parent can search using a task description without already knowing a profile ID.
- [ ] At least three distinct task families retrieve appropriate roles; include ambiguous and no-match tasks.
- [ ] Search returns bounded metadata, not every profile's full instruction body.
- [ ] Missing tools, invalid profiles and duplicate IDs are visible and cannot broaden authority.
- [ ] Known-role direct execution remains supported; search has no launch side effects.
- [ ] Domain-neutral runner guidance leaves case-specific requirements inside profiles.
- [ ] New catalog/search work preserves existing permission, redaction, auth and isolation regression tests.

## Primary sources

- **C1** [Codex role specification/resolution, rust-v0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/agent/role.rs).
- **C2** [Codex MultiAgentV2 spawn/history parser, rust-v0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L263).
- **C3** [Codex child configuration/runtime permission inheritance, rust-v0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/agent/child_config.rs#L46).
- **P1** [Pi subagent example, v0.99.2](https://github.com/earendil-works/pi/tree/v0.99.2/packages/coding-agent/examples/extensions/subagent), especially `agents.ts` and `runSingleAgent` in `index.ts`.
- **P2** [Pi explicit SDK resource/session example, v0.99.2](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/examples/sdk/12-full-control.ts).
- **P3** [Pi session nested-tool execution pipeline, v0.99.2](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/agent-session.ts#L576).
- **M1** [Manager inherited-tool bridge, v0.17.0](https://github.com/championswimmer/pi-subagent-manager/blob/v0.17.0/src/orch/inherited-tools.ts).
- **M2** [Manager SDK/model/auth and local-tool construction, v0.17.0](https://github.com/championswimmer/pi-subagent-manager/blob/v0.17.0/src/orch/runtime.ts#L322).
- **M3** [Manager discovery/spawn and report-only timeout contract, v0.17.0](https://github.com/championswimmer/pi-subagent-manager/blob/v0.17.0/src/orch/tools.ts#L40).
- **M4** [Manager tool-inheritance regression tests, v0.17.0](https://github.com/championswimmer/pi-subagent-manager/blob/v0.17.0/tests/tool-inheritance.test.ts) and [inheritance fix PR #9](https://github.com/championswimmer/pi-subagent-manager/pull/9).
- **N1** [Nicobailon child-session construction, v0.76.1](https://github.com/nicobailon/pi-subagents/blob/v0.76.1/src/runs/shared/child-session.ts).
- **N2** [Nicobailon public delegation/capability API, v0.76.1](https://github.com/nicobailon/pi-subagents/blob/v0.76.1/docs/extension-api.md#structured-delegation-api) and [tool reference](https://github.com/nicobailon/pi-subagents/blob/v0.76.1/docs/tool-reference.md).
- **N3** [Nicobailon published regressions and fixes, v0.76.1 changelog](https://github.com/nicobailon/pi-subagents/blob/v0.76.1/CHANGELOG.md), including issues #2274, #2289 and #2321.
- **O1** [OpenClaw subagent tool reference](https://docs.openclaw.ai/tools/subagents/tool-reference) (current docs; policy conclusions above use tagged code).
- **O2** [OpenClaw policy implementation, v2026.9.8](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/agents/agent-tools.policy.ts#L59) and [tagged policy documentation](https://github.com/openclaw/openclaw/blob/v2026.9.8/docs/tools/subagents/tool-policy.md).
- **O3** [OpenClaw policy matcher/empty-list semantics, v2026.9.8](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/agents/tool-policy-match.ts#L29).
- **T1** [T3 architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md), [provider boundaries](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md) and [outside-agent interface](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md) (moving `main`).
