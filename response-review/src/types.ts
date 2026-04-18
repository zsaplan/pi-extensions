export interface ResponseReviewSessionSource {
  kind: "current" | "session-file";
  sessionId: string;
  sessionPath: string | null;
  cwd: string;
  name: string | null;
  displayTitle: string;
}

export interface ResponseReviewEntrySummary {
  id: string;
  index: number;
  timestamp: number;
  provider: string | null;
  model: string | null;
  preview: string;
  precedingUserPreview: string;
  lineCount: number;
  charCount: number;
}

export interface ResponseReviewEntryData extends ResponseReviewEntrySummary {
  text: string;
  precedingUserText: string;
}

export interface LoadedResponseReviewSession {
  session: ResponseReviewSessionSource;
  responses: ResponseReviewEntryData[];
}

export interface ResponseReviewWindowData {
  session: ResponseReviewSessionSource;
  responses: ResponseReviewEntrySummary[];
}

export interface ResponseReviewComment {
  id: string;
  responseId: string;
  startLine: number | null;
  endLine: number | null;
  excerpt: string;
  body: string;
}

export interface ResponseReviewSubmitPayload {
  type: "submit";
  responseId: string;
  overallComment: string;
  comments: ResponseReviewComment[];
}

export interface ResponseReviewCancelPayload {
  type: "cancel";
}

export interface ResponseReviewRequestPayload {
  type: "request-response";
  requestId: string;
  responseId: string;
}

export interface ResponseReviewClipboardWritePayload {
  type: "clipboard-write";
  requestId: string;
  text: string;
}

export interface ResponseReviewClipboardReadPayload {
  type: "clipboard-read";
  requestId: string;
}

export type ResponseReviewWindowMessage =
  | ResponseReviewSubmitPayload
  | ResponseReviewCancelPayload
  | ResponseReviewRequestPayload
  | ResponseReviewClipboardWritePayload
  | ResponseReviewClipboardReadPayload;

export interface ResponseReviewDataMessage {
  type: "response-data";
  requestId: string;
  responseId: string;
  text: string;
  precedingUserText: string;
}

export interface ResponseReviewErrorMessage {
  type: "response-error";
  requestId: string;
  responseId: string;
  message: string;
}

export interface ResponseReviewClipboardWriteResultMessage {
  type: "clipboard-write-result";
  requestId: string;
  ok: boolean;
  message?: string;
}

export interface ResponseReviewClipboardReadResultMessage {
  type: "clipboard-read-result";
  requestId: string;
  ok: boolean;
  text?: string;
  message?: string;
}

export interface ResponseReviewDebugLogMessage {
  type: "debug-log";
  source: "host" | "page";
  message: string;
  details?: Record<string, unknown>;
}

export type ResponseReviewHostMessage =
  | ResponseReviewDataMessage
  | ResponseReviewErrorMessage
  | ResponseReviewClipboardWriteResultMessage
  | ResponseReviewClipboardReadResultMessage
  | ResponseReviewDebugLogMessage;
