import type {JiraConfig} from './config.ts';

export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
  [key: string]: unknown;
}

const INLINE_MARKUP =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function markedText(
  value: string,
  type: string,
  attrs?: Record<string, unknown>,
) {
  return {
    type: 'text',
    text: value,
    marks: [{type, ...(attrs ? {attrs} : {})}],
  } satisfies AdfNode;
}

function inlineToAdf(value: string): AdfNode[] {
  const content: AdfNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(INLINE_MARKUP)) {
    const index = match.index ?? 0;
    if (index > offset)
      content.push({type: 'text', text: value.slice(offset, index)});
    const token = match[0];
    if (token.startsWith('`')) {
      content.push(markedText(token.slice(1, -1), 'code'));
    } else if (token.startsWith('**')) {
      content.push(markedText(token.slice(2, -2), 'strong'));
    } else if (token.startsWith('*')) {
      content.push(markedText(token.slice(1, -1), 'em'));
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      content.push(
        link
          ? markedText(link[1], 'link', {href: link[2]})
          : {type: 'text', text: token},
      );
    }
    offset = index + token.length;
  }
  if (offset < value.length)
    content.push({type: 'text', text: value.slice(offset)});
  return content;
}

function paragraph(lines: string[]): AdfNode {
  const content: AdfNode[] = [];
  for (const [index, line] of lines.entries()) {
    if (index) content.push({type: 'hardBreak'});
    content.push(...inlineToAdf(line));
  }
  return {type: 'paragraph', ...(content.length ? {content} : {})};
}

function isUppercaseHeading(line: string): boolean {
  const letters = line.match(/[A-Za-z]/g);
  return (
    line.length <= 80 &&
    Boolean(letters?.length) &&
    letters?.every(letter => letter === letter.toUpperCase()) === true &&
    !/[.!?:;,]$/.test(line)
  );
}

function listMatch(line: string) {
  return /^\s*(?:[-+*]|•)\s+(.+)$/.exec(line);
}

