import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import type {SlackWriteConfirmationOptions} from './approvals.ts';
import {withCanvasWrite} from './canvas.ts';
import {registerCanvasTools} from './canvas-tools.ts';
import {readSlackUploadLimit, type SlackConfig} from './config.ts';
import {
  canvasAccess,
  canvasChange,
  createCanvas,
  getFileInfo,
  prepareUpload,
  publishingWrite,
  requireRegularChannel,
  requireSlackId,
  requireText,
  uploadFile,
} from './publishing.ts';
import {resolveConversation, type SlackApiCaller} from './slack.ts';

export interface PublishingDependencies {
  client: () => {client: SlackApiCaller; config: SlackConfig};
  confirm: (
    config: SlackConfig,
    ctx: ExtensionContext,
    options: SlackWriteConfirmationOptions,
  ) => Promise<void>;
  result: (
    text: string,
    details?: Record<string, unknown>,
  ) => {
    content: {type: 'text'; text: string}[];
    details: Record<string, unknown>;
  };
}

const confirm = Type.Optional(
  Type.Boolean({
    description:
      'Required with PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1 for non-interactive writes.',
  }),
);
const canvasId = Type.String({
  pattern: '^F[A-Z0-9]+$',
  description: 'Slack Canvas ID (F...).',
});
const markdown = Type.String({
  minLength: 1,
  maxLength: 1048576,
  description:
    'Native Canvas Markdown; headings, tables, lists, code blocks, and links are preserved.',
});
const title = Type.String({minLength: 1, maxLength: 250});

