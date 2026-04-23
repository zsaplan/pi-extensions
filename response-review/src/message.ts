import type {
  ResponseReviewCancelPayload,
  ResponseReviewClipboardReadPayload,
  ResponseReviewClipboardWritePayload,
  ResponseReviewComment,
  ResponseReviewRequestPayload,
  ResponseReviewSubmitPayload,
  ResponseReviewWindowMessage,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1)
  );
}

function isCommentPayload(value: unknown): value is ResponseReviewComment {
  if (!isRecord(value)) return false;
  if (!isNullablePositiveInteger(value.startLine)) return false;
  if (!isNullablePositiveInteger(value.endLine)) return false;
  if (value.startLine === null && value.endLine !== null) return false;
  if (
    value.startLine !== null &&
    value.endLine !== null &&
    value.endLine < value.startLine
  ) {
    return false;
  }

  return (
    isString(value.id) &&
    isString(value.responseId) &&
    isString(value.excerpt) &&
    isString(value.body)
  );
}

export function isSubmitPayload(
  value: unknown,
): value is ResponseReviewSubmitPayload {
  if (!isRecord(value)) return false;
  return (
    value.type === 'submit' &&
    isString(value.responseId) &&
    isString(value.overallComment) &&
    Array.isArray(value.comments) &&
    value.comments.every(isCommentPayload)
  );
}

export function isCancelPayload(
  value: unknown,
): value is ResponseReviewCancelPayload {
  return isRecord(value) && value.type === 'cancel';
}

export function isRequestPayload(
  value: unknown,
): value is ResponseReviewRequestPayload {
  return (
    isRecord(value) &&
    value.type === 'request-response' &&
    isString(value.requestId) &&
    isString(value.responseId)
  );
}

export function isClipboardWritePayload(
  value: unknown,
): value is ResponseReviewClipboardWritePayload {
  return (
    isRecord(value) &&
    value.type === 'clipboard-write' &&
    isString(value.requestId) &&
    isString(value.text)
  );
}

export function isClipboardReadPayload(
  value: unknown,
): value is ResponseReviewClipboardReadPayload {
  return (
    isRecord(value) &&
    value.type === 'clipboard-read' &&
    isString(value.requestId)
  );
}

export function isResponseReviewWindowMessage(
  value: unknown,
): value is ResponseReviewWindowMessage {
  return (
    isSubmitPayload(value) ||
    isCancelPayload(value) ||
    isRequestPayload(value) ||
    isClipboardWritePayload(value) ||
    isClipboardReadPayload(value)
  );
}
