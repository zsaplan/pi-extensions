import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCommentPage} from '../src/comment-page.ts';
import {textToAdf} from '../src/jira.ts';

test('large pages keep complete records and the exact offset of the first omitted comment', () => {
  const comments = Array.from({length: 12}, (_, i) => ({
    id: String(i),
    body: textToAdf('é'.repeat(9000)),
  }));
  const first = buildCommentPage({comments, total: 12}, 0, 12);
  assert.equal(first.truncated, true);
  assert.ok(first.comments.every(comment => comment.bodyTruncated));
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 50 * 1024);
  assert.equal(first.nextStartAt, first.comments.length);
  assert.ok(first.nextStartAt !== undefined && first.nextStartAt < 12);
  const second = buildCommentPage(
    {comments: comments.slice(first.nextStartAt), total: 12},
    first.nextStartAt,
    12,
  );
  assert.equal(second.comments[0].id, String(first.nextStartAt));
});
