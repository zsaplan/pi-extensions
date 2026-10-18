# Build the task assistant from a Git checkout

The repository contains both application and researcher source. No frozen directory from another
Mac, global Pi executable or developer dependency symlink is needed. Use a reviewed commit/tag,
not a moving main branch. Native arm64 macOS, Node **26.10.0** and npm **11.19.1** are the qualified pair.
See [INSTALL.md](INSTALL.md) for clone → build → paused install, local login and explicit service controls.
Publication of a source ref and permission to start a service are separate decisions.

## Build

From a clean repository checkout:

```sh
npm ci --ignore-scripts
OUT="$(mktemp -d "$HOME/task-assistant-release.XXXXXX")"
npm run release --workspace task-assistant -- --out "$OUT"
```

The builder compiles both packages with the locked local TypeScript compiler into new private
scratch directories. It never consumes checkout dist files or old incremental caches. It verifies
all researcher source inputs against `research-build.json`, then every shipped researcher runtime
and profile byte against `research-source.json`. Both reference the qualified researcher revision.
The root build lock and compiler/runtime versions are pinned; changes require deliberate review
and requalification, not automatic hash regeneration. Application and researcher runtime installs
remain separate: parent SDK/CLI 1.1.0 and researcher SDK/CLI 0.99.2.

Only runtime JavaScript, package/profile files, standalone locks and install/configuration docs
are shipped. Source maps, declarations, build caches, tests, operational records, credentials and
node_modules are excluded. Omitting non-runtime build metadata changes the new release inventory;
it does **not** authorize rebinding old task research history. [MIGRATION.md](MIGRATION.md) still applies.

`release.json` records source commit/tree/snapshot identity, compiler/build-lock identity,
researcher source and runtime fingerprints, SDK/runtime versions, runtime dependency versions and
payload hashes. The adjacent `.sha256` identifies the archive. Tar metadata and gzip timestamps
are normalized. Hashes are integrity checks, not signatures; use trusted source/transfer channels.
The builder rejects a dirty tree unless `--allow-dirty yes` explicitly requests a development
snapshot. It also checks that source did not change during the build. Failed scratch directories
are retained for inspection. Builds do not access credentials, Slack, models or launchctl.

## Verify

From the repository root, run the package contract, then the repository contract:

```sh
npm run verify --workspace task-assistant
npm run verify
```

After committing, validate the complete source-install path:

```sh
npm run test:source-install --workspace task-assistant -- --npm-cli "$(command -v npm)"
```

This makes a separate single-branch Git clone with no shared objects, isolated HOME and controlled
PATH; installs locked build dependencies; poisons ignored dist output; and builds twice. It checks
byte-identical archives and rejects modified/extra researcher source and a modified build lock.
It then runs the actual archive installer and task/session/restart, native dual-SDK research and
paused-service E2E. Spaces in paths are intentional. Only public npm downloads and synthetic
Slack/GitHub/model transports are used. Reports and failures remain in private temporary directories.
The driver clones the current clean local HEAD, so unpublished local commits can be tested without
pushing or exposing another branch's private history. It does not prove remote publication.

For a previously built archive, the narrower check remains available:

```sh
node task-assistant/packaging/test-install.mjs --archive /absolute/release.tgz --npm-cli "$(command -v npm)"
```

The checks do not qualify target-host login/refresh, live permissions, notifications, FileVault,
power/sleep behavior, sustained operation or account policy. Fresh installation does not create
onboarding approval/history, and stateful relocation is not automated.