function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(120000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function preview(value: string): string {
  return value.length > 1000
    ? `${value.slice(0, 1000)}\n[Preview truncated]`
    : value;
}

export function registerPublishingTools(
  pi: ExtensionAPI,
  deps: PublishingDependencies,
): void {
  registerCanvasTools(pi, deps);
  const result = (details: Record<string, unknown>) =>
    deps.result(JSON.stringify(details, null, 2), details);
  pi.registerTool({
    name: 'slack_create_canvas',
    label: 'Slack Create Canvas',
    description:
      'Create a titled Canvas from Markdown using the bot token. Optional channel creates a channel tab with write access. No automatic announcement.',
    promptSnippet: 'Create a durable formatted Slack report as a Canvas.',
    promptGuidelines: [
      'Use slack_create_canvas only when requested. Write a concise current-state report for decision makers: Summary, Key findings and impact, Important unknowns, References/appendix. Keep findings-only unless recommendations are explicitly requested; avoid the phrase "bottom line". Keep technical chronology in the thread and material uncertainty prominent.',
      'slack_create_canvas channel placement grants channel write access; omit channel for no audience sharing. A created Canvas is not proof that the intended audience can read it.',
      'After slack_create_canvas, use slack_get_file_info for an API-returned permalink; do not invent links.',
    ],
    parameters: Type.Object({
      title,
      markdown,
      channel: Type.Optional(
        Type.String({
          description:
            'Regular channel ID or #name. Adds a channel tab with write access; not merely a read-only announcement.',
        }),
      ),
      confirm,
    }),
    async execute(_id, params, signal, _update, ctx) {
      requireText(params.title, 'title', 250);
      requireText(params.markdown, 'markdown');
      const {client, config} = deps.client();
      const channel = params.channel
        ? await resolveConversation(client, params.channel, deadline(signal))
        : undefined;
      if (channel)
        await requireRegularChannel(client, channel.id, deadline(signal));
      await deps.confirm(config, ctx, {
        title: 'Create Slack Canvas?',
        target: channel
          ? `${channel.id}: channel tab with WRITE access`
          : 'No audience sharing requested',
        preview: `${params.title}\n${params.markdown.length} characters\n${preview(params.markdown)}`,
        confirm: params.confirm,
      });
      signal?.throwIfAborted();
      return result(
        await createCanvas(
          client,
          params.title,
          params.markdown,
          channel?.id,
          deadline(signal),
        ),
      );
    },
  });
  pi.registerTool({
    name: 'slack_edit_canvas',
    label: 'Slack Edit Canvas',
    description:
      'Append, prepend, replace the entire Canvas, or rename it. One operation per call. Bot token and write confirmation required.',
    promptSnippet: 'Update a Slack Canvas without reposting it.',
    promptGuidelines: [
      'Use slack_edit_canvas only for requested edits. Prefer slack_read_canvas and slack_edit_canvas_section for ongoing polishing. This legacy whole-document tool has no stale-read guard; replace overwrites human edits. Never blindly retry an uncertain append.',
      'slack_edit_canvas append/prepend/rename may reuse an exact Canvas session grant; whole-document replace still requires separate approval.',
      'For slack_edit_canvas report updates, revise the current findings rather than accumulating follow-up chapters. Keep recommendations out unless requested and avoid the phrase "bottom line"; technical detail belongs primarily in the thread or appendix.',
    ],
    parameters: Type.Object({
      canvasId,
      operation: Type.String({
        enum: ['append', 'prepend', 'replace', 'rename'],
      }),
      markdown: Type.Optional(markdown),
      title: Type.Optional(title),
      confirm,
    }),
    async execute(_id, params, signal, _update, ctx) {
      requireSlackId(params.canvasId, 'F', 'canvasId');
      const change = canvasChange(
        params.operation,
        params.markdown,
        params.title,
      );
      const {client, config} = deps.client();
      await deps.confirm(config, ctx, {
        title:
          params.operation === 'replace'
            ? 'REPLACE ENTIRE Slack Canvas?'
            : 'Edit Slack Canvas?',
        target: params.canvasId,
        preview: `${params.operation}\n${preview(params.markdown ?? params.title ?? '')}`,
        confirm: params.confirm,
        canvasScope:
          params.operation === 'replace'
            ? undefined
            : {canvasId: params.canvasId},
        signal,
      });
      signal?.throwIfAborted();
      await withCanvasWrite(
        params.canvasId,
        () =>
          publishingWrite(
            () =>
              client.call(
                'canvases.edit',
                {canvas_id: params.canvasId, changes: [change]},
                deadline(signal),
              ),
            `Canvas ${params.canvasId} ${params.operation}`,
          ),
        signal,
      );
      return result({
        canvasId: params.canvasId,
        operation: params.operation,
        status: 'updated',
      });
    },
  });
  pi.registerTool({
    name: 'slack_set_canvas_access',
    label: 'Slack Set Canvas Access',
    description:
      'Set read/write access for either regular channel IDs or individual user IDs. No ownership transfer. Share the Canvas link with the target first as required by Slack.',
    promptSnippet: 'Set explicit audience permissions for a Slack Canvas.',
    promptGuidelines: [
      'Use slack_set_canvas_access only for explicitly requested recipients and access levels. Link sharing and permission changes are separate operations.',
      'slack_set_canvas_access accepts regular channel IDs, not DM/MPDM IDs. For individual users, Slack requires sharing the Canvas directly with the user first; channel membership alone is insufficient.',
    ],
    parameters: Type.Object({
      canvasId,
      accessLevel: Type.String({enum: ['read', 'write']}),
      channelIds: Type.Optional(
        Type.Array(Type.String({pattern: '^[CG][A-Z0-9]+$'}), {
          minItems: 1,
          maxItems: 20,
        }),
      ),
      userIds: Type.Optional(
        Type.Array(Type.String({pattern: '^[UW][A-Z0-9]+$'}), {
          minItems: 1,
          maxItems: 20,
        }),
      ),
      confirm,
    }),
    async execute(_id, params, signal, _update, ctx) {
      const body = canvasAccess(
        params.canvasId,
        params.accessLevel,
        params.channelIds,
        params.userIds,
      );
      const {client, config} = deps.client();
      // G-prefixed IDs may also identify MPDMs. Check conversation type before mutation.
      if (params.channelIds) {
        for (const channel of params.channelIds) {
          await requireRegularChannel(client, channel, deadline(signal));
        }
      }
      await deps.confirm(config, ctx, {
        title: 'Change Slack Canvas access?',
        target: params.canvasId,
        preview: `${params.accessLevel.toUpperCase()} access for ${(params.channelIds ?? params.userIds ?? []).join(', ')}`,
        confirm: params.confirm,
      });
      signal?.throwIfAborted();
      await publishingWrite(
        () => client.call('canvases.access.set', body, deadline(signal)),
        `Canvas ${params.canvasId} access change`,
      );
      return result({
        canvasId: params.canvasId,
        accessLevel: params.accessLevel,
        channelIds: params.channelIds,
        userIds: params.userIds,
        status: 'access_set',
      });
    },
  });
  pi.registerTool({
    name: 'slack_upload_file',
    label: 'Slack Upload File or Snippet',
    description:
      'Upload one local file or inline text using the bot token and current external-upload API. Optional snippetType enables syntax formatting. Defaults to private. Size limit defaults to 20 MiB.',
    promptSnippet:
      'Upload evidence, reports, images, or syntax-formatted snippets to Slack.',
    promptGuidelines: [
      'Use slack_upload_file only when the user requests uploading the selected file/content to Slack. Provide exactly one of path or content.',
      'slack_upload_file uploads are private without channel. threadTs must be the parent message timestamp. A session thread grant covers uploads only to that exact thread. Do not upload an entire session or unrelated sensitive evidence.',
      'slack_upload_file snippetType is for source/logs/SQL; a Markdown snippet is not a rendered Canvas. Keep initialComment short and use message mrkdwn.',
      'If slack_upload_file reports a failed or uncertain stage, inspect the returned fileId with slack_get_file_info before deciding whether to retry.',
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            'Local regular file path, relative to the session working directory or absolute.',
        }),
      ),
      content: Type.Optional(
        Type.String({description: 'Inline UTF-8 content; requires filename.'}),
      ),
      filename: Type.Optional(Type.String({minLength: 1, maxLength: 255})),
      title: Type.Optional(title),
      snippetType: Type.Optional(
        Type.String({
          description: 'Slack syntax identifier, such as sql, python, or text.',
        }),
      ),
      altText: Type.Optional(Type.String({maxLength: 1000})),
      channel: Type.Optional(
        Type.String({
          description: 'Channel ID or #name; omitted means private.',
        }),
      ),
      threadTs: Type.Optional(Type.String()),
      initialComment: Type.Optional(Type.String({maxLength: 3500})),
      confirm,
    }),
    async execute(_id, params, signal, _update, ctx) {
      const prepared = await prepareUpload(
        params,
        ctx.cwd,
        readSlackUploadLimit(),
        signal,
      );
      const {client, config} = deps.client();
      const channel = params.channel
        ? await resolveConversation(client, params.channel, deadline(signal))
        : undefined;
      const target = channel
        ? `${channel.id}${params.threadTs ? ` thread ${params.threadTs}` : ''}`
        : 'PRIVATE (not shared to a channel)';
      await deps.confirm(config, ctx, {
        title: 'Upload Slack file?',
        target,
        threadScope:
          channel && params.threadTs
            ? {channelId: channel.id, parentThreadTs: params.threadTs}
            : undefined,
        signal,
        preview: `Source: ${prepared.source}\nFilename: ${prepared.filename}\nTitle: ${params.title ?? prepared.filename}\nBytes: ${prepared.bytes.length}\nSyntax: ${params.snippetType ?? 'file'}\n${params.initialComment ? `Comment: ${preview(params.initialComment)}\n` : ''}${params.content !== undefined || params.snippetType ? preview(prepared.bytes.subarray(0, 1000).toString('utf8')) : '(Binary/file content not previewed)'}`,
        confirm: params.confirm,
      });
      signal?.throwIfAborted();
      return result(
        await uploadFile(
          client,
          {...params, channel: channel?.id},
          prepared,
          deadline(signal),
        ),
      );
    },
  });
  pi.registerTool({
    name: 'slack_get_file_info',
    label: 'Slack File Info',
    description:
      'Get bounded file/Canvas metadata, sharing fields and an available permalink, not file contents or signed download URLs. Defaults to bot token for newly created artifacts.',
    promptSnippet:
      'Inspect Slack file/Canvas metadata and available permalinks.',
    promptGuidelines: [
      'Use slack_get_file_info after Canvas creation or an uncertain upload. Metadata is not proof that another user can access the artifact.',
    ],
    parameters: Type.Object({fileId: canvasId}),
    async execute(_id, params, signal) {
      const {client} = deps.client();
      return result({
        ...(await getFileInfo(client, params.fileId, deadline(signal))),
      });
    },
  });
}
