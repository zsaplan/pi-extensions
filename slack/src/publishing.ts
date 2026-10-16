import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, resolve} from 'node:path';
import {
  SlackApiError,
  collectSlackWarnings,
  type SlackApiCaller,
  type SlackApiEnvelope,
} from './slack.ts';

export const CANVAS_MARKDOWN_LIMIT = 1048576;

export function requireText(
  value: string,
  name: string,
  limit = CANVAS_MARKDOWN_LIMIT,
): string {
  if (!value.trim() || value.length > limit) {
    throw new Error(
      `${name} must contain 1–${limit} characters (not whitespace only).`,
    );
  }
  return value;
}

export function requireSlackId(
  value: string,
  prefix: string,
  name: string,
): string {
  if (!new RegExp(`^[${prefix}][A-Z0-9]+$`).test(value)) {
    throw new Error(`${name} must be a Slack ID, not a name or URL.`);
  }
  return value;
}

export async function requireRegularChannel(
  client: SlackApiCaller,
  channel: string,
  signal?: AbortSignal,
): Promise<void> {
  requireSlackId(channel, 'CG', 'channel');
  const info = await client.call<
    SlackApiEnvelope & {channel?: {is_im?: boolean; is_mpim?: boolean}}
  >('conversations.info', {channel}, signal);
  if (!info.channel || info.channel.is_im || info.channel.is_mpim) {
    throw new Error(
      'Canvas placement/access requires a regular channel, not a DM/MPDM.',
    );
  }
}

export interface FileMetadata {
  id: string;
  title?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  permalink?: string;
  is_public?: boolean;
  channels?: string[];
  groups?: string[];
  ims?: string[];
  sharingTruncated?: boolean;
}

// Allowlist returned fields: do not expose download URLs, edit links, or full file content.
export function fileMetadata(file: FileMetadata): FileMetadata {
  return {
    id: file.id,
    title: file.title,
    name: file.name,
    mimetype: file.mimetype,
    filetype: file.filetype,
    size: file.size,
    permalink: file.permalink,
    is_public: file.is_public,
    channels: file.channels?.slice(0, 50),
    groups: file.groups?.slice(0, 50),
    ims: file.ims?.slice(0, 50),
    sharingTruncated: [file.channels, file.groups, file.ims].some(
      ids => (ids?.length ?? 0) > 50,
    ),
  };
}

export async function getFileInfo(
  client: SlackApiCaller,
  fileId: string,
  signal?: AbortSignal,
): Promise<FileMetadata> {
  requireSlackId(fileId, 'F', 'fileId');
  const response = await client.call<SlackApiEnvelope & {file: FileMetadata}>(
    'files.info',
    {file: fileId},
    signal,
  );
  if (!response.file?.id)
    throw new Error('Slack files.info returned no file metadata.');
  return fileMetadata(response.file);
}

// Mutations are never retried. Transport failures can mean Slack applied the write.
export async function publishingWrite<T>(
  operation: () => Promise<T>,
  stage: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const reason =
      error instanceof SlackApiError
        ? error.message
        : 'Transport failed or request cancelled; outcome may be uncertain.';
    throw new Error(
      `${stage}: ${reason} Inspect the known artifact before retrying; do not blindly repeat the write.`,
    );
  }
}

export async function createCanvas(
  client: SlackApiCaller,
  title: string,
  markdown: string,
  channelId?: string,
  signal?: AbortSignal,
) {
  requireText(title, 'title', 250);
  requireText(markdown, 'markdown');
  if (channelId) requireSlackId(channelId, 'CG', 'channel');
  const response = await publishingWrite(
    () =>
      client.call<SlackApiEnvelope & {canvas_id: string}>(
        'canvases.create',
        {
          title,
          document_content: {type: 'markdown', markdown},
          ...(channelId ? {channel_id: channelId} : {}),
        },
        signal,
      ),
    'Canvas creation (no ID received if this fails)',
  );
  if (!response.canvas_id)
    throw new Error(
      'Canvas creation returned no ID; outcome uncertain. Do not recreate blindly.',
    );
  return {
    canvasId: response.canvas_id,
    warnings: collectSlackWarnings(response),
    channelId,
    access: channelId
      ? 'Channel tab with write access'
      : 'No audience sharing requested',
  };
}

