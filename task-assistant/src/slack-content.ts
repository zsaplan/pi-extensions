// Snapshot of slack/src/message-content.ts: no dependency on the installed Slack extension.
// Read projections are for understanding/search, not replacement payloads.
// Slack can translate one Markdown block into several rich_text/table blocks.
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function render(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (depth > 20) return '[Slack content nesting limit; inspect blocks mode]';
  const item = object(value);
  const child = (value: unknown) => render(value, depth + 1);
  const children = (separator: string) =>
    array(item.elements).map(child).join(separator);
  switch (item.type) {
    case 'plain_text':
    case 'mrkdwn':
    case 'markdown':
    case 'raw_text':
      return string(item.text);
    case 'raw_number':
      return string(item.text) || String(item.value ?? '');
    case 'text': {
      let text = string(item.text);
      const style = object(item.style);
      if (style.code) text = `\`${text}\``;
      if (style.bold) text = `*${text}*`;
      if (style.italic) text = `_${text}_`;
      if (style.strike) text = `~${text}~`;
      return text;
    }
    case 'link':
      return `<${string(item.url)}${item.text ? `|${string(item.text)}` : ''}>`;
    case 'user':
      return `<@${string(item.user_id)}>`;
    case 'channel':
      return `<#${string(item.channel_id)}>`;
    case 'usergroup':
      return `<!subteam^${string(item.usergroup_id)}>`;
    case 'broadcast':
      return `<!${string(item.range)}>`;
    case 'emoji':
      return `:${string(item.name)}:`;
    case 'date':
      return string(item.fallback) || `[Slack date ${item.timestamp}]`;
    case 'color':
      return string(item.value);
    case 'image':
      return `[Image: ${string(item.alt_text)}]`;
    case 'header':
      return child(item.text);
    case 'divider':
      return '---';
    case 'context':
      return children(' · ');
    case 'section':
      return [
        child(item.text ?? ''),
        ...array(item.fields).map(child),
        item.accessory ? '[Slack accessory; inspect blocks mode]' : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'rich_text':
      return children('\n');
    case 'rich_text_section':
      return children('');
    case 'rich_text_list': {
      const indent = '  '.repeat(
        Math.max(0, Math.min(8, Number(item.indent) || 0)),
      );
      return array(item.elements)
        .map((entry, index) => {
          const label =
            item.style === 'ordered'
              ? `${(Number(item.offset) || 0) + index + 1}.`
              : '•';
          return `${indent}${label} ${child(entry)}`;
        })
        .join('\n');
    }
    case 'rich_text_quote':
      return children('')
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
    case 'rich_text_preformatted':
      return `\`\`\`\n${children('')}\n\`\`\``;
    case 'table':
      return array(item.rows)
        .map(
          row =>
            `| ${array(row)
              .map(cell =>
                child(cell).replace(/\|/g, '\\|').replace(/\n/g, '\\n'),
              )
              .join(' | ')} |`,
        )
        .join('\n');
    default:
      return `[Unsupported Slack content: ${string(item.type) || 'unknown'}; inspect blocks mode]`;
  }
}

export interface MessageContent {
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
}

export function messageContentText(message: MessageContent): string {
  const body = message.blocks?.length
    ? message.blocks.map(block => render(block)).join('\n\n')
    : (message.text ?? '');
  const attachments = (message.attachments ?? [])
    .map(value => {
      const attachment = object(value);
      const fields = array(attachment.fields).map(value => {
        const field = object(value);
        return [string(field.title), string(field.value)]
          .filter(Boolean)
          .join(': ');
      });
      const title = attachment.title_link
        ? `<${string(attachment.title_link)}|${string(attachment.title) || string(attachment.title_link)}>`
        : string(attachment.title);
      return (
        [
          string(attachment.pretext),
          title,
          string(attachment.text),
          ...fields,
          ...array(attachment.blocks).map(block => render(block)),
          string(attachment.footer),
        ]
          .filter(Boolean)
          .join('\n') || string(attachment.fallback)
      );
    })
    .filter(Boolean);
  const fallback =
    body.includes('[Unsupported Slack content:') && message.text
      ? `Fallback text: ${message.text}`
      : '';
  return [body, fallback, ...attachments].filter(Boolean).join('\n\n');
}

/** Evidence context only. Never use this projection for receipt hashes or approval authority. */
export function richSlackContext(
  message: Record<string, unknown>,
  maximum: number,
  sanitize: (text: string) => string = text => text,
) {
  const blocks = array(message.blocks);
  const attachments = array(message.attachments);
  if (!blocks.length && !attachments.length) return {};
  const projected = sanitize(
    messageContentText({
      text: string(message.text),
      blocks,
      attachments,
    }),
  );
  return {
    formatted_text: projected.slice(0, maximum),
    formatted_text_truncated: projected.length > maximum,
    formatted_text_incomplete:
      /\[(?:Unsupported Slack content:|Slack content nesting limit|Slack accessory;)/.test(
        projected,
      ),
    formatted_text_scope:
      'Untrusted context only; linked files/images not opened. Canonical text and approval authority are unchanged.',
  };
}
