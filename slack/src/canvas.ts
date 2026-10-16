import {createHash} from 'node:crypto';
import {publishingWrite, requireSlackId, requireText} from './publishing.ts';
import {type SlackApiCaller, type SlackApiEnvelope} from './slack.ts';

export const MAX_CANVAS_EXPORT_BYTES = 4 * 1024 * 1024;
export const MAX_CANVAS_PAGE_CHARS = 12000;
export const SECTION_OPERATIONS = [
  'replace',
  'insert_before',
  'insert_after',
] as const;
export interface CanvasSnapshot {
  canvasId: string;
  title?: string;
  html: string;
  revision: string;
}

export function requireRevision(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error(
      'expectedRevision must be the SHA-256 revision returned by slack_read_canvas.',
    );
}

export function requireSectionId(value: string): void {
  if (!/^temp:C:[A-Za-z0-9]+$/.test(value))
    throw new Error(
      'sectionId must be a Slack section ID returned by lookup/current Canvas HTML.',
    );
}

export function checkRevision(
  snapshot: CanvasSnapshot,
  expectedRevision?: string,
): void {
  if (expectedRevision !== undefined) {
    requireRevision(expectedRevision);
    if (snapshot.revision !== expectedRevision)
      throw new Error(
        `Canvas ${snapshot.canvasId} changed since it was read. No edit was made. Read it again and reconcile human/new edits before retrying.`,
      );
  }
}

export async function readCanvas(
  client: SlackApiCaller,
  token: string,
  canvasId: string,
  signal?: AbortSignal,
): Promise<CanvasSnapshot> {
  requireSlackId(canvasId, 'F', 'canvasId');
  signal?.throwIfAborted();
  const {file} = await client.call<
    SlackApiEnvelope & {
      file?: {
        id: string;
        title?: string;
        mimetype?: string;
        url_private?: string;
      };
    }
  >('files.info', {file: canvasId}, signal);
  if (
    file?.id !== canvasId ||
    file.mimetype !== 'application/vnd.slack-docs' ||
    !file.url_private
  )
    throw new Error(
      'The requested file is not an accessible Canvas with a content export.',
    );
  let response: Response;
  try {
    const url = new URL(file.url_private);
    // Only the authenticated URL returned by Slack, restricted to the requested file.
    // Never follow redirects with the bot token or accept arbitrary caller URLs.
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'files.slack.com' ||
      url.port ||
      url.username ||
      url.password ||
      !url.pathname.startsWith('/files-pri/') ||
      !url.pathname.split('/').some(part => part.endsWith(`-${canvasId}`))
    ) {
      throw new Error('Unexpected export URL.');
    }
    response = await fetch(url, {
      headers: {Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache'},
      redirect: 'error',
      signal,
    });
  } catch {
    throw new Error(
      `Canvas ${canvasId} export download failed or was cancelled. No edit was made. Private URL omitted.`,
    );
  }
  if (
    !response.ok ||
    !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')
  ) {
    await response.body?.cancel();
    throw new Error(
      `Canvas ${canvasId} export did not return HTML (HTTP ${response.status}). No edit was made.`,
    );
  }
  if (
    Number(response.headers.get('content-length')) > MAX_CANVAS_EXPORT_BYTES
  ) {
    await response.body?.cancel();
    throw new Error(
      'Canvas export exceeds the 4 MiB safety limit. No edit was made.',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Canvas export returned no body.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CANVAS_EXPORT_BYTES) throw new Error('Export too large.');
      chunks.push(value);
    }
  } catch {
    throw new Error(
      'Canvas export interrupted or exceeded the 4 MiB limit. No edit was made; private URL omitted.',
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const html = Buffer.concat(chunks).toString('utf8');
  // Reject login/error pages instead of treating them as a new document revision.
  if (!html.includes('class="quip-canvas-content"'))
    throw new Error('Unrecognized Canvas export format. No edit was made.');
  const revision = createHash('sha256')
    .update(JSON.stringify([file.title ?? '', html]))
    .digest('hex');
  return {canvasId, title: file.title, html, revision};
}

export function canvasPage(
  snapshot: CanvasSnapshot,
  offset = 0,
  limit = MAX_CANVAS_PAGE_CHARS,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > snapshot.html.length
  )
    throw new Error('offset must be a valid Canvas character offset.');
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_CANVAS_PAGE_CHARS
  )
    throw new Error(`limit must be 1–${MAX_CANVAS_PAGE_CHARS} characters.`);
  const end = Math.min(offset + limit, snapshot.html.length);
  return {
    canvasId: snapshot.canvasId,
    title: snapshot.title,
    revision: snapshot.revision,
    format: 'html',
    offset,
    totalCharacters: snapshot.html.length,
    nextOffset: end < snapshot.html.length ? end : undefined,
    truncated: offset > 0 || end < snapshot.html.length,
    html: snapshot.html.slice(offset, end),
  };
}

