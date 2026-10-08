# Search and delegate to a trusted specialist

## Why

The existing runner can execute a known profile, but the parent must already know which specialist to choose. Add task-based discovery without replacing the tested runner or weakening its permission boundary, and test whether narrow specialists work beyond the initial postfix use case.

## What Changes

- Add `profile_subagent_search({query, limit?})` over bundled, trusted profile metadata, returning bounded candidates with match explanations, provenance, content digest, and required-tool availability.
- Keep selection with the parent: search never launches a child, manufactures a profile, or substitutes an unrestricted worker.
- Preserve `profile_subagent_list` and direct named `profile_subagent_run`; make general tool guidance domain-neutral.
- Add two reviewed, file-read-only roles for configuration drift and documentation consistency. Alongside postfix planning/review, these provide three distinct task families.
- Exercise invalid definitions, unavailable tools, fresh-context handoff, permission inheritance, and honest outcome reporting.
- Evaluate retrieval, real parent selection/abstention, and bounded task quality separately from deterministic integration tests.

## Capabilities

### New Capabilities

- `trusted-specialist-discovery`: Bounded task search of a trusted catalog and explicit parent selection, with execution-boundary acceptance scenarios.

### Modified Capabilities

None. No main OpenSpec specifications exist yet. Existing runner guarantees are acceptance constraints on this new discovery path, not a claim that the runner is being implemented from scratch.

## Impact

Implementation is limited to `profile-subagent/`: profile metadata/loading, tool registration, two role definitions, E2E/evaluation fixtures, and documentation. No new runtime dependency is planned. OpenSpec's generated Pi skills/prompts are repository development resources, not child-agent resources.

The default catalog remains bundled. An operator-owned catalog directory, remote installation, generated profiles, embeddings, model router, background agents, recursion, and repair execution are out of scope. No production repair or external write is authorized by this proposal.

## References

- [Current runner and validation evidence](../../../profile-subagent/DESIGN.md)
- [Research and architecture rationale](../../../profile-subagent/RESEARCH.md)
- [Implementation choices and evaluation gates](design.md)
- [Implementation and acceptance checklist](tasks.md)

The discovery increment and all H1–H4 pilot gates passed, including two real-model sweeps with Sol/medium children. See tasks.md for the completed evidence, preserved earlier provider failures, and remaining production-integration limitations. The change is ready for sync/archive; neither has been performed.
