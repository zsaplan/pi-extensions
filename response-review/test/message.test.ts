import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isClipboardReadPayload,
  isClipboardWritePayload,
  isRequestPayload,
  isResponseReviewWindowMessage,
  isSubmitPayload,
} from '../src/message.ts';

test('window message guards accept valid host-bound payloads', () => {
  const submit = {
    type: 'submit',
    responseId: 'assistant-1',
    overallComment: 'Looks good except one line.',
    comments: [
      {
        id: 'comment-1',
        responseId: 'assistant-1',
        startLine: 2,
        endLine: 3,
        excerpt: 'line 2\nline 3',
        body: 'Tighten this wording.',
      },
      {
        id: 'comment-2',
        responseId: 'assistant-1',
        startLine: null,
        endLine: null,
        excerpt: '',
        body: 'Whole-response note.',
      },
    ],
  };

  assert.equal(isSubmitPayload(submit), true);
  assert.equal(isResponseReviewWindowMessage(submit), true);
  assert.equal(
    isRequestPayload({
      type: 'request-response',
      requestId: 'request-1',
      responseId: 'assistant-1',
    }),
    true,
  );
  assert.equal(
    isClipboardWritePayload({
      type: 'clipboard-write',
      requestId: 'copy-1',
      text: 'copy me',
    }),
    true,
  );
  assert.equal(
    isClipboardReadPayload({type: 'clipboard-read', requestId: 'paste-1'}),
    true,
  );
});

test('window message guards reject malformed payloads without throwing', () => {
  const malformedPayloads: unknown[] = [
    null,
    undefined,
    'submit',
    42,
    {type: 'request-response', requestId: 1, responseId: 'assistant-1'},
    {type: 'clipboard-write', requestId: 'copy-1', text: 123},
    {type: 'clipboard-read'},
    {
      type: 'submit',
      responseId: 'assistant-1',
      overallComment: 'bad comment shape',
      comments: [
        {
          id: 'comment-1',
          responseId: 'assistant-1',
          startLine: 0,
          endLine: null,
          excerpt: '',
          body: 'line numbers are one-based',
        },
      ],
    },
    {
      type: 'submit',
      responseId: 'assistant-1',
      overallComment: 'comments must be arrays',
      comments: {},
    },
  ];

  for (const payload of malformedPayloads) {
    assert.doesNotThrow(() => isResponseReviewWindowMessage(payload));
    assert.equal(isResponseReviewWindowMessage(payload), false);
  }
});
