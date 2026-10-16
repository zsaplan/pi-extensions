import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import slackExtension from '../src/index.ts';

// Opt-in real integration exercise. No fixtures contain production data.
const channel = process.env.SLACK_SMOKE_CHANNEL;
const threadTs = process.env.SLACK_SMOKE_THREAD_TS;
if (
  process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES !== '1' ||
  !channel ||
  !threadTs
) {
  throw new Error(
    'Explicit PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1, SLACK_SMOKE_CHANNEL, and SLACK_SMOKE_THREAD_TS are required.',
  );
}
if (!/^C[A-Z0-9]+$/.test(channel) || !/^\d+\.\d+$/.test(threadTs))
  throw new Error('Invalid test channel or parent thread timestamp.');
// Keep the documented per-call confirmation=true gate active in this process.
delete process.env.PI_SLACK_SKIP_SEND_CONFIRM;

interface Tool {
  name: string;
  execute: (...args: unknown[]) => Promise<{details: Record<string, unknown>}>;
}
const tools = new Map<string, Tool>();
slackExtension({
  registerCommand() {},
  on() {},
  registerTool(tool: Tool) {
    tools.set(tool.name, tool);
  },
} as never);
async function run(name: string, params: Record<string, unknown>) {
  console.log(`Running ${name}...`);
  const tool = tools.get(name);
  if (!tool) throw new Error(`Missing ${name}`);
  const result = await tool.execute(
    'authorized-smoke',
    {...params, confirm: true},
    undefined,
    undefined,
    {hasUI: false, cwd: process.cwd()},
  );
  console.log(JSON.stringify({tool: name, ...result.details}, null, 2));
  return result.details;
}

const stamp = new Date().toISOString();
const dir = await mkdtemp(join(tmpdir(), 'slack-smoke-'));
try {
  const markdown = `# TEST — Slack publishing smoke test\n\nSynthetic data only. ${stamp}\n\n## Findings\n\n| Area | Before/day | After/day |\n|---|---:|---:|\n| Test compute | $10 | $15 |\n| Test storage | $2 | $3 |\n\n> Caveat: these are invented numbers, not an AWS investigation.\n\n- Native headings and table\n- Unicode: 🌍\n- [Slack documentation](https://docs.slack.dev/)\n\n\`\`\`sql\nSELECT 1 AS synthetic_test;\n\`\`\`\n`;
  let canvasId: unknown = process.env.SLACK_SMOKE_CANVAS_ID;
  // Resume only after Canvas creation/edits, before any announcements/uploads.
  if (!canvasId) {
    const created = await run('slack_create_canvas', {
      title: `TEST — Pi Canvas publishing ${stamp}`,
      markdown,
    });
    canvasId = created.canvasId;
    await run('slack_edit_canvas', {
      canvasId,
      operation: 'append',
      markdown: '\n## Append test\nThe append API succeeded.\n',
    });
    await run('slack_edit_canvas', {
      canvasId,
      operation: 'prepend',
      markdown: '> TEST artifact — synthetic data only.\n\n',
    });
    await run('slack_edit_canvas', {
      canvasId,
      operation: 'rename',
      title: `TEST — Pi Canvas/files verified ${stamp}`,
    });
  }
  const metadata = await run('slack_get_file_info', {fileId: canvasId});
  if (typeof metadata.permalink !== 'string')
    throw new Error(
      `Canvas ${canvasId} created, but no permalink returned; stopping without recreating it.`,
    );
  if (process.env.SLACK_SMOKE_CANVAS_ANNOUNCED !== '1')
    await run('slack_post_message', {
      channel,
      threadTs,
      text: `*TEST — Canvas/files publishing*\nSynthetic data only. <${metadata.permalink}|Open the test Canvas>\nExercises headings, a cost table, caveats, Unicode, and append/prepend/rename. File/snippet tests follow.`,
      mrkdwn: true,
    });
  await run('slack_set_canvas_access', {
    canvasId,
    channelIds: [channel],
    accessLevel: 'read',
  });
  const privateFile = await run('slack_upload_file', {
    filename: 'TEST-private-report.md',
    content: markdown,
    title: `TEST private report ${stamp}`,
  });
  await run('slack_get_file_info', {fileId: privateFile.fileId});
  const snippet = await run('slack_upload_file', {
    channel,
    threadTs,
    filename: 'TEST-evidence.sql',
    content: 'SELECT 1 AS synthetic_test; -- Unicode 🌍\n',
    snippetType: 'sql',
    title: 'TEST — SQL snippet',
    initialComment: 'TEST: synthetic SQL evidence snippet; no production data.',
  });
  await run('slack_get_file_info', {fileId: snippet.fileId});
  const image = join(dir, 'TEST-pixel.png');
  await writeFile(
    image,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const uploadedImage = await run('slack_upload_file', {
    channel,
    threadTs,
    path: image,
    title: 'TEST — one-pixel PNG',
    altText: 'Synthetic one-pixel test image',
    initialComment: 'TEST: binary PNG upload.',
  });
  await run('slack_get_file_info', {fileId: uploadedImage.fileId});
  console.log(
    'API smoke test complete. Human rendering/access checks remain; artifacts intentionally retained.',
  );
} finally {
  await rm(dir, {recursive: true, force: true});
}
