import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

test('owner references, exact-session continuation, silence and failure boundaries through real Pi sessions', async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('owner-reference-quality.mjs', import.meta.url))],
    {timeout: 120000},
  );
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  assert.equal(report.result, 'passed', JSON.stringify(report));
  assert.ok(Object.values(report.checks).every(Boolean));
  console.log(report.report);
});