export const CANVAS_OPERATIONS = [
  'append',
  'prepend',
  'replace',
  'rename',
] as const;
export type CanvasOperation = (typeof CANVAS_OPERATIONS)[number];

export function canvasChange(
  operation: string,
  markdown?: string,
  title?: string,
): Record<string, unknown> {
  if (!CANVAS_OPERATIONS.includes(operation as CanvasOperation))
    throw new Error('operation must be append, prepend, replace, or rename.');
  if (operation === 'rename') {
    if (markdown !== undefined || title === undefined)
      throw new Error('rename requires title and forbids markdown.');
    return {
      operation: 'rename',
      title_content: {
        type: 'markdown',
        markdown: requireText(title, 'title', 250),
      },
    };
  }
  if (title !== undefined || markdown === undefined)
    throw new Error('Content edits require markdown and forbid title.');
  const mapped = {
    append: 'insert_at_end',
    prepend: 'insert_at_start',
    replace: 'replace',
  };
  return {
    operation: mapped[operation as keyof typeof mapped],
    document_content: {
      type: 'markdown',
      markdown: requireText(markdown, 'markdown'),
    },
  };
}

export function canvasAccess(
  canvasId: string,
  accessLevel: string,
  channelIds?: string[],
  userIds?: string[],
): Record<string, unknown> {
  requireSlackId(canvasId, 'F', 'canvasId');
  if (!['read', 'write'].includes(accessLevel))
    throw new Error(
      'accessLevel must be read or write; ownership transfer is not supported.',
    );
  if ((channelIds !== undefined) === (userIds !== undefined))
    throw new Error('Provide exactly one of channelIds or userIds.');
  const ids = channelIds ?? userIds!;
  if (!ids.length || ids.length > 20)
    throw new Error('Provide 1–20 recipients.');
  for (const id of ids)
    requireSlackId(id, channelIds ? 'CG' : 'UW', 'recipient');
  return {
    canvas_id: canvasId,
    access_level: accessLevel,
    ...(channelIds ? {channel_ids: channelIds} : {user_ids: userIds}),
  };
}

export interface UploadInput {
  path?: string;
  content?: string;
  filename?: string;
  title?: string;
  snippetType?: string;
  altText?: string;
  channel?: string;
  threadTs?: string;
  initialComment?: string;
}
export interface PreparedUpload {
  bytes: Buffer;
  filename: string;
  source: string;
}

export function validateUpload(input: UploadInput): void {
  if ((input.path !== undefined) === (input.content !== undefined))
    throw new Error('Provide exactly one of path or content.');
  if (input.content !== undefined && !input.filename)
    throw new Error('filename is required for inline content.');
  if (input.threadTs && !input.channel)
    throw new Error('threadTs requires channel.');
  if (input.initialComment !== undefined && !input.channel)
    throw new Error('initialComment requires channel.');
  if (input.threadTs !== undefined && !/^\d+\.\d+$/.test(input.threadTs))
    throw new Error('threadTs must be a Slack parent message timestamp.');
  if (input.initialComment !== undefined)
    requireText(input.initialComment, 'initialComment', 3500);
  if (input.title !== undefined) requireText(input.title, 'title', 250);
  if (input.altText !== undefined) requireText(input.altText, 'altText', 1000);
  if (
    input.snippetType !== undefined &&
    !/^[a-z0-9_+-]{1,50}$/.test(input.snippetType)
  )
    throw new Error(
      'snippetType must be a Slack syntax identifier, such as sql or python.',
    );
}

