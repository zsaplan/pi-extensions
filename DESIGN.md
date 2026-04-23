# pi-extensions Design

## Purpose

This document defines the **repo-level design** for `pi-extensions`.

It describes how the repository should be structured, how packages should relate to each other, and how shared development and validation workflows should work.

It does **not** define the internal design of any individual extension. Package-specific intent, behavior, UI, runtime policy, and extension-local validation details belong in package-local documentation such as `README.md`, `DESIGN.md`, or `CODEBASE.md` within that package.

---

## Problem statement

The repository already contains multiple distinct packages, but some important concerns are still driven primarily from the repo root:

- validation is only partially package-local
- some packages are not validated at all by the current root workflow
- package-specific build and verification logic leaks into the root `package.json`
- some shared code is consumed through repo-relative source imports rather than explicit package dependencies
- the root currently acts as both an aggregate install surface and the main implementation surface for cross-package workflows

This creates unnecessary coupling and makes it harder to treat each extension as an independently understandable, independently verifiable unit.

---

## Design goals

### 1. Package autonomy

Each package should be understandable, installable, runnable, and verifiable with minimal knowledge of the rest of the repo.

### 2. Consistent external contract

Every package should expose a small, predictable set of top-level development contracts, especially a package-local `npm run verify`.

### 3. Root as orchestrator, not owner

The repo root should coordinate package workflows, not encode package-specific build rules.

### 4. Explicit dependency boundaries

Code shared across packages should cross package boundaries through declared dependencies and public APIs, not via repo-relative `src/` imports.

### 5. Progressive migration

The repo should be able to move toward this model incrementally without requiring a large one-shot rewrite.

### 6. Simple, durable operational model

The default workflows should stay lightweight and easy to maintain. The repo should prefer the simplest structure that gives clear package ownership, reliable verification, and room to scale.

---

## Non-goals

This design does not attempt to:

- define the internal architecture of any individual extension
- force every package to use identical internal tooling or scripts beyond shared external contracts
- require a heavy monorepo framework when npm workspaces and package-local contracts are sufficient
- solve publishing/release automation in full detail before the package boundary model is corrected
- centralize extension-specific runtime design at the repo root

---

## Architectural model

## Repository model

The repository should behave as a **workspace-style monorepo** containing multiple package types:

1. **Extension packages**
   - packages whose primary responsibility is registering Pi extensions, tools, commands, or skills
2. **Shared library packages**
   - packages that provide deterministic reusable functionality consumed by extensions
3. **Aggregate root package**
   - the repo root may continue to provide an optional aggregate install/load surface for convenience, but it should not own package-specific implementation details

The root should remain a convenient entrypoint for whole-repo workflows while each package remains the source of truth for its own behavior and validation.

## Package boundary model

Each package is responsible for:

- its own manifest
- its own runtime entrypoints
- its own dependency declarations
- its own build and generated artifact rules
- its own validation contract
- its own package-local documentation

The root is responsible for:

- workspace discovery and orchestration
- shared tooling baselines where useful
- aggregate developer workflows
- optional aggregate install/load behavior
- repo-level documentation such as this file

---

## Package contracts

## Required package contract

Every package in the repo should eventually provide:

- a `package.json`
- a clearly defined public entry surface
- a package-local `npm run verify`
- enough local configuration to run that verification without depending on root-specific hardcoded package paths
- a package-local README describing what the package is for

`verify` is the key shared contract. It is the one command the root should be able to rely on consistently across packages.

## Optional package-local scripts

Packages may also expose other scripts as appropriate, such as:

- `lint`
- `typecheck`
- `test`
- `build`
- `fix`
- `check:artifacts`
- `pack:check`

Not every package needs the same internal scripts, but every package should own its own implementation of whatever `verify` requires.

## Meaning of `verify`

For a package, `npm run verify` should mean:

> run the smallest complete set of checks needed to have reasonable confidence that this package is valid in its intended form

That may differ by package type:

- a small extension may only need linting and typechecking
- a shared library may need linting, typechecking, and tests
- a build/artifact-producing package may also need a build step and generated artifact checks

The root should not need to know those details.

---

## Validation model

## Package-owned verification

Validation should move toward a package-owned model:

- package-specific validation logic lives in the package
- package-specific build steps live in the package
- package-specific generated artifact checks live in the package
- package-specific test suites live in the package

## Root-owned aggregation

The repo root should offer aggregate workflows such as:

- verify all packages
- lint all packages
- typecheck all packages
- run targeted package verification

Those root commands should be thin orchestration over package-local contracts rather than bespoke root implementations of package internals.

## Validation consistency rules

Repo-level consistency should come from these rules:

1. every package must define `verify`
2. root verification must fan out to package verification rather than duplicate package logic
3. a green root verify should mean the repo packages included in the workspace contract are green by their own standards
4. package onboarding is complete only when the package has joined the same contract shape as its peers

---

## Dependency boundary model

## Explicit package dependencies

When one package depends on another package in this repo, that dependency should be expressed as a declared package dependency, not as a cross-package source import.

Desired rule:

- **allowed**: import from a sibling package's declared public package entrypoint
- **not allowed**: import from another package's `src/` tree using repo-relative paths

