import type {
  ResponseReviewComment,
  ResponseReviewEntryData,
  ResponseReviewSubmitPayload,
} from './types.js';

function lineNumberText(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

function formatLineRange(comment: ResponseReviewComment): string {
  if (comment.startLine === null) return 'whole response';
  if (comment.endLine !== null && comment.endLine !== comment.startLine) {
    return `lines ${comment.startLine}-${comment.endLine}`;
  }
  return `line ${comment.startLine}`;
}

function formatQuotedExcerpt(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split('\n').map(line => `> ${line}`);
}

export function composeResponseReviewPrompt(
  response: ResponseReviewEntryData,
  payload: ResponseReviewSubmitPayload,
): string {
  const lines: string[] = [];
  const comments = payload.comments.filter(
    comment => comment.body.trim().length > 0,
  );
  const includeOriginalResponse =
    comments.length === 0 ||
    comments.some(comment => comment.excerpt.trim().length === 0);

  lines.push('Review feedback was captured for the assistant response below.');
  lines.push(
    'Use the feedback contextually: discuss it further, make code changes, record memory, use tools, ask follow-up questions, or revise the response itself as appropriate.',
  );
  lines.push('');

  if (includeOriginalResponse) {
    lines.push('Original assistant response:');
    lines.push('```text');
    lines.push(lineNumberText(response.text));
    lines.push('```');
    lines.push('');
  }

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push('Overall review note:');
    lines.push(overallComment);
    lines.push('');
  }

  lines.push('Targeted review comments:');
  if (comments.length === 0) {
    lines.push(
      '- No line-specific comments were added. Apply the overall review note only.',
    );
  } else {
    comments.forEach((comment, index) => {
      lines.push(`${index + 1}. ${formatLineRange(comment)}`);
      const excerptLines = formatQuotedExcerpt(comment.excerpt);
      if (excerptLines.length > 0) {
        lines.push('   Excerpt:');
        excerptLines.forEach(line => {
          lines.push(`   ${line}`);
        });
      }
      lines.push('   Feedback:');
      comment.body
        .trim()
        .split('\n')
        .forEach(line => {
          lines.push(`   ${line}`);
        });
      lines.push('');
    });
  }

  lines.push(
    'Address the feedback in the most appropriate way for the current task.',
  );

  return lines.join('\n').trim();
}
