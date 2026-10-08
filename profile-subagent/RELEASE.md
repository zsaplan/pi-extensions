# Initial rollout readiness

## Release decision

Suitable for an initial rollout of **optional, read-only specialist delegation**, subject to review and operator approval of installation. This is not a repair executor, an OS sandbox, a universal performance guarantee, or authorization to make application/database changes.

The runtime has tested authority, authentication, isolation, cancellation, concurrency and accounting safeguards. In the latest live shared-context A/B trial, the parent independently chose one combined investigator and verified its evidence; time fell 34.1%, total reported cost 19.9%, and peak parent input 38.0%. Core conclusions agreed, but secondary coverage differed. See [DELEGATION.md](DELEGATION.md) for evidence and remaining uncertainty. Repeated and different-context comparisons remain future work, not claims made by this release.

## Installation contract

- Validated with **Pi 0.99.2 / Node 26.10.0 on macOS**. Other platforms/Pi versions have not been validated against these SDK and nested-accounting APIs.
- Children require **`openai-codex/gpt-6.1-sol`, medium thinking** and working credentials for that provider. There is no model fallback. The parent may use a different model/provider.
- All five profiles require callable **`read`, `grep`, `find`, `ls`**. Stock Pi enables only `read`, `bash`, `edit`, `write`; installing this extension alone does not enable the other three tools.
- The two file-only profiles work without BriteCore integrations. Postfix profiles additionally require the three approved `bc_site_db_*` tools listed in [README.md](README.md#tools). Missing tools make those profiles unavailable; do not enable broader substitutes.
- Codemode is optional. Direct calls work without it. Its three-child limit is per loaded extension/Pi process, not a machine-wide budget.
- The catalog is bundled and reviewed with the code. No operator/project profile directory, child-local codemode or recursive delegation is enabled.

## Install after merge

For an existing local checkout, update it to the reviewed revision and install dependencies using the repository's normal workflow. `pi install` with a local path records that path; it does not copy the package or install its dependencies.

If your existing setup loads extensions individually, install **only the new individual package** from a reviewed checkout:

```bash
# After the approved branch is merged and the main checkout is updated:
cd /path/to/pi-extensions
npm ci
pi install ./profile-subagent
```

When using individual package installations, do **not** also install the entire repository just to add this feature; that can load the same tools through both root and individual package paths. Do not retain the experimental worktree's extension path alongside the installed main-checkout package.

Merge the following additions into the existing `defaultTools` setting, preserving all other configuration. These are operator-approved settings changes, not changes made automatically by the extension:

```json
{
  "defaultTools": ["+grep", "+find", "+ls"]
}
```

This is an additive example, not permission to overwrite existing settings. Preserve your existing selection, including `+codemode` if already enabled; codemode is optional. A restrictive project setting or `--tools` invocation can still disable prerequisites. The extension never activates missing tools itself.

Restart Pi after installation/configuration changes. Substitute your reviewed checkout path and ensure the fixed child model and any desired domain integrations are available. This package is not claimed to be published to npm.

## Acceptance in a normal session

1. List/search the catalog. Confirm five profiles and that file-only profiles report no unavailable tools. Postfix profiles may correctly be unavailable without their integrations.
2. Confirm there are no duplicate tool or extension-load warnings.
3. Check child-provider authentication without printing credentials:
   `pi auth check --provider openai-codex --json --no-refresh`.
   Provider authentication alone does not establish model availability.
4. Assign one small, non-sensitive documentation or configuration comparison. Let the parent choose whether delegation is warranted; for a mechanical smoke check, explicitly label the request to run a named specialist as a diagnostic.
5. If a child runs, confirm the fixed model, bounded tool set, evidence-backed report, retained uncertainty and private artifact location. A completed run is not correctness or further-action approval.
6. Compare against direct work when evaluating usefulness. Do not turn optional delegation into a requirement to create children on every task.

Step 4 makes a real model request and needs the operator's test request/approval. No production DB or endpoint is needed for this initial installed-session check.

## Rollback and retained evidence

For an individually installed local package:

```bash
pi remove /path/to/pi-extensions/profile-subagent
```

Restart Pi, or use `--exclude-tools profile_subagent_search,profile_subagent_list,profile_subagent_run` for one invocation. If using a root package installation instead, disable this extension through `pi config`; do not remove unrelated extensions to roll back this one.

Restore only configuration additions made for this rollout if desired, preserving pre-existing tools such as codemode. Removing the package does not remove its local source or private child artifacts under `~/.pi/agent/profile-subagent-runs/`. Artifacts can contain sensitive evidence; no automated retention cleanup is provided. Inspect before any separately authorized deletion.

## Readiness and outstanding work

- [x] Live autonomous shared-context trial reviewed, with exact parent-plus-child accounting and coverage limitations.
- [x] Clean dependency installation from the public npm registry in an isolated copy, without borrowed dependency links.
- [x] Full repository validation on the clean copy.
- [x] Actual packed package contains all five profiles and their instructions; private evidence, tests and dependencies are excluded from the standalone tarball.
- [x] Isolated real Pi install/load: default missing tools reported, additive configuration enables file-only delegation, missing DB integration stays unavailable, scripted DB-role delegation completes, removal unregisters the package without deleting source.
- [x] Public-release scope approved: publish the runner, reusable profiles and sanitized summaries; preserve operational targets, database findings, session references and original evidence privately.
- [x] Public-content and standalone/root-package scans passed. Root packaging explicitly excludes all workspace temporary evidence; the lifecycle test guards this with a private fixture.
- [x] Independent read-only review of the full main-relative change found no material defects. This was static review, not a replacement for runtime tests or production acceptance.
- [ ] Approved merge and installation into the normal operator environment.
- [ ] Normal installed-session acceptance above; isolated scripted transport does not replace this.

Repeat with the repository's package/root verification commands. `test/install-e2e.test.ts` uses the actual Pi CLI, a packed/extracted package outside the checkout, a private temporary agent directory and scripted model/DB transport; generated `tmp/e2e/install-evidence.json` identifies its retained run and success flag. Clean-copy logs, hashes and full operational evidence are retained privately, not shipped. These checks do not make live model/DB requests or modify normal agent settings.

The first packaging-test assertion assumed Pi stored an absolute package source; it now correctly resolves relative sources from the settings directory. An initial formatter invocation lacked the local executable PATH. Both failures are preserved privately; neither was a runtime defect.

A pre-publication root-package dry run exposed ignored temporary evidence in the archive file list. No affected archive was published. Explicit root-package exclusions now prevent this, and the lifecycle E2E checks both packaging paths. The standalone package was already excluding that evidence. Original failure evidence remains private.

Clean installation removes the earlier dependency-symlink uncertainty. Production repair/application acceptance, general live SQL compatibility, operator-owned catalogs, child-local codemode, recursion and OpenSpec sync/archive remain outside this release.
