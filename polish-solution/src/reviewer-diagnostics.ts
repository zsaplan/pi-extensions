export type ReviewerPseudoToolCallDiagnostics = {
  toolNames: string[];
};

export function getReviewerPseudoToolCallDiagnostics(
  messages: unknown[],
): ReviewerPseudoToolCallDiagnostics | undefined {
  const toolNames = new Set<string>();

  for (const text of getAssistantTextParts(messages)) {
    for (const line of normalizeNewlines(text).split('\n')) {
      const match = /^to=([A-Za-z0-9_]+)/.exec(line.trim());
      if (!match) continue;
      toolNames.add(match[1]);
    }
  }

  if (toolNames.size === 0) {
    return undefined;
  }

  return {
    toolNames: [...toolNames].sort(),
  };
}

export function createReviewerPseudoToolCallError(
  diagnostics: ReviewerPseudoToolCallDiagnostics,
): Error {
  return new Error(
    'polish_solution_review reviewer emitted pseudo tool-call text ' +
      `(${diagnostics.toolNames.join(', ')}) instead of invoking tools. ` +
      'This usually means the isolated reviewer lost its tool scaffolding.',
  );
}

function getAssistantTextParts(messages: unknown[]): string[] {
  const texts: string[] = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;

    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== 'assistant') continue;

    const content = messageRecord.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== 'object') continue;

      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== 'text' || typeof partRecord.text !== 'string') {
        continue;
      }

      texts.push(partRecord.text);
    }
  }

  return texts;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