function orderedListMatch(line: string) {
  return /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(value => value.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return (
    cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function tableCell(value: string, header: boolean): AdfNode {
  return {
    type: header ? 'tableHeader' : 'tableCell',
    content: [paragraph([value])],
  };
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  const next = lines[index + 1] ?? '';
  return (
    /^```/.test(line) ||
    /^\s*#{1,6}\s+/.test(line) ||
    /^>\s*/.test(line) ||
    listMatch(line) !== null ||
    orderedListMatch(line) !== null ||
    /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line) ||
    (line.includes('|') && isTableSeparator(next)) ||
    isUppercaseHeading(line.trim())
  );
}

function markdownBlocks(lines: string[]): AdfNode[] {
  const content: AdfNode[] = [];
  let index = 0;
  let uppercaseHeadingCount = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const codeText = code.join('\n');
      content.push({
        type: 'codeBlock',
        ...(fence[1] ? {attrs: {language: fence[1]}} : {}),
        ...(codeText ? {content: [{type: 'text', text: codeText}]} : {}),
      });
      continue;
    }

    const callout =
      /^>\s*\[!(INFO|NOTE|TIP|WARNING|ERROR|SUCCESS)\]\s*(.*)$/i.exec(line);
    if (callout) {
      const body = callout[2] ? [callout[2]] : [];
      index += 1;
      while (index < lines.length) {
        const quote = /^>\s?(.*)$/.exec(lines[index]);
        if (!quote) break;
        body.push(quote[1]);
        index += 1;
      }
      const panelType =
        callout[1].toLowerCase() === 'tip' ? 'info' : callout[1].toLowerCase();
      const panelContent = markdownBlocks(body);
      content.push({
        type: 'panel',
        attrs: {panelType},
        content: panelContent.length ? panelContent : [paragraph([])],
      });
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      content.push({
        type: 'heading',
        attrs: {level: heading[1].length},
        content: inlineToAdf(heading[2].trim()),
      });
      index += 1;
      continue;
    }

    if (isUppercaseHeading(line.trim())) {
      content.push({
        type: 'heading',
        attrs: {level: uppercaseHeadingCount === 0 ? 2 : 3},
        content: inlineToAdf(line.trim()),
      });
      uppercaseHeadingCount += 1;
      index += 1;
      continue;
    }

    const bullet = listMatch(line);
    if (bullet) {
      const items: AdfNode[] = [];
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item) break;
        items.push({type: 'listItem', content: [paragraph([item[1]])]});
        index += 1;
      }
      content.push({type: 'bulletList', content: items});
      continue;
    }

    const ordered = orderedListMatch(line);
    if (ordered) {
      const order = Number(ordered[1]);
      const items: AdfNode[] = [];
      while (index < lines.length) {
        const item = orderedListMatch(lines[index]);
        if (!item) break;
        items.push({type: 'listItem', content: [paragraph([item[2]])]});
        index += 1;
      }
      content.push({
        type: 'orderedList',
        ...(order === 1 ? {} : {attrs: {order}}),
        content: items,
      });
      continue;
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|')) {
        const row = splitTableRow(lines[index]);
        if (row.length !== headers.length) break;
        rows.push(row);
        index += 1;
      }
      content.push({
        type: 'table',
        attrs: {isNumberColumnEnabled: false, layout: 'default'},
        content: [headers, ...rows].map((row, rowIndex) => ({
          type: 'tableRow',
          content: row.map(value => tableCell(value, rowIndex === 0)),
        })),
      });
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      content.push({type: 'rule'});
      index += 1;
      continue;
    }

    if (/^>\s*/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length) {
        const match = /^>\s?(.*)$/.exec(lines[index]);
        if (!match) break;
        quote.push(match[1]);
        index += 1;
      }
      content.push({type: 'blockquote', content: markdownBlocks(quote)});
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !startsBlock(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    content.push(paragraph(paragraphLines));
  }

  return content;
}

/** Convert Jira-flavored Markdown into Atlassian Document Format. */
export function textToAdf(text: string): AdfNode {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const content = markdownBlocks(lines);
  return {
    type: 'doc',
    version: 1,
    content: content.length ? content : [paragraph([])],
  };
}

export function adfToText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as AdfNode;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const children = node.content ?? [];
  if (
    node.type === 'doc' ||
    node.type === 'panel' ||
    node.type === 'blockquote'
  )
    return children.map(child => adfToText(child).trimEnd()).join('\n\n');
  const childText = children.map(adfToText).join('');
  if (
    node.type === 'paragraph' ||
    node.type === 'heading' ||
    node.type === 'codeBlock'
  )
    return `${childText}\n`;
  if (node.type === 'bulletList')
    return children.map(child => `- ${adfToText(child).trim()}\n`).join('');
  if (node.type === 'orderedList') {
    const start = Number(
      (node.attrs as {order?: number} | undefined)?.order ?? 1,
    );
    return children
      .map((child, index) => `${start + index}. ${adfToText(child).trim()}\n`)
      .join('');
  }
  if (node.type === 'tableRow')
    return `${children.map(child => adfToText(child).trim()).join('\t')}\n`;
  return childText;
}

export class JiraApiError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly payload: unknown;

  constructor(method: string, path: string, status: number, payload: unknown) {
    const detail = jiraErrorDetail(payload);
    super(
      `Jira API ${method} ${path} failed with HTTP ${status}${
        detail ? `: ${detail}` : ''
      }.`,
    );
    this.name = 'JiraApiError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.payload = payload;
  }
}

function jiraErrorDetail(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const messages = Array.isArray(record.errorMessages)
    ? record.errorMessages.filter(value => typeof value === 'string')
    : [];
  const errors =
    record.errors && typeof record.errors === 'object'
      ? Object.entries(record.errors as Record<string, unknown>).map(
          ([field, message]) => `${field}: ${String(message)}`,
        )
      : [];
  return [...messages, ...errors].join('; ') || undefined;
}

export interface JiraRequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface JiraApiCaller {
  request<T>(path: string, options?: JiraRequestOptions): Promise<T>;
}

export class JiraClient implements JiraApiCaller {
  private readonly config: JiraConfig;

  constructor(config: JiraConfig) {
    this.config = config;
  }

  async request<T>(path: string, options: JiraRequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(
          `${this.config.username}:${this.config.apiToken}`,
        ).toString('base64')}`,
        ...(options.body === undefined
          ? {}
          : {'Content-Type': 'application/json'}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    let payload: unknown = undefined;
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }
    if (!response.ok)
      throw new JiraApiError(method, path, response.status, payload);
    return payload as T;
  }
}

export interface JiraUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
}

export interface JiraIssue {
  id?: string;
  key?: string;
  self?: string;
  fields?: Record<string, unknown>;
}

export interface JiraComment {
  id?: string;
  author?: JiraUser;
  body?: AdfNode;
  created?: string;
  updated?: string;
}

export async function getMyself(client: JiraApiCaller, signal?: AbortSignal) {
  return client.request<JiraUser>('/rest/api/3/myself', {signal});
}

export async function getIssue(
  client: JiraApiCaller,
  issueKey: string,
  fields: string[] | undefined,
  signal?: AbortSignal,
) {
  return client.request<JiraIssue>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {query: {fields: fields?.join(',')}, signal},
  );
}

export async function searchIssues(
  client: JiraApiCaller,
  options: {
    jql: string;
    fields: string[];
    maxResults: number;
    nextPageToken?: string;
  },
  signal?: AbortSignal,
) {
  return client.request<{
    issues?: JiraIssue[];
    nextPageToken?: string;
    isLast?: boolean;
  }>('/rest/api/3/search/jql', {method: 'POST', body: options, signal});
}

export async function listProjects(
  client: JiraApiCaller,
  options: {query?: string; startAt: number; maxResults: number},
  signal?: AbortSignal,
) {
  return client.request<Record<string, unknown>>('/rest/api/3/project/search', {
    query: options,
    signal,
  });
}

export async function getCreateMetadata(
  client: JiraApiCaller,
  projectIdOrKey: string,
  issueTypeId: string | undefined,
  signal?: AbortSignal,
) {
  const suffix = issueTypeId ? `/${encodeURIComponent(issueTypeId)}` : '';
  return client.request<Record<string, unknown>>(
    `/rest/api/3/issue/createmeta/${encodeURIComponent(projectIdOrKey)}/issuetypes${suffix}`,
    {signal},
  );
}

export async function createIssue(
  client: JiraApiCaller,
  fields: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return client.request<{id?: string; key?: string; self?: string}>(
    '/rest/api/3/issue',
    {method: 'POST', body: {fields}, signal},
  );
}

export async function editIssue(
  client: JiraApiCaller,
  issueKey: string,
  fields: Record<string, unknown>,
  signal?: AbortSignal,
) {
  await client.request<void>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      method: 'PUT',
      body: {fields},
      signal,
    },
  );
}

export async function getTransitions(
  client: JiraApiCaller,
  issueKey: string,
  signal?: AbortSignal,
) {
  return client.request<{transitions?: Array<Record<string, unknown>>}>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    {signal},
  );
}

export async function transitionIssue(
  client: JiraApiCaller,
  issueKey: string,
  transitionId: string,
  signal?: AbortSignal,
) {
  await client.request<void>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    {method: 'POST', body: {transition: {id: transitionId}}, signal},
  );
}

export async function listComments(
  client: JiraApiCaller,
  issueKey: string,
  options: {startAt: number; maxResults: number},
  signal?: AbortSignal,
) {
  return client.request<{comments?: JiraComment[]; total?: number}>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    {query: options, signal},
  );
}

export async function addComment(
  client: JiraApiCaller,
  issueKey: string,
  body: AdfNode,
  signal?: AbortSignal,
) {
  return client.request<JiraComment>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    {method: 'POST', body: {body}, signal},
  );
}

export async function editComment(
  client: JiraApiCaller,
  issueKey: string,
  commentId: string,
  body: AdfNode,
  signal?: AbortSignal,
) {
  return client.request<JiraComment>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
    {method: 'PUT', body: {body}, signal},
  );
}
