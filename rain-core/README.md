# rain-core

Shared deterministic knowledge-base utilities for the Rain pi extensions.

See also: `./CODEBASE.md` for the intended logical boundary of this package.

## Current scope

- KB root resolution
- markdown file discovery
- safe root-relative path handling
- fact normalization helpers
- lightweight dedupe candidate generation for exact and near-duplicate fact bullets
- strict structured fact parsing for canonical Rain fact files
- strict fact-file and KB-root linting for canonical Rain fact files
- standalone semantic cleanup linting for structurally valid fact files

## Canonical structured fact format

`rain-core` now exposes the strict canonical Rain fact-file contract as library APIs.

Valid files use:

```md
# PI / WORKFLOW

- PREFERS | pi install . | when=installing from source | scope=repo root
- AVOIDS | per-extension install | because=shared rain-core imports can break
```

Rules:

- filename must match `SUBJECT__TOPIC.md`
- first non-blank line must be exactly `# SUBJECT / TOPIC`
- every remaining non-blank line must be a structured fact bullet
- bullets must use `- RELATION | OBJECT | key=value | key=value`
- relation names are validated against the centralized allowed relation set
- legacy freeform bullets are lint errors under this contract

Initial built-in relations:

- `DEFINES`
- `USES`
- `REQUIRES`
- `PREFERS`
- `AVOIDS`
- `LOCATED_AT`
- `FIXES`
- `CAUSES`

Invalid examples:

```md
# PI / WORKFLOW

- pi install . when installing from source
- prefers | pi install .
- PREFERS | pi install . | Scope=repo root
This prose paragraph is not allowed.
```

## Public APIs

Structured fact parsing and rendering:

- `parseStructuredFactBulletText()`
- `parseStructuredFactLine()`
- `parseStructuredFactFileContent()`
- `renderStructuredFactBullet()`
- `renderStructuredFactLine()`
- `DEFAULT_FACT_RELATIONS`
- `STRUCTURED_FACT_SYNTAX_GUIDANCE`

Linting:

- `lintFactFileContent()`
- `lintKnowledgeBase()`
- `lintFactFileSemanticCleanup()`
- `lintKnowledgeBaseSemanticCleanup()`

## Semantic cleanup lint

`rain-core` also exposes a second-pass semantic cleanup linter for structurally valid files.

This pass is warning-only. It does not replace structural lint. It highlights `DEFINES` bullets that look semantically degraded after migration, such as:

```md
- DEFINES | BriteAuth uses Amazon Cognito for sign-up and sign-in
- DEFINES | The minimal structured bullet grammar is RELATION / OBJECT / key=value / key=value
```

Current warning families:

- `RELATION_REFINEMENT_CANDIDATE`
  - suggests `USES`, `REQUIRES`, or `LOCATED_AT` when a `DEFINES` object already contains one of those stronger semantics
- `GRAMMAR_LITERAL_ARTIFACT`
  - flags migrated grammar-literal objects like `RELATION / OBJECT / key=value / key=value`

File-level semantic results include `analysisStatus`:

- `"analyzed"` when semantic cleanup rules ran
- `"skipped-structurally-invalid"` when structural errors prevented semantic analysis

Use structural lint first when you need syntax enforcement. Use semantic cleanup lint when you want a progressive cleanup queue for otherwise valid fact files.

Legacy generic bullet helpers in `src/facts.ts` still exist for current consumers, but the strict canonical Rain fact format is the structured contract above.
