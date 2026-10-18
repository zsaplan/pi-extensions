import path from 'node:path';
import {lstat} from 'node:fs/promises';
import {
  absent,
  digest,
  readJson,
  sourceKey,
  StoreError,
  type Task,
} from './store.ts';
import type {Receipt} from './intake.ts';

// Presentation only. Read the current registered source/root receipts, not a
// historical transcript, arbitrary thread replies or another task's evidence.
export async function ticketSourceText(
  root: string,
  task: Task,
): Promise<string[]> {
  const sources = task.sources
    .slice(0, 3)
    .flatMap(s => [s, {...s, message_ts: s.thread_ts ?? s.message_ts}]);
  const texts: string[] = [];
  for (const key of new Set(sources.map(sourceKey))) {
    const id = digest(key);
    const file = path.join(root, 'intake', 'receipts', id + '.json');
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size > 65536)
        throw new StoreError('invalid_ticket_source');
      const r = (await readJson(file)) as Receipt;
      if (
        r.schema_version !== 1 ||
        r.id !== id ||
        !r.source ||
        sourceKey(r.source) !== key ||
        typeof r.text !== 'string' ||
        r.content_hash !==
          digest(JSON.stringify({text: r.text, author: r.author_id}))
      )
        throw new StoreError('invalid_ticket_source');
      if (
        r.source.workspace_id === task.inbox.workspace_id &&
        r.disposition === 'routed' &&
        r.task_id === task.id &&
        r.content_source === 'conversation'
      )
        texts.push(r.text);
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  return texts;
}

// Only explicit destinations identify tickets. A bare key/number is not enough
// to guess a tenant. No network, mentions, link labels or session paths are used.
export function ticketLinks(texts: string[]): string[] {
  const links = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(/https:\/\/[^\s<>|]+/g)) {
      try {
        const url = new URL(match[0].replace(/[.,;:)!?]+$/, ''));
        if (url.username || url.password || url.port) continue;
        const jira = url.pathname.match(
          /^\/browse\/([A-Z][A-Z0-9_]{1,24}-[1-9][0-9]{0,17})\/?$/,
        );
        const zd = url.pathname.match(
          /^\/(?:agent\/tickets|hc\/(?:[a-z]{2}(?:-[a-z0-9]+)?\/)?requests)\/([1-9][0-9]{0,17})\/?$/,
        );
        let label: string;
        if (
          /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(url.hostname) &&
          jira
        )
          label = 'Jira ' + jira[1];
        else if (
          /^[a-z0-9][a-z0-9-]{0,62}\.zendesk\.com$/.test(url.hostname) &&
          zd
        )
          label = 'ZD #' + zd[1];
        else continue;
        const key = url.origin + ':' + label;
        // Preserve the supplied ticket route, not navigation/tracking/auth parameters.
        if (!links.has(key))
          links.set(key, '<' + url.origin + url.pathname + '|' + label + '>');
      } catch {
        // Malformed URLs are not ticket references.
      }
    }
  }
  return [...links.values()];
}

export function ticketRow(links: string[], available: number): string {
  const kept: string[] = [];
  const budget = Math.min(700, available);
  for (const link of links) {
    const remaining = links.length - kept.length - 1;
    const candidate =
      [...kept, link].join(' · ') +
      (remaining ? ' · +' + remaining + ' more in task context' : '');
    if (kept.length === 6 || candidate.length > budget) break;
    kept.push(link);
  }
  const omitted = links.length - kept.length;
  const row =
    kept.join(' · ') +
    (omitted
      ? (kept.length ? ' · +' : '') + omitted + ' more in task context'
      : '');
  return row.length <= budget ? row : '';
}
