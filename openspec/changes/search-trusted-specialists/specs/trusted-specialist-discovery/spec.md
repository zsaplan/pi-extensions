## Purpose

Help a parent Pi agent discover a suitable trusted specialist for a bounded task without expanding authority or treating agent completion as verified task success.

## ADDED Requirements

### Requirement: Bounded task-based discovery

The system SHALL expose `profile_subagent_search({query, limit?})` over bundled profile IDs, descriptions, and optional tags. It SHALL accept a nonblank query of at most 2,048 characters and an integer limit from 1 through 5, defaulting to 3. Results SHALL be deterministically ranked and contain only positively matching, valid candidates.

#### Scenario: Discover a role without knowing its ID
- **WHEN** a parent searches with a task description matching a bundled specialist
- **THEN** the result contains at most the requested number of ranked candidates
- **AND** each candidate identifies its ID, description, matched metadata terms, bundled source, content digest, required tools, and tools currently unavailable to the parent
- **AND** results do not expose complete role instructions, skill bodies, or credentials

#### Scenario: Invalid or unmatched query
- **WHEN** input is blank, too long, or has an invalid limit
- **THEN** the tool returns an explicit input error without launching a child
- **WHEN** a valid query has no positive metadata matches
- **THEN** it returns an empty candidate list, not a default worker

#### Scenario: Repeated queries and bounded diagnostics
- **WHEN** the same query runs against unchanged catalog content and parent tool availability
- **THEN** candidate ordering is stable
- **AND** the complete result is bounded to 24,000 characters, with any omitted diagnostics or candidates explicitly reported

### Requirement: Trusted catalog and visible definition failures

The system SHALL discover profiles only from its bundled registry in this increment. Invalid, conflicting, or escaping definitions SHALL NOT become runnable candidates. One invalid definition SHALL NOT hide unrelated valid candidates; errors SHALL be reported as bounded diagnostics. Failure to read the registry itself SHALL be an error, not a claim that no specialist matches.

#### Scenario: Invalid definitions alongside valid profiles
- **WHEN** the registry includes a malformed manifest, missing resource, escaping resource path, or duplicate declared ID
- **THEN** search reports the affected definitions and excludes them from candidates
- **AND** all definitions for a conflicting ID are excluded rather than selecting one by precedence
- **AND** unrelated valid matches remain discoverable

#### Scenario: Untrusted profile request
- **WHEN** a project directory, remote URL, generated manifest, or arbitrary profile path is offered as a role source
- **THEN** search and execution do not register or load it as a profile
- **AND** an unknown requested ID fails without substituting another role

### Requirement: Search is advisory and side-effect free

Search SHALL NOT run a model, start a child, invoke domain tools, test database connectivity, install a profile, or change tool availability. General delegation guidance SHALL instruct the parent to choose based on role fit and available capabilities, ask for clarification when task intent is insufficient, and decline delegation when no suitable role exists. Ranking SHALL NOT be represented as confidence or authorization.

#### Scenario: Ambiguous or unsupported task
- **WHEN** the task does not identify a suitable role, even if words match catalog metadata
- **THEN** parent guidance calls for clarification or no delegation rather than automatic highest-ranked execution
- **AND** search itself makes no selection or execution side effect

#### Scenario: Relevant but unavailable role
- **WHEN** a matching profile requires a tool the parent cannot currently call
- **THEN** search shows the role and the unavailable tool names
- **AND** it does not enable those tools or claim credentials or connectivity have been verified

### Requirement: Direct execution remains supported and revalidates authority

`profile_subagent_run({profile, task})` SHALL continue accepting a trusted ID without a prior search. Before any child model request it SHALL validate the selected definition, its resources, and every required tool against the parent's current callable tools. Search results SHALL NOT serve as an execution grant or frozen profile snapshot. Existing `profile_subagent_list` SHALL remain available.

