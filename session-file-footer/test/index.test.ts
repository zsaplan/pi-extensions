import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abbreviateHome,
  buildSplitLine,
  padEndToWidth,
  sanitizeFooterText,
  truncateStartToWidth,
} from '../src/index.ts';
import {visibleWidth} from '@earendil-works/pi-tui';

test('sanitizeFooterText removes control whitespace for single-line footer output', () => {
  assert.equal(sanitizeFooterText(' one\n\ttwo\r  three '), 'one two three');
});

test('abbreviateHome replaces only paths inside the home directory', () => {
  const env = {HOME: '/Users/zach'};

  assert.equal(abbreviateHome('/Users/zach', env), '~');
  assert.equal(abbreviateHome('/Users/zach/project', env), '~/project');
  assert.equal(
    abbreviateHome('/Users/zachary/project', env),
    '/Users/zachary/project',
  );
});

test('truncateStartToWidth preserves the session filename suffix', () => {
  const value = truncateStartToWidth('/long/path/to/session-file.jsonl', 19);

  assert.equal(visibleWidth(value), 19);
  assert.equal(value, '…session-file.jsonl');
});

test('padEndToWidth pads short ANSI-styled footer lines to terminal width', () => {
  const value = padEndToWidth('\u001b[2mstatus\u001b[0m', 12);

  assert.equal(visibleWidth(value), 12);
  assert.match(value, / {6}$/);
});

test('buildSplitLine right-aligns the session path when both columns fit', () => {
  const line = buildSplitLine('/repo', 'jsonl: ~/.pi/session.jsonl', 34);

  assert.equal(line, '/repo   jsonl: ~/.pi/session.jsonl');
  assert.equal(visibleWidth(line), 34);
});

test('buildSplitLine truncates both columns without exceeding width', () => {
  const line = buildSplitLine(
    '~/very/long/project/path (branch-name)',
    'jsonl: ~/.pi/agent/sessions/--very-long-project--/2026-session-file.jsonl',
    50,
  );

  assert.equal(visibleWidth(line), 50);
  assert.match(line, /^~\/very\/long/);
  assert.match(line, /2026-session-file\.jsonl$/);
});