## Public API boundaries

Shared packages should expose deliberate public APIs. Consumers should depend on those APIs rather than internal file layout.

This ensures:

- package behavior is less coupled to repo structure
- package tarballs and installs are more truthful
- validation can happen at the correct boundary
- packages can evolve internally without breaking consumers that rely only on public exports

## Shared code policy

Code should move into a shared package only when it is:

- genuinely reusable
- deterministic or stable enough to benefit multiple packages
- clearer as a shared dependency than as duplicated package-local logic

Shared packages should stay small and focused. Root-level convenience should not become an excuse to create an oversized shared utility layer.

---

## Tooling and configuration model

## Shared defaults, local ownership

The repo may provide shared tooling baselines such as:

- workspace configuration
- shared TypeScript base config
- shared lint baseline
- shared formatting conventions

But package-specific configuration should remain package-local when package needs diverge.

The design principle is:

- use shared defaults where they reduce repetition
- keep overrides local where package behavior or runtime shape is meaningfully different

## Generated artifacts

Generated artifacts should be owned by the package that produces them.

That means:

- generation scripts live with the package
- artifact validation lives with the package
- root workflows may invoke package verification, but should not directly encode artifact-specific commands for one package

---

## Installation and execution model

## Individual package use

A package should be usable as a package, not only as a folder inside this repo.

That implies:

- package dependencies must be resolvable through normal package management boundaries
- package verification should run from the package contract rather than through root-specific hardcoded logic
- package behavior should not silently depend on sibling source trees being imported directly

## Aggregate root use

The root may continue to provide an aggregate install/load experience for convenience, including whole-repo workflows such as `pi install .` or repo-root development commands.

However, aggregate convenience should sit on top of package autonomy, not replace it.

The root should be a convenience surface, not a hidden requirement for normal package correctness.

---

## Documentation model

## Root documentation

Root-level documentation should cover only cross-package concerns, such as:

- repo structure
- package taxonomy
- workspace and orchestration model
- dependency boundary rules
- shared validation contracts
- aggregate development workflows
- migration strategy

## Package-local documentation

Package-local documentation should own:

- package purpose and scope
- runtime behavior
- commands and tools
- internal architecture
- generated artifacts specific to that package
- package-specific validation details
- package-specific design decisions and tradeoffs

If a package has meaningful internal architectural boundaries, it should carry its own `DESIGN.md` or `CODEBASE.md`.

This keeps the root design document focused and prevents it from turning into a mixed repository-plus-extension encyclopedia.

---

## Package classes

This repo should support multiple package classes under one consistent contract.

## 1. Extension package

Typical characteristics:

- registers Pi capabilities
- may have minimal or no build step
- usually needs linting and typechecking
- may have package-local tests depending on complexity

## 2. Shared library package

Typical characteristics:

- exposes deterministic reusable APIs
- should usually be directly unit tested
- should define a stable public entry surface
- should not absorb orchestration or policy that belongs in consuming extensions

## 3. Build/artifact-producing package

Typical characteristics:

- has generated runtime assets or compiled resources
- needs package-local build and artifact checks
- may have stricter packaging validation than simpler packages

These classes do not require different root policies. They only affect what each package's own `verify` needs to do.

---

## Migration strategy

The migration should be progressive.

## Phase 1: normalize contracts

- add or normalize package-local `verify` scripts
- add missing package-local config needed to run those scripts
- move package-specific validation logic out of the root and into the owning packages
- reduce the root to orchestration over package contracts

## Phase 2: correct dependency boundaries

- replace cross-package source imports with explicit package dependencies
- define stable public entry surfaces for shared packages
- ensure package packaging/install behavior matches the dependency graph

## Phase 3: simplify root responsibilities

- minimize duplicated metadata between root and package manifests where possible
- keep root aggregate behavior only where it provides real convenience
- ensure the root no longer serves as the hidden implementation surface for child packages

Progress through these phases should be incremental and keep the repo usable at each step.

---

## Success criteria

This design is working when the following are true:

1. every package exposes `npm run verify`
2. repo-root verification is an orchestration layer over package-local verification
3. package-specific build logic is no longer hardcoded in the root
4. shared code crosses package boundaries through declared dependencies and public APIs
5. a package can be reasoned about mostly from its own directory and docs
6. root docs stay focused on repo-wide concerns
7. extension-specific design lives with the extension, not in this file

---

## Open design questions

The following decisions are intentionally left open for implementation-time refinement:

- the exact workspace configuration details used to orchestrate package scripts
- the exact versioning and release strategy across packages
- whether aggregate root install behavior should remain at the root long-term or move to a dedicated aggregate package later
- how much shared tooling config should live at the root versus a dedicated internal tooling package
- whether package-level `pack` smoke checks should be required everywhere or only for selected packages

These questions should be resolved in implementation without violating the higher-level design principles in this document.

---

## Summary

The intended direction for `pi-extensions` is:

- **package-owned behavior and verification**
- **root-owned orchestration**
- **explicit dependency boundaries**
- **progressive migration instead of a rewrite**
- **repo-level documentation at the root and package-level design in package-local docs**

That model gives the repo a more modular, scalable, and maintainable foundation without losing the convenience of whole-repo workflows.