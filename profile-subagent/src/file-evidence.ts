export const maxFileEvidenceBytes = 8000;

type ReadRecord = {
  callId: string;
  requestedArguments: unknown;
  observedAt: string;
  isError: boolean;
  content: {type: 'text'; text: string}[];
};

/** Only post-parent-pipeline observations, never child prompts or reasoning. */
export class FileEvidence {
  private records: ReadRecord[] = [];
  private omittedReadResults = 0;
  private unavailableReadResults = 0;

  begin() {
    // Count before awaiting the parent: a cancelled/pending call must not look
    // like a complete empty evidence set if it never returns a usable result.
    this.unavailableReadResults++;
  }

  record(
    callId: string,
    requestedArguments: unknown,
    content: readonly {type: string; text?: string}[],
    isError: boolean,
  ) {
    this.unavailableReadResults--;
    if (
      !content.length ||
      content.some(
        part => part.type !== 'text' || typeof part.text !== 'string',
      )
    ) {
      this.omittedReadResults++;
      return;
    }
    this.records.push({
      callId,
      requestedArguments,
      observedAt: new Date().toISOString(),
      isError,
      content: content.map(part => ({type: 'text', text: part.text!})),
    });
    this.snapshot();
  }

  snapshot() {
    const value = () => ({
      records: [...this.records],
      omittedReadResults: this.omittedReadResults,
      unavailableReadResults: this.unavailableReadResults,
    });
    // Omit whole records, including if a later counter grows. Never imply that
    // a clipped excerpt was the complete returned observation.
    while (
      this.records.length &&
      Buffer.byteLength(JSON.stringify(value()), 'utf8') > maxFileEvidenceBytes
    ) {
      this.records.pop();
      this.omittedReadResults++;
    }
    return value();
  }
}
