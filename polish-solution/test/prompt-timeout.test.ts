import assert from 'node:assert/strict';
import test from 'node:test';
import {
  promptWithTimeout,
  type PromptTimeoutSession,
} from '../src/prompt-timeout.ts';

type Listener = (event: unknown) => void;

class FakeSession implements PromptTimeoutSession {
  abortCalls = 0;
  listeners: Listener[] = [];
  private readonly abortPromise: Promise<void>;

  constructor(abortPromise: Promise<void> = Promise.resolve()) {
    this.abortPromise = abortPromise;
  }

  abort(): Promise<void> {
    this.abortCalls += 1;
    return this.abortPromise;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(
        candidate => candidate !== listener,
      );
    };
  }

  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

function neverResolves(): Promise<void> {
  return new Promise(() => {});
}

test('promptWithTimeout resolves completed child prompts without aborting', async () => {
  const session = new FakeSession();

  await promptWithTimeout({
    operation: Promise.resolve(),
    session,
    timeoutMs: 1_000,
    stallTimeoutMs: 30,
  });

  assert.equal(session.abortCalls, 0);
  assert.equal(session.listeners.length, 0);
});

test('promptWithTimeout rejects even when child session abort never resolves', async () => {
  const session = new FakeSession(neverResolves());

  await assert.rejects(
    promptWithTimeout({
      operation: neverResolves(),
      session,
      timeoutMs: 5,
    }),
    /timed out after 5ms/,
  );
  assert.equal(session.abortCalls, 1);
});

test('promptWithTimeout fails stalled child sessions before the full prompt timeout', async () => {
  const session = new FakeSession();

  await assert.rejects(
    promptWithTimeout({
      operation: neverResolves(),
      session,
      timeoutMs: 1_000,
      stallTimeoutMs: 5,
    }),
    /made no progress for 5ms/,
  );
  assert.equal(session.abortCalls, 1);
  assert.equal(session.listeners.length, 0);
});

test('promptWithTimeout resets the stall watchdog on child session events', async () => {
  const session = new FakeSession();
  const startedAt = Date.now();
  const prompt = promptWithTimeout({
    operation: neverResolves(),
    session,
    timeoutMs: 1_000,
    stallTimeoutMs: 30,
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  session.emit({type: 'message_update'});

  await assert.rejects(prompt, /made no progress for 30ms/);
  assert.ok(Date.now() - startedAt >= 45);
  assert.equal(session.abortCalls, 1);
  assert.equal(session.listeners.length, 0);
});
