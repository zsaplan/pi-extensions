import assert from 'node:assert/strict';
import test from 'node:test';
import {PullRequestReader} from '../src/pr-context.ts';

// These checks cover the shared remote-read budget and cancellation boundary,
// not whether a model chooses useful evidence or judges descriptions correctly.
test('GitHub context shares request/byte caps and refuses work after failure', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'fixture-credential-only';
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response('{}');
    };
    const reader = new PullRequestReader();
    for (let i = 0; i < 32; i++) await reader.get('repos/acme/sites/pulls/1');
    await assert.rejects(
      reader.get('repos/acme/sites/pulls/1'),
      /budget exhausted/,
    );
    assert.equal(calls, 32);
    assert.equal(reader.requests, 32);
    await assert.rejects(
      reader.get('repos/acme/sites/pulls/1'),
      /budget exhausted/,
    );
    assert.equal(calls, 32);

    const bytes = new PullRequestReader();
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({padding: 'x'.repeat(450 * 1024)}));
    };
    for (let i = 0; i < 4; i++) await bytes.get('repos/acme/sites/pulls/1');
    await assert.rejects(
      bytes.get('repos/acme/sites/pulls/1'),
      /response budget/,
    );
    assert.equal(calls, 5);
    await assert.rejects(
      bytes.get('repos/acme/sites/pulls/1'),
      /response budget/,
    );
    assert.equal(calls, 5);

    globalThis.fetch = async () => {
      calls++;
      return new Response('{}');
    };
    const cached = new PullRequestReader();
    calls = 0;
    await Promise.all([
      cached.get('repos/acme/sites/git/commits/pinned', true),
      cached.get('repos/acme/sites/git/commits/pinned', true),
    ]);
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      new PullRequestReader(controller.signal).get('repos/acme/sites/pulls/1'),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});
