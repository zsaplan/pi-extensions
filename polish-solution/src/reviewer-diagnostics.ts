export type ReviewerToolAccessRecord = {
  activeToolNames: string[];
  configuredToolNames: string[];
  systemPromptHasAvailableTools: boolean;
  systemPromptHasSubmitReview: boolean;
  availableToolsSection?: string;
};

export type ReviewerSessionDiagnostics = {
  reviewerUsage?: unknown;
  reviewerMessages?: unknown[];
  reviewerToolAccess?: ReviewerToolAccessRecord;
};

export type ReviewerPseudoToolCallDiagnostics = {
  toolNames: string[];
};

export function getReviewerSessionDiagnostics(
  error: unknown,
): ReviewerSessionDiagnostics | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const errorRecord = error as Record<string, unknown>;
  const reviewerUsage = errorRecord.reviewerUsage;
  const reviewerMessages = Array.isArray(errorRecord.reviewerMessages)
    ? errorRecord.reviewerMessages
    : undefined;
  const reviewerToolAccess = isReviewerToolAccessRecord(
    errorRecord.reviewerToolAccess,
  )
    ? errorRecord.reviewerToolAccess
    : undefined;

  if (
    reviewerUsage === undefined &&
    reviewerMessages === undefined &&
    reviewerToolAccess === undefined
  ) {
    return undefined;
  }

  return {
    reviewerUsage,
    reviewerMessages,
    reviewerToolAccess,
  };
}

export function buildReviewerToolAccessRecord(session: {
  state: {tools: Array<{name: string}>};
  getAllTools(): Array<{name: string}>;
  systemPrompt: string;
}): ReviewerToolAccessRecord {
  const activeToolNames = [
    ...new Set(session.state.tools.map(tool => tool.name)),
  ];
  const configuredToolNames = [
    ...new Set(session.getAllTools().map(tool => tool.name)),
  ];
  const availableToolsSection = extractAvailableToolsSection(
    session.systemPrompt,
  );

  return {
    activeToolNames,
    configuredToolNames,
    systemPromptHasAvailableTools: availableToolsSection !== undefined,
    systemPromptHasSubmitReview: session.systemPrompt.includes('submit_review'),
    availableToolsSection,
  };
}

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

function isReviewerToolAccessRecord(
  value: unknown,
): value is ReviewerToolAccessRecord {
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.activeToolNames) &&
    record.activeToolNames.every(tool => typeof tool === 'string') &&
    Array.isArray(record.configuredToolNames) &&
    record.configuredToolNames.every(tool => typeof tool === 'string') &&
    typeof record.systemPromptHasAvailableTools === 'boolean' &&
    typeof record.systemPromptHasSubmitReview === 'boolean' &&
    (record.availableToolsSection === undefined ||
      typeof record.availableToolsSection === 'string')
  );
}

function extractAvailableToolsSection(
  systemPrompt: string,
): string | undefined {
  const start = systemPrompt.indexOf('Available tools:');
  if (start === -1) return undefined;

  const tail = systemPrompt.slice(start);
  const endMarkers = ['\n\nIn addition to the tools above,', '\n\nGuidelines:'];
  const end = endMarkers
    .map(marker => tail.indexOf(marker))
    .filter(index => index !== -1)
    .sort((left, right) => left - right)[0];

  return (end === undefined ? tail : tail.slice(0, end)).trim();
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
