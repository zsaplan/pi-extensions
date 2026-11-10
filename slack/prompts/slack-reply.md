---
description: Draft or send a clear Slack reply from the current findings
argument-hint: "[draft|send] [destination] [additional direction]"
---
Prepare a Slack message from the current findings. Read and follow the slack-publish-report skill.

Treat the additional direction below as the requested mode, destination, and editorial guidance. Default to drafting here without calling a write tool. Send only when explicitly requested in this invocation or a subsequent user message, subject to existing approval gates. A supplied permalink alone is not a send request. An explicit draft-only instruction takes priority.

Use the supplied destination, or the clearly established originating thread. Read the relevant thread as needed for audience, current context, and duplicate updates. Preserve an explicit request for a new channel-level post; ask only if the destination remains materially ambiguous. Do not broadcast unless requested.

Write for the people in that discussion. Lead with the answer, impact, or change. Explain technical findings in familiar language. For follow-ups, include only new information and context needed to understand it.

Preserve established conclusions, scope, and material uncertainty. Omit investigation narration, repeated background, and routine statements about work not performed. Keep limitations that change the reader's understanding or next action. Include next steps only when requested or necessary to make a real ask clear; do not invent owners or deadlines.

Reuse the substantive findings and useful comparison tables already developed in Pi. Use native Slack-supported formatting, not a raw pipe table in ordinary message text. Otherwise prefer a short paragraph or a few bullets. Include relevant verified evidence links and use verified Slack mentions for requested recipients; do not guess identities or links.

Do not create extra artifacts, start a watch, or conduct a new investigation merely to polish the message. For sends, inspect the assembled message and any required fallback before calling the write tool, then verify the returned result without automatically retrying an uncertain write.

Additional direction: $ARGUMENTS
