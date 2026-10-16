// Shared drafting advice, not an outbound text transform or a write permission.
// Pi deduplicates identical prompt guidelines across active tools.
export const SLACK_MESSAGE_WRITING_GUIDELINES = [
  'For agent-authored Slack posts, message edits, and upload comments, match the audience and purpose in the request and relevant thread. Lead with impact for mixed audiences; retain details operators need to act. Ask only when ambiguity would materially change the message.',
  'Lead with the outcome, change, or request. Use plain, natural language and short sentences. In follow-ups, say what changed instead of retelling the investigation. Cut boilerplate, repeated background, and routine process narration.',
  'Keep routine Slack updates to a short paragraph or a lead plus 2–4 brief bullets; shorter is fine. Allow more detail for requested reports/plans or accuracy. Link supporting evidence instead of duplicating it. Do not split a long report into extra posts just to make each post short.',
  'Preserve facts, numbers, scope, uncertainty, conditions, ownership, and decision status. Keep qualifications that change a conclusion beside that claim. Never invent links, owners, deadlines, or action items; an FYI need not ask for action. Preserve exact user-supplied wording when asked to send it verbatim.',
  'Use Slack message mrkdwn: single-asterisk bold sparingly, blank lines, short bullets, and <url|descriptive label> links. Avoid Markdown headings, pipe tables, and decorative emoji. Canvas documents use native Markdown instead. Keep upload comments brief; do not rewrite attached evidence for style.',
  'Use the slack-publish-report skill for message-writing examples and report guidance. Writing guidance does not authorize additional posts, uploads, broadcasts, or edits; existing approval rules still apply.',
];
