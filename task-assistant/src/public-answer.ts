import {StoreError, string} from './store.ts';

// Public answers are not execution journals or links to private local artifacts.
// This catches obvious boundary mistakes, not all possible answer-quality failures.
export function publicAnswer(value: unknown, maximum = 2500): string {
  const text = string(value, maximum);
  if (
    /\b[\w.-]+\.md\b|(?:\/Users\/|\/home\/|\/tmp\/|\/private\/|file:\/\/)/i.test(
      text,
    ) ||
    /\b(?:sent|posted|delivered)\s+(?:one|a|the|\d+)\s+(?:concise\s+)?(?:task[- ]DM\s+|Slack\s+|thread\s+)?(?:reply|message|update)\b/i.test(
      text,
    )
  )
    throw new StoreError('public_answer_contains_internal_details');
  return text;
}