export async function findCanvasSections(
  client: SlackApiCaller,
  canvasId: string,
  containsText: string,
  sectionType?: string,
  signal?: AbortSignal,
) {
  requireSlackId(canvasId, 'F', 'canvasId');
  requireText(containsText, 'containsText', 500);
  const types = [
    'any_header',
    'h1',
    'h2',
    'h3',
    'blockquote',
    'callout',
    'table',
    'list',
  ];
  if (sectionType !== undefined && !types.includes(sectionType))
    throw new Error('Unsupported sectionType. Omit it for a text-only search.');
  const response = await client.call<
    SlackApiEnvelope & {sections?: {id: string}[]}
  >(
    'canvases.sections.lookup',
    {
      canvas_id: canvasId,
      criteria: {
        contains_text: containsText,
        ...(sectionType ? {section_types: [sectionType]} : {}),
      },
    },
    signal,
  );
  if (!Array.isArray(response.sections))
    throw new Error('Slack section lookup returned no section list.');
  return {
    canvasId,
    sections: response.sections
      .slice(0, 100)
      .map(section => ({id: section.id})),
    truncated: response.sections.length > 100,
    totalMatches: response.sections.length,
  };
}

const writes = new Map<string, Promise<void>>();
// Serialize this process's content edits. This cannot lock Slack UI/other agents.
export async function withCanvasWrite<T>(
  canvasId: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = writes.get(canvasId) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  writes.set(canvasId, pending);
  try {
    await previous;
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
    if (writes.get(canvasId) === pending) writes.delete(canvasId);
  }
}

export interface SectionEdit {
  canvasId: string;
  sectionId: string;
  operation: string;
  markdown: string;
  expectedRevision: string;
  changeSummary: string;
  appendRevisionNote?: boolean;
}

export function validateSectionEdit(input: SectionEdit): void {
  requireSlackId(input.canvasId, 'F', 'canvasId');
  requireSectionId(input.sectionId);
  requireRevision(input.expectedRevision);
  if (
    !SECTION_OPERATIONS.includes(
      input.operation as (typeof SECTION_OPERATIONS)[number],
    )
  )
    throw new Error(
      'operation must be replace, insert_before, or insert_after.',
    );
  requireText(input.markdown, 'markdown');
  if (
    input.appendRevisionNote !== undefined &&
    typeof input.appendRevisionNote !== 'boolean'
  )
    throw new Error('appendRevisionNote must be a boolean.');
  requireText(input.changeSummary, 'changeSummary', 300);
  if (/[\r\n]/.test(input.changeSummary))
    throw new Error('changeSummary must be a single line.');
}

export async function editCanvasSection(
  client: SlackApiCaller,
  token: string,
  input: SectionEdit,
  signal?: AbortSignal,
) {
  validateSectionEdit(input);
  return withCanvasWrite(
    input.canvasId,
    async () => {
      const current = await readCanvas(client, token, input.canvasId, signal);
      checkRevision(current, input.expectedRevision);
      // Presence check is not an HTML-to-Markdown transformation. Slack IDs remain exact.
      if (
        !current.html.includes(`id="${input.sectionId}"`) &&
        !current.html.includes(`id='${input.sectionId}'`)
      )
        throw new Error(
          'The target section is absent from the current export. No edit was made; look it up again.',
        );
      signal?.throwIfAborted();
      await publishingWrite(
        () =>
          client.call(
            'canvases.edit',
            {
              canvas_id: input.canvasId,
              changes: [
                {
                  operation: input.operation,
                  section_id: input.sectionId,
                  document_content: {
                    type: 'markdown',
                    markdown: input.markdown,
                  },
                },
              ],
            },
            signal,
          ),
        `Canvas ${input.canvasId} section ${input.sectionId} edit`,
      );
      const timestamp = new Date().toISOString();
      if (!input.appendRevisionNote)
        return {
          canvasId: input.canvasId,
          sectionId: input.sectionId,
          operation: input.operation,
          status: 'section_updated',
          changeSummary: input.changeSummary,
          timestamp,
          previousRevision: current.revision,
          warning:
            'Best-effort stale-read check, not an atomic conditional write. Read the Canvas again before the next edit.',
        };
      const summary = input.changeSummary.replace(
        /[\\`*_{}[\]()<>#+.!|]/g,
        '\\$&',
      );
      try {
        await publishingWrite(
          () =>
            client.call(
              'canvases.edit',
              {
                canvas_id: input.canvasId,
                changes: [
                  {
                    operation: 'insert_at_end',
                    document_content: {
                      type: 'markdown',
                      markdown: `\n\n_Revision ${timestamp}_ — ${summary}\n`,
                    },
                  },
                ],
              },
              signal,
            ),
          `Canvas ${input.canvasId} revision note`,
        );
      } catch {
        throw new Error(
          `Canvas ${input.canvasId} section ${input.sectionId} edit SUCCEEDED, but the revision note failed or has an uncertain outcome. Read the Canvas before repairing the note; do NOT repeat the section edit.`,
        );
      }
      return {
        canvasId: input.canvasId,
        sectionId: input.sectionId,
        operation: input.operation,
        status: 'section_updated_and_revision_noted',
        changeSummary: input.changeSummary,
        timestamp,
        previousRevision: current.revision,
        warning:
          'Best-effort stale-read check, not an atomic conditional write. Read the Canvas again before the next edit.',
      };
    },
    signal,
  );
}
