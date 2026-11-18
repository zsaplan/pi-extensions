import assert from 'node:assert/strict';
import test from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {readCiCheckpoint} from '../src/ci-checkpoint.ts';

const target = {
  repository: 'example/project',
  runId: '43',
  deadline: '2026-11-18T20:03:00Z',
};

test('a pending run can be checked again without extending its deadline', async () => {
  let calls = 0;
  const exec: ExtensionAPI['exec'] = async (command, args, options) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 5), [
      'run',
      'view',
      '43',
      '--repo',
      'example/project',
    ]);
    assert.ok(options?.timeout && options.timeout <= 10_000);
    const pending = calls++ === 0;
    return {
      stdout: JSON.stringify({
        status: pending ? 'in_progress' : 'completed',
        conclusion: pending ? '' : 'failure',
        url: 'https://github.com/example/project/actions/runs/43',
        attempt: 1,
      }),
      stderr: '',
      code: 0,
      killed: false,
    };
  };
  const first = await readCiCheckpoint(
    target,
    exec,
    '.',
    undefined,
    () => new Date('2026-11-18T20:00:00Z'),
  );
  assert.equal(first.kind, 'pending');
  const second = await readCiCheckpoint(
    first.checkpoint,
    exec,
    '.',
    undefined,
    () => new Date('2026-11-18T20:02:55Z'),
  );
  assert.equal(second.kind, 'completed');
  assert.equal(second.run?.conclusion, 'failure');
  assert.deepEqual(second.checkpoint, target);
  const expired = await readCiCheckpoint(
    second.checkpoint,
    exec,
    '.',
    undefined,
    () => new Date(target.deadline),
  );
  assert.equal(expired.kind, 'deadline-reached');
  assert.equal(calls, 2);
});