export async function prepareUpload(
  input: UploadInput,
  cwd: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PreparedUpload> {
  validateUpload(input);
  signal?.throwIfAborted();
  let bytes: Buffer;
  let source = 'inline content';
  let filename = input.filename;
  if (input.path !== undefined) {
    let path = requireText(input.path, 'path', 4096).replace(/^@/, '');
    if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
    source = resolve(cwd, path);
    filename ??= basename(source);
    // Nonblocking open lets us reject FIFOs/devices instead of hanging on them.
    const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new Error('Upload path must be a regular file.');
      if (stat.size > maxBytes)
        throw new Error(`Upload exceeds ${maxBytes} bytes.`);
      // Bound memory and detect growth while reading. Snapshot before confirmation.
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= maxBytes) {
        signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
        const {bytesRead} = await file.read(chunk);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      bytes = Buffer.concat(chunks);
    } finally {
      await file.close();
    }
  } else {
    if (Buffer.byteLength(input.content!, 'utf8') > maxBytes)
      throw new Error(`Upload exceeds ${maxBytes} bytes.`);
    bytes = Buffer.from(input.content!, 'utf8');
  }
  requireText(filename!, 'filename', 255);
  if (
    filename!.includes('/') ||
    filename!.includes('\\') ||
    [...filename!].some(char => char.charCodeAt(0) < 32)
  )
    throw new Error(
      'filename must be a base filename without path separators or control characters.',
    );
  if (!bytes.length || bytes.length > maxBytes)
    throw new Error(`Upload must contain 1–${maxBytes} bytes.`);
  return {bytes, filename: filename!, source};
}

export async function uploadFile(
  client: SlackApiCaller,
  input: UploadInput,
  prepared: PreparedUpload,
  signal?: AbortSignal,
) {
  let fileId: string | undefined;
  let stage = 'request_upload_url';
  try {
    signal?.throwIfAborted();
    const allocated = await client.call<
      SlackApiEnvelope & {file_id: string; upload_url: string}
    >(
      'files.getUploadURLExternal',
      {
        filename: prepared.filename,
        length: prepared.bytes.length,
        snippet_type: input.snippetType,
        alt_txt: input.altText,
      },
      signal,
    );
    fileId = allocated.file_id;
    if (!fileId) throw new Error('Missing file ID.');
    stage = 'upload_bytes';
    const url = new URL(allocated.upload_url);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'files.slack.com' ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error('Unexpected upload URL.');
    const response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/octet-stream'},
      body: new Uint8Array(prepared.bytes),
      redirect: 'error',
      signal,
    });
    await response.body?.cancel();
    if (response.status !== 200) throw new Error('Upload HTTP failure.');
    stage = 'complete_upload';
    const completed = await client.call<
      SlackApiEnvelope & {files?: FileMetadata[]}
    >(
      'files.completeUploadExternal',
      {
        files: [{id: fileId, title: input.title ?? prepared.filename}],
        channel_id: input.channel,
        thread_ts: input.threadTs,
        initial_comment: input.initialComment,
      },
      signal,
    );
    if (!completed.files?.some(file => file.id === fileId)) {
      throw new Error(
        'Completion response did not confirm the allocated file ID.',
      );
    }
    return {
      fileId,
      warnings: collectSlackWarnings(completed),
      note: 'Slack processing/sharing metadata may lag completion; inspect file info before claiming audience access.',
      stage: 'completed',
      visibility: input.channel ? 'channel_share_requested' : 'private',
      channel: input.channel,
      threadTs: input.threadTs,
      files: completed.files?.map(fileMetadata) ?? [],
    };
  } catch (error) {
    // Never include raw fetch errors: they can contain signed upload URLs.
    const reason =
      error instanceof SlackApiError
        ? error.message
        : 'Transport, upload validation, or cancellation failure.';
    throw new Error(
      `File upload failed at ${stage}; fileId=${fileId ?? 'unknown'}. ${reason} ${stage === 'complete_upload' ? 'Completion outcome may be uncertain.' : 'Completion was not requested.'} Do not restart blindly; inspect the known file ID. No automatic retry was made.`,
    );
  }
}
