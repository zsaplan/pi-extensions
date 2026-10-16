// Compare two completed offline E2E snapshots, never live run receipts.
// node profile-subagent/test/compare-github-reuse.mjs BEFORE.json AFTER.json NEW_OUTPUT.json
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
assert.ok(beforePath && afterPath && outputPath, 'Supply before, after and a new output path.');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const before = await json(beforePath), after = await json(afterPath);
for (const snapshot of [before, after]) {
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.fixtureOnly, true);
  assert.equal(snapshot.liveModelCalls, 0);
  assert.equal(snapshot.liveGithubCalls, 0);
}
assert.deepEqual(before.git, after.git, 'Fixture Git objects must be identical.');
const reportFor = async entry => {
  const directory = join(entry.directory, 'agent/profile-subagent-runs');
  const runs = await readdir(directory);
  assert.equal(runs.length, 1);
  return json(join(directory, runs[0], 'github-result.json'));
};
const comparisons = [];
for (const scenario of ['configuration', 'default-head-concurrent', 'file-windows', 'request-within-limit', 'path-seeded', 'mutable-success', 'failure-sequential']) {
  const oldEntry = before.evidence.find(e => e.scenario === scenario);
  const newEntry = after.evidence.find(e => e.scenario === scenario);
  assert.ok(oldEntry?.passed && newEntry?.passed);
  const oldConfig = await json(join(oldEntry.directory, 'config.json'));
  const newConfig = await json(join(newEntry.directory, 'config.json'));
  assert.deepEqual(oldConfig.actions, newConfig.actions, scenario + ': same logical reads required');
  const oldReport = await reportFor(oldEntry), newReport = await reportFor(newEntry);
  const metrics = (entry, report) => ({
    adapterCalls: report.github.calls,
    physicalHttpRequests: entry.httpRequests,
    responseBytes: report.github.responseBytes,
    scriptedModelRequests: entry.childRequests,
    retainedObservations: report.sourceEvidence.records.length,
    omittedObservations: report.sourceEvidence.omitted,
    returnedHandoffBytes: Buffer.byteLength(JSON.stringify(report)),
    referenceStatus: report.referenceValidation?.status ?? 'not-checked',
  });
  const oldMetrics = metrics(oldEntry, oldReport), newMetrics = metrics(newEntry, newReport);
  assert.equal(oldMetrics.adapterCalls, newMetrics.adapterCalls);
  assert.equal(oldMetrics.scriptedModelRequests, newMetrics.scriptedModelRequests);
  assert.equal(oldMetrics.retainedObservations, newMetrics.retainedObservations);
  assert.equal(oldMetrics.omittedObservations, newMetrics.omittedObservations);
  assert.ok(newMetrics.physicalHttpRequests <= oldMetrics.physicalHttpRequests);
  assert.ok(newMetrics.responseBytes <= oldMetrics.responseBytes);
  comparisons.push({scenario, before: oldMetrics, after: newMetrics,
    avoidedRequests: oldMetrics.physicalHttpRequests - newMetrics.physicalHttpRequests,
    avoidedResponseBytes: oldMetrics.responseBytes - newMetrics.responseBytes,
  });
}
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(outputPath, JSON.stringify({
  fixtureOnly: true, measuredAt: new Date().toISOString(),
  before: {path: beforePath, sha256: await digest(beforePath)},
  after: {path: afterPath, sha256: await digest(afterPath)},
  identicalGitObjects: before.git, comparisons,
  limitations: [
    'Scripted decisions and local transport; no live model quality, latency or cost claim.',
    'Request savings do not establish parent review effort or whole-workflow savings.',
    'Handoff size includes new reference/reuse metadata and may increase.',
    'Reference validation checks identity, not whether evidence supports a claim.',
  ],
}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(outputPath);
