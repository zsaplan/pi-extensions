import {
  checkRevision,
  readCanvas,
  requireRevision,
  requireSectionId,
  withCanvasWrite,
  type CanvasSnapshot,
} from './canvas.ts';
import {canvasSectionHtml, canvasView} from './canvas-view.ts';
import {publishingWrite, requireSlackId, requireText} from './publishing.ts';
import type {SlackApiCaller} from './slack.ts';

export interface SectionDeletion {
  canvasId: string;
  sectionId: string;
  expectedRevision: string;
  changeSummary: string;
}
export function validateSectionDeletion(input: SectionDeletion): void {
  requireSlackId(input.canvasId, 'F', 'canvasId');
  requireSectionId(input.sectionId);
  requireRevision(input.expectedRevision);
  requireText(input.changeSummary, 'changeSummary', 300);
  if (/[\r\n]/.test(input.changeSummary))
    throw new Error('changeSummary must be a single line.');
}
export function deletionPreview(
  snapshot: CanvasSnapshot,
  input: SectionDeletion,
) {
  validateSectionDeletion(input);
  checkRevision(snapshot, input.expectedRevision);
  if (snapshot.canvasId !== input.canvasId)
    throw new Error('Canvas ID does not match deletion request.');
  const {sections, ambiguousIds} = canvasView(snapshot);
  const target = sections.get(input.sectionId);
  if (
    !target ||
    ![
      'h1',
      'h2',
      'h3',
      'paragraph',
      'list_item',
      'pre',
      'blockquote',
      'ul',
      'ol',
      'table',
      'table_cell',
    ].includes(target.block.type)
  )
    throw new Error(
      'Target is absent or is not a supported deletable content block. No deletion attempted.',
    );
  const html = canvasSectionHtml(snapshot, input.sectionId);
  // Never approve a clipped preview. Larger containers must be cleaned up as smaller sections.
  if (Buffer.byteLength(html) > 4000)
    throw new Error(
      'Deletion preview exceeds 4,000 bytes. Select smaller sections; no deletion attempted.',
    );
  const affectedIds = [...sections]
    .filter(
      ([, section]) =>
        section.start !== undefined &&
        section.end !== undefined &&
        section.start >= target.start! &&
        section.end <= target.end!,
    )
    .map(([id]) => id);
  if (affectedIds.some(id => ambiguousIds.has(id)))
    throw new Error('Ambiguous repeated section IDs; no deletion attempted.');
  if (affectedIds.length > 20)
    throw new Error(
      'Deletion includes more than 20 section IDs. Select smaller sections; no deletion attempted.',
    );
  return {html, affectedIds};
}

// Slack documents one operation per API call, not an atomic multi-section transaction:
// https://docs.slack.dev/reference/methods/canvases.edit
export async function deleteCanvasSection(
  client: SlackApiCaller,
  token: string,
  input: SectionDeletion,
  signal?: AbortSignal,
) {
  validateSectionDeletion(input);
  return withCanvasWrite(
    input.canvasId,
    async () => {
      const before = await readCanvas(client, token, input.canvasId, signal);
      const preview = deletionPreview(before, input); // Re-read/check after human approval.
      signal?.throwIfAborted();
      const details = {
        canvasId: input.canvasId,
        sectionId: input.sectionId,
        affectedIds: preview.affectedIds,
        changeSummary: input.changeSummary,
        previousRevision: before.revision,
        timestamp: new Date().toISOString(),
      };
      try {
        await publishingWrite(
          () =>
            client.call(
              'canvases.edit',
              {
                canvas_id: input.canvasId,
                changes: [{operation: 'delete', section_id: input.sectionId}],
              },
              signal,
            ),
          `Canvas ${input.canvasId} section ${input.sectionId} deletion`,
        );
      } catch (error) {
        return {
          ...details,
          status: 'deletion_uncertain',
          error:
            error instanceof Error ? error.message : 'Deletion request failed.',
          warning:
            'The deletion request failed or its response was lost. It may have succeeded. Read the Canvas; do not retry blindly. No other deletion was attempted.',
        };
      }
      try {
        const after = await readCanvas(client, token, input.canvasId, signal);
        const remaining = canvasView(after).sections;
        if (preview.affectedIds.some(id => remaining.has(id)))
          throw new Error('Target still present.');
        return {
          ...details,
          status: 'section_deleted',
          revision: after.revision,
          warning:
            'Target IDs are absent on read-back. This is not an atomic conditional write or a guarantee against concurrent external changes.',
        };
      } catch {
        return {
          ...details,
          status: 'deletion_acknowledged_unverified',
          warning:
            'Slack acknowledged deletion, but read-back could not verify all target IDs were removed. Inspect the Canvas; do not repeat the deletion blindly.',
        };
      }
    },
    signal,
  );
}
