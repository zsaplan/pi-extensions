import {ReadonlySlackClient, object, objects} from './slack.ts';
import type {Inbox, Source} from './store.ts';

export const escapeSlack = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decode = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const label = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const result = value
    .replace(/[\p{Cc}\p{Cf}<>|`*_~]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return result || undefined;
};
function httpsOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      /^[a-z0-9-]+\.slack\.com$/.test(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password
    )
      return url.origin;
  } catch {
    /* Missing workspace origin means no fabricated source permalink. */
  }
  return undefined;
}

/** Presentation only: bounded metadata, no linked-content fetches or notification tokens. */
export class SlackPresentation {
  readonly origin: string | undefined;
  private names = new Map<string, string | undefined>();
  constructor(
    private reads: ReadonlySlackClient,
    private inbox: Inbox,
    workspaceUrl: unknown,
  ) {
    this.origin = httpsOrigin(workspaceUrl);
  }
  sourceLink(source: Source): string {
    if (!this.origin || source.workspace_id !== this.inbox.workspace_id)
      return 'Source message (link unavailable)';
    const thread =
      source.thread_ts && source.thread_ts !== source.message_ts
        ? `?thread_ts=${source.thread_ts}&cid=${source.channel_id}`
        : '';
    return `<${this.origin}/archives/${source.channel_id}/p${source.message_ts.replace('.', '')}${thread}|Message in ${source.channel_id}>`;
  }
  private async name(
    id: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (id === this.inbox.channel_id) return 'your DM';
    if (this.names.has(id)) return this.names.get(id);
    let name: string | undefined;
    try {
      if (/^[UW]/.test(id)) {
        const user = object(
          (
            await this.reads.call(
              'bot',
              'users.info',
              {user: id},
              signal,
              65536,
            )
          ).user,
        );
        if (user.id === id && user.team_id === this.inbox.workspace_id) {
          const profile = user.profile ? object(user.profile) : {};
          name =
            label(profile.display_name) ??
            label(profile.real_name) ??
            label(user.real_name) ??
            label(user.name);
        }
      } else if (/^[CDG]/.test(id)) {
        const channel = object(
          (
            await this.reads.call(
              'bot',
              'conversations.info',
              {channel: id},
              signal,
              65536,
            )
          ).channel,
        );
        if (
          channel.id === id &&
          (!channel.context_team_id ||
            channel.context_team_id === this.inbox.workspace_id)
        )
          name =
            channel.is_im || channel.is_mpim
              ? 'direct message'
              : label(channel.name)
                ? `#${label(channel.name)}`
                : undefined;
      } else if (id.startsWith('S')) {
        const groups = objects(
          (await this.reads.call('bot', 'usergroups.list', {}, signal, 65536))
            .usergroups,
        );
        const group = groups.find(
          g =>
            g.id === id &&
            g.team_id === this.inbox.workspace_id &&
            !g.date_delete,
        );
        if (group && label(group.handle)) name = `@${label(group.handle)}`;
      }
    } catch {
      /* Missing scope, rate limit, malformed or foreign metadata is not a guessed name. */
    }
    if (this.names.size >= 128)
      this.names.delete(this.names.keys().next().value!);
    this.names.set(id, name);
    return name;
  }
  async render(text: string, sources: Source[] = []): Promise<string> {
    const signal = AbortSignal.timeout(3000);
    const known = new Set([
      this.inbox.owner_user_id,
      this.inbox.bot_user_id,
      this.inbox.channel_id,
      ...sources.map(s => s.channel_id),
    ]);
    const resolved = new Map<string, string>();
    const alias = async (id: string, explicit = false): Promise<string> => {
      if (resolved.has(id)) return resolved.get(id)!;
      const name =
        resolved.size < 8 && !signal.aborted
          ? await this.name(id, signal)
          : undefined;
      // Plain uppercase words can resemble IDs. Never relabel such a word on a failed lookup.
      const fallback =
        id === this.inbox.owner_user_id
          ? 'you'
          : explicit || known.has(id) || /\d/.test(id)
            ? /^[UW]/.test(id)
              ? 'Slack member (name unavailable)'
              : id.startsWith('S')
                ? 'Slack group (name unavailable)'
                : 'Slack channel (name unavailable)'
            : id;
      const result = name ?? fallback;
      resolved.set(id, result);
      return result;
    };
    const humanize = async (value: string): Promise<string> => {
      const pattern = new RegExp(
        `\\b(?:${[...known].join('|')}|[UWCDGS][A-Z0-9]{8,12})\\b`,
        'g',
      );
      let result = '',
        last = 0;
      for (const match of value.matchAll(pattern)) {
        result += value.slice(last, match.index) + (await alias(match[0]));
        last = match.index + match[0].length;
      }
      return result + value.slice(last);
    };
    const link = async (
      target: string,
      title?: string,
    ): Promise<string | undefined> => {
      target = decode(target);
      try {
        const url = new URL(target);
        if (
          !['https:', 'http:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          /[\s<>|]/.test(target)
        )
          return undefined;
        // Preserve supplied destinations/labels; no fetch and no claim that the target was inspected.
        return `<${escapeSlack(target)}${title ? `|${escapeSlack((await humanize(decode(title))).replace(/[<>|\r\n]/g, ' '))}` : ''}>`;
      } catch {
        return undefined;
      }
    };
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s<>]+)\)/g, '<$2|$1>');
    const pattern = /<[^<>\n]*>|https?:\/\/[^\s<>]+/g;
    let rendered = '',
      last = 0;
    for (const match of text.matchAll(pattern)) {
      rendered += escapeSlack(await humanize(text.slice(last, match.index)));
      const token = match[0];
      let replacement: string | undefined;
      const mention = token.match(
        /^<(?:@([UWS][A-Z0-9]+)|#([CGD][A-Z0-9]+)|!subteam\^(S[A-Z0-9]+))(?:\|[^>]*)?>$/,
      );
      if (mention) {
        const id = mention[1] ?? mention[2] ?? mention[3];
        const name = await alias(id, true);
        replacement =
          /^[CGD]/.test(id) && this.origin
            ? `<${this.origin}/archives/${id}|${escapeSlack(name)}>`
            : escapeSlack(name);
      } else if (token.startsWith('<')) {
        const parts = token.slice(1, -1).split('|');
        if (parts.length <= 2) replacement = await link(parts[0], parts[1]);
      } else {
        const target = token.replace(/[.,;:!?]+$/, '');
        const formatted = await link(target);
        if (formatted)
          replacement = formatted + escapeSlack(token.slice(target.length));
      }
      rendered += replacement ?? escapeSlack(token);
      last = match.index + token.length;
    }
    return rendered + escapeSlack(await humanize(text.slice(last)));
  }
}
