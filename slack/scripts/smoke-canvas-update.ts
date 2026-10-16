import assert from 'node:assert/strict';
import slackExtension from '../src/index.ts';

// Updates only the synthetic paragraph from smoke-publishing.ts in an explicitly
// selected TEST Canvas. Never rerun blindly: the original text must still exist.
const canvasId = process.env.SLACK_SMOKE_CANVAS_ID;
if (
  process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES !== '1' ||
  !canvasId ||
  !/^F[A-Z0-9]+$/.test(canvasId)
)
  throw new Error(
    'Explicit PI_SLACK_ALLOW_NONINTERACTIVE_WRITES=1 and SLACK_SMOKE_CANVAS_ID are required.',
  );
delete process.env.PI_SLACK_SKIP_SEND_CONFIRM;
interface Tool {
  name: string;
  execute: (
    ...args: unknown[]
  ) => Promise<{content: {text: string}[]; details: Record<string, unknown>}>;
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
  const result = await tools
    .get(name)!
    .execute(
      'authorized-canvas-smoke',
      {...params, confirm: true},
      undefined,
      undefined,
      {hasUI: false, cwd: process.cwd()},
    );
  console.log(JSON.stringify({tool: name, ...result.details}, null, 2));
  return result;
}
const before = await run('slack_read_canvas', {canvasId, format: 'html'});
assert.equal(
  before.details.truncated,
  false,
  'Smoke fixture should fit on one page.',
);
assert.match(String(before.details.title), /^TEST/);
assert.ok(
  before.content[0].text.includes('>The append API succeeded.</p>'),
  'Original synthetic paragraph must be unchanged.',
);
const lookup = await run('slack_find_canvas_sections', {
  canvasId,
  containsText: 'The append API succeeded.',
});
assert.equal(lookup.details.totalMatches, 1);
const sectionId = (lookup.details.sections as {id: string}[])[0].id;
const input = {
  canvasId,
  sectionId,
  expectedRevision: before.details.revision,
  appendRevisionNote: true,
  operation: 'replace',
  markdown:
    'The append API succeeded. Targeted section updates now preserve the rest of this TEST report.',
  changeSummary:
    'TEST: polished one synthetic finding; preserved the table and caveats.',
};
await run('slack_edit_canvas_section', input);
const after = await run('slack_read_canvas', {canvasId, format: 'html'});
assert.notEqual(after.details.revision, before.details.revision);
assert.ok(
  after.content[0].text.includes('Targeted section updates now preserve'),
);
assert.ok(after.content[0].text.includes('Revision '));
const tableBefore = before.content[0].text.match(
  /<table>[\s\S]*?<\/table>/,
)?.[0];
const tableAfter = after.content[0].text.match(/<table>[\s\S]*?<\/table>/)?.[0];
assert.ok(tableBefore);
assert.equal(
  tableAfter,
  tableBefore,
  'Unrelated table HTML must be unchanged.',
);
assert.ok(
  after.content[0].text.includes(
    'Caveat: these are invented numbers, not an AWS investigation.',
  ),
);
await assert.rejects(
  run('slack_edit_canvas_section', input),
  /changed since it was read/,
);
console.log(
  'PASS: targeted edit and revision note; unrelated table/caveats preserved; stale repeat rejected. No duplicate Canvas created.',
);
