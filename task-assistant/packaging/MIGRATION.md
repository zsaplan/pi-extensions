# Existing-state move and rollback — separate authorization required

**Do not point this release at the live store as an installation test.** The release contains no
state and the packager does not export, repair or migrate it. Fresh install and stateful relocation
are different operations. No live transfer or restart was authorized or performed for packaging.

## Before any stateful move

- [ ] Approve the destination account, private/encrypted transfer and backup handling.
- [ ] Inventory exact old/new application, researcher snapshot/profile, dependency locks, Node,
  credentials locations, provider/model, identity, root/session-library/service paths and permissions.
- [ ] Drain the original coordinator and workers. Verify no active/staging claims or executing
  research. Preserve unfinished admissions, blocked receipts and uncertain sends; resolve only with
  their existing action-specific authority. Do not silently retry them on the new machine.
- [ ] Stop and disable old-host startup under explicit approval; confirm PIDs exited. One active
  host only. A copied local lock does not provide a cross-machine lease.
- [ ] Make a consistent encrypted backup of the **whole** private store and required external
  session-library files, plus service settings, approvals and frozen researcher metadata. Record
  checksums/permissions and source-host shutdown evidence. Keep secrets in a separately approved
  protected procedure; prefer fresh target logins rather than copying rotating credentials.

Preserve task directories/status, exact task/session IDs and session files, Slack parent mappings,
source identities, receipts and dispositions, associations, owner completion authority, run/claim
journals, pending/frozen outbox payloads and their client identities, render caches, trial/renewal/
regular/backlog approval history, reservations and timestamps, research admissions/results/hashes,
failed/partial results and cooldowns. Do not copy just task Markdown or regenerate identifiers.

## Absolute paths and immutable bindings: current blocker for a general move

This release does **not** provide an approved arbitrary-path state migration. Important bindings:
- approval.scope.root and session_library, saved regular-use approval and trial/history hashes;
- session.file, Pi session headers/cwd and owner-reference library bindings;
- active research manifest root/package_dir/dependency_lock/auth_path, intake manifest hash, and
  per-context historical admission manifest_hash/result_hash;
- installed service runtime/dependency paths, Node executable and plist identity.

New machine-local code/auth paths necessarily produce a new research-manifest hash. Rewriting
only intake/github-research.json makes old cached admissions fail their original manifest check.
Rewriting old admissions to match would destroy provenance. Similarly, replacing an approval
without a reviewed migration conflicts with the saved approval/history. **Do not search/replace
all paths, rewrite receipts/session JSONL, delete guards, drop research configuration, reset budgets,
or fabricate a closed trial to get past these checks.**

A stateful relocation needs a separately reviewed, narrowly scoped migration design that records
old/new path mappings and authority while retaining immutable original approvals/admissions/results.
It must prove exact-session continuation and safe cached-result behavior on an isolated backup.
A path-preserving copy may reduce some changes but does not, by itself, solve destination-local
dependency/auth/research bindings. Do not depend on recreating a developer checkout or old Node
Cellar path. Until this gate is completed, use the package only for fresh isolated onboarding, not
as a claimed migration-ready deployment. This is an explicit retained blocker, not a weakened guard.

## Authorized cutover acceptance (not performed)

- [ ] Verify package checksums and offline installation first.
- [ ] Complete the reviewed state/path migration on an isolated backup with no external actions.
- [ ] Compare every identity, journal, approval, reservation, uncertain intent and research record;
  verify remaining model budget from original timestamps, not a fresh empty ledger.
- [ ] Authenticate separately on target; validate exact Slack workspace/owner/bot/DM, approved feeds
  and provider/model availability under the real launchd environment.
- [ ] With the old host disabled, explicitly start one target coordinator. Observe new intake,
  the same existing task session and exact-thread delivery; distinguish readback from notification.
- [ ] Exercise interruption, uncertain publication, network loss, auth/usage holds, sleep/wake and
  FileVault/login recovery. Preserve evidence and run a multi-day soak.

## Rollback

Before the new host has performed any external action, stop it and preserve its evidence; only then
restore/re-enable the unchanged old consistent snapshot under explicit authority. Keep the original
runtime/researcher/dependency versions and original approval/budget state.

After any new external action or receipt/intake progress, **do not restore an old backup blindly**:
it can repeat a post or discard newer owner evidence/reservations. Stop both hosts, preserve both
states, reconcile exact frozen send identities and canonical source/owner receipts, and create a
reviewed forward-consistent rollback. Missing/ambiguous Slack identity remains held without repost.
Never run old and new hosts against copies of the same Slack bindings simultaneously.
