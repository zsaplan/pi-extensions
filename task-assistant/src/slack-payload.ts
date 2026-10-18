import {
  prepareMessageLayout,
  type StaticBlocks,
} from './slack-message-layout.ts';
import {digest, exactKeys, record, StoreError, string} from './store.ts';

export interface SlackPayload {
  text: string;
  blocks?: Array<StaticBlocks[number] | {type: 'markdown'; text: string}>;
}
export const mrkdwn = (text: string) => ({
  type: 'mrkdwn' as const,
  text,
  verbatim: true as const,
});

/** Validate the complete outgoing body. Never use a server read projection as a payload. */
export function slackPayload(value: unknown): SlackPayload {
  const data = record(value);
  exactKeys(data, ['text', 'blocks']);
  const text = string(data.text, 3500);
  if (data.blocks === undefined) return {text};
  if (
    !Array.isArray(data.blocks) ||
    !data.blocks.length ||
    data.blocks.length > 50
  )
    throw new StoreError('invalid_slack_payload');
  const blocks = structuredClone(data.blocks) as NonNullable<
    SlackPayload['blocks']
  >;
  const markdown = blocks.filter(block => block.type === 'markdown');
  const statics = blocks.filter(
    block => block.type !== 'markdown',
  ) as StaticBlocks;
  try {
    if (markdown.length > 1) throw Error('Only one Markdown body');
    for (const block of markdown) {
      exactKeys(record(block), ['type', 'text']);
      prepareMessageLayout({text, markdown: block.text});
    }
    if (statics.length) prepareMessageLayout({text, blocks: statics});
    if (JSON.stringify(blocks).length > 50000) throw Error('Payload too large');
  } catch {
    throw new StoreError('invalid_slack_payload');
  }
  return {text, blocks};
}
export const payloadHash = (payload: SlackPayload) =>
  digest(JSON.stringify(slackPayload(payload)));
export const payloadParams = (payload: SlackPayload) => {
  const checked = slackPayload(payload);
  return {
    text: checked.text,
    ...(checked.blocks ? {blocks: JSON.stringify(checked.blocks)} : {}),
  };
};

/** Version one remains text-only; version two seals fallback AND layout. */
export function intentPayload(intent: Record<string, unknown>): SlackPayload {
  if (intent.schema_version === 1) {
    if (intent.payload !== undefined || intent.payload_hash !== undefined)
      throw new StoreError('slack_intent_mismatch');
    return slackPayload({text: intent.text});
  }
  if (intent.schema_version !== 2)
    throw new StoreError('slack_intent_mismatch');
  const payload = slackPayload(intent.payload);
  if (
    payload.text !== intent.text ||
    payloadHash(payload) !== intent.payload_hash
  )
    throw new StoreError('slack_intent_mismatch');
  return payload;
}

export function markdownPayload(
  text: string,
  markdown: string,
  owner?: string,
): SlackPayload {
  return slackPayload({
    text,
    blocks: [
      ...(owner ? [{type: 'section', text: mrkdwn(`<@${owner}>`)}] : []),
      {type: 'markdown', text: markdown},
    ],
  });
}

export function capacityPayload(
  pending: number,
  queued: number,
  reasons: string[],
): SlackPayload {
  const detail = reasons.join('\n');
  const monitoring = 'Monitoring continues. No requests are being discarded.';
  return slackPayload({
    text: `Assistant capacity. ${detail}\n${pending} saved item${pending === 1 ? '' : 's'} await${pending === 1 ? 's' : ''} assessment. ${queued} task${queued === 1 ? ' is' : 's are'} queued for investigation.\n${monitoring}`,
    blocks: [
      {type: 'header', text: {type: 'plain_text', text: 'Assistant capacity'}},
      {type: 'section', text: mrkdwn('> ⏸️ *Work on hold*\n\n' + detail)},
      {
        type: 'section',
        fields: [
          mrkdwn(
            `*Awaiting assessment*\n${pending} saved item${pending === 1 ? '' : 's'}`,
          ),
          mrkdwn(
            `*Queued for investigation*\n${queued} task${queued === 1 ? '' : 's'}`,
          ),
        ],
      },
      {type: 'section', text: mrkdwn(monitoring)},
    ],
  });
}
