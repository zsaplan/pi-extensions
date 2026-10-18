# Build and validate a private Mac release

Run from the repository root on native arm64 macOS, Node 26.10.0/npm 11.19.1.
Install development dependencies with npm ci in a separate development worktree, never in live snapshots.

```sh
npm run verify --workspace task-assistant
npm run verify
node task-assistant/packaging/build-release.mjs \\
  --researcher-dir /absolute/path/to/verified/frozen/profile-subagent \\
  --out /absolute/private/release-output
node task-assistant/packaging/test-install.mjs \\
  --archive /absolute/private/release-output/task-assistant-RELEASE-darwin-arm64.tgz \\
  --npm-cli "$(command -v npm)"
```

research-source.json fixes the exact original compiled/profile/package bytes; it contains no auth or
state paths. The builder accepts only those bytes, not an arbitrary researcher upgrade. The two
standalone dependency locks were resolved with exact SDK/direct versions, then npm ci verifies
registry integrity. They are separate from the old monorepo locks; do not claim all transitive
versions are identical to an earlier live snapshot. Changes require this same qualification again.

The builder defaults to a clean committed tree. For pre-commit validation only, --allow-dirty yes
records dirty=true and a source snapshot hash, and labels the archive as a snapshot. It checks the
source hash before/after compilation. Ship the final committed artifact only after testing that
exact archive. Source maps, test fixtures, operational records, credentials and node_modules are
not included. File inventories, source/snapshot identity, exact lock versions and runtime versions
are in release.json; the adjacent .sha256 identifies the compressed archive. Tar entry order, owner
and timestamps are normalized. This is private distribution, not npm publication or Git history export.

The clean-install driver creates an unrelated temporary directory containing spaces, isolated HOME
and controlled PATH, unpacks the artifact and runs its actual installer/CLI. It reuses the existing
synthetic Slack/SDK flow, supervisor and native researcher fixtures against the installed runtime.
Fixtures and their private artifacts are added only to the disposable test installation, never the
archive. Reports retain checksums, versions, fixture output and failure evidence. No live Slack,
GitHub, provider, launchctl operation or credentials are used. npm registry downloads are expected.

[INSTALL.md](INSTALL.md) covers target commands and explicit startup. [MIGRATION.md](MIGRATION.md)
retains the unresolved general state/path rebinding gate. These tests do not qualify a real host's
login, refresh, notifications, FileVault, power management, sustained work or account policy.