#### Scenario: A known role runs directly
- **WHEN** the parent requests a valid, available role by ID without first searching
- **THEN** the runner starts the same bounded fresh-session workflow as a searched role

#### Scenario: Catalog or capabilities change after search
- **WHEN** a previously returned profile is changed or a required tool becomes unavailable before execution
- **THEN** execution validates the current definition and current tools
- **AND** an invalid definition or unavailable required tool fails before a child model request
- **AND** a valid changed definition is identified by its actual executed digest in run evidence, not the prior search digest

### Requirement: Discovery does not broaden child authority

Every selected child tool SHALL continue executing through the parent's permission and result-processing hooks, including file tools. Missing tools SHALL NOT be replaced by child-local implementations. Leaf profiles SHALL NOT expose recursive delegation or broad dispatchers that can reach the parent's larger tool inventory.

#### Scenario: Parent denial and redaction survive delegation
- **WHEN** the child attempts an allowlisted file or domain tool call which parent policy denies
- **THEN** the call is denied through the parent execution path
- **AND** permitted results retain parent result redaction before reaching child context or saved transcripts

#### Scenario: A profile requests orchestration or a disabled tool
- **WHEN** a profile selects recursive profile tools, a broad dispatcher such as `codemode`, or a required tool disabled in the parent
- **THEN** startup rejects the profile or unavailable capability before model execution
- **AND** it does not activate tools or provide a broader fallback

### Requirement: Fresh assignments and evidence remain explicit

Selected specialists SHALL receive only their explicit profile resources and a self-contained assignment, not parent conversation history or ambient project instructions and extensions. Shared tool guidance SHALL use task, scope, evidence, and expected outcome rather than requiring site/environment fields for every domain. Domain requirements SHALL remain in the relevant profiles.

#### Scenario: Configuration or documentation work
- **WHEN** a parent delegates configuration comparison or documentation consistency review
- **THEN** no unrelated site or database requirement is imposed by the runner
- **AND** the child has only its declared file-read tools and explicit assignment context

#### Scenario: Missing evidence
- **WHEN** the assignment lacks evidence necessary for its requested conclusion
- **THEN** profile guidance requires the child to identify the missing evidence and leave the conclusion unresolved
- **AND** it does not claim that unperformed checks passed

### Requirement: Independent child model default

Children SHALL use `openai-codex/gpt-6.1-sol` with medium thinking independently of the parent's selected model/thinking. Missing models, incompatible thinking settings, or authentication failures SHALL be reported without switching to the parent model. Parent tool permissions SHALL remain unchanged. Credentials SHALL be resolved for the child provider, never copied from an unrelated parent provider.

#### Scenario: Different parent model and reasoning
- **WHEN** the parent delegates while using a different model or thinking level
- **THEN** the child still uses the specified Sol model and medium thinking
- **AND** input evidence records parent and child settings separately, and results identify child settings

#### Scenario: Selected child model cannot run
- **WHEN** the child model is absent, cannot support medium thinking, or cannot authenticate
- **THEN** delegation fails visibly without a fallback model or an unrelated provider key

### Requirement: Mechanical completion is not approval or task correctness

The discovery-to-run path SHALL preserve bounded outputs, private evidence artifacts, executed profile digest, actual tools, usage, and explicit failure/cancellation/limit reporting. A completed run SHALL NOT be described as proof of correct reasoning, verified repair, or human authorization.

#### Scenario: Failure versus unresolved analysis
- **WHEN** execution encounters a provider failure, cancellation, exceeded limit, or incomplete final response
- **THEN** the runner reports failure rather than a completed task
- **WHEN** a complete response says a required check remains unresolved
- **THEN** the parent can distinguish mechanical completion from that unresolved substantive outcome

#### Scenario: Result exceeds the inline budget
- **WHEN** a completed report is longer than the existing inline result limit
- **THEN** the parent receives bounded output and a reference to the complete private artifact
- **AND** no transcript is published externally
