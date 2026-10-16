import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, writeFile} from 'node:fs/promises';
import test from 'node:test';
import {Check} from 'typebox/value';
import type {TSchema} from 'typebox';
import slackExtension from '../src/index.ts';

interface Result {
  content: Array<{text: string}>;
  details: Record<string, unknown>;
}
interface Tool {
  name: string;
  parameters: TSchema;
  execute: (...args: unknown[]) => Promise<Result>;
}
interface Call {
  method: string;
  body: Record<string, unknown>;
  token: string;
}

// Registered tools -> real HTTP transport -> local Slack-shaped server. This
// verifies requests/approvals/readback, not Slack's Markdown translation or UI.
test('rich message workflows over local HTTP, with a repeatable evidence report', async t => {
  const envNames = [
    'SLACK_USER_TOKEN',
    'SLACK_BOT_TOKEN',
    'PI_SLACK_API_BASE_URL',
    'PI_SLACK_ALLOW_NONINTERACTIVE_WRITES',
    'PI_SLACK_SKIP_SEND_CONFIRM',
  ];
  const originalEnv = envNames.map(name => [name, process.env[name]] as const);
  const messages = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  const checks: Array<{name: string; status: string}> = [];
  const previews: string[] = [];
  let denyReads = false;
  let failWrite = false;
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = request.headers['content-type']?.startsWith(
      'application/x-www-form-urlencoded',
    )
      ? Object.fromEntries(new URLSearchParams(raw))
      : JSON.parse(raw || '{}');
    const method = request.url!.split('/').pop()!;
    const token = request.headers.authorization ?? '';
    calls.push({method, body, token});
    let result: Record<string, unknown> = {ok: true};
    if (method.startsWith('chat.')) {
      if (token !== 'Bearer fixture-bot')
        result = {ok: false, error: 'wrong_token'};
      else if (failWrite) result = {ok: false, error: 'invalid_blocks'};
      else {
        const ts =
          method === 'chat.update'
            ? body.ts
            : `1700000000.${String(++sequence).padStart(6, '0')}`;
        const message = {
          ...messages.get(ts),
          channel: body.channel,
          user: 'UBOT',
          ts,
          text: body.text,
          blocks: body.blocks,
          thread_ts: body.thread_ts ?? messages.get(ts)?.thread_ts,
        };
        messages.set(ts, message);
        result = {ok: true, channel: body.channel, ts, message};
      }
    } else if (method.startsWith('conversations.')) {
      if (denyReads) result = {ok: false, error: 'missing_scope'};
      else if (token !== 'Bearer fixture-user')
        result = {ok: false, error: 'wrong_token'};
      else if (method === 'conversations.replies' && !messages.has(body.ts)) {
        result = {ok: false, error: 'invalid_arguments'};
      } else {
        const selected = [...messages.values()].filter(message => {
          if (message.channel && message.channel !== body.channel) return false;
          if (body.oldest && Number(message.ts) < Number(body.oldest))
            return false;
          if (body.latest && Number(message.ts) > Number(body.latest))
            return false;
          return (
            method === 'conversations.history' ||
            message.ts === body.ts ||
            message.thread_ts === body.ts
          );
        });
        result = {
          ok: true,
          messages: selected.slice(0, Number(body.limit) || 100),
        };
      }
    } else if (method === 'auth.test') {
      result = {ok: true, team_id: 'T123', user_id: 'UBOT', bot_id: 'BBOT'};
    } else result = {ok: false, error: 'unexpected_method'};
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.SLACK_USER_TOKEN = 'fixture-user';
  process.env.SLACK_BOT_TOKEN = 'fixture-bot';
  process.env.PI_SLACK_API_BASE_URL = `http://127.0.0.1:${address.port}/api`;
  process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES = '1';
  delete process.env.PI_SLACK_SKIP_SEND_CONFIRM;
  const tools = new Map<string, Tool>();
  const entries: unknown[] = [];
  const commands = new Map<
    string,
    {handler: (...args: unknown[]) => Promise<void>}
  >();
  const pi = {
    on() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({type: 'custom', customType, data: structuredClone(data)});
    },
    registerCommand(
      name: string,
      command: {handler: (...args: unknown[]) => Promise<void>},
    ) {
      commands.set(name, command);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
  };
  slackExtension(pi as never);
  const channel = 'C12345678';
  const run = (
    name: string,
    params: Record<string, unknown>,
    ctx: unknown = {hasUI: false},
  ) => {
    const tool = tools.get(name)!;
    assert.ok(
      Check(tool.parameters, params),
      `Tool parameter schema rejected ${name}`,
    );
    return tool.execute('local-http-e2e', params, undefined, undefined, ctx);
  };
  const write = (
    name: string,
    params: Record<string, unknown>,
    ctx?: unknown,
  ) => run(name, {channel, confirm: true, ...params}, ctx);
  const writes = () => calls.filter(call => call.method.startsWith('chat.'));
  const readText = (result: Result) =>
    result.content.map(item => item.text).join('\n');
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
      checks.push({name, status: 'passed'});
    } catch (error) {
      checks.push({name, status: 'failed'});
      throw error;
    }
  };
  let plainTs = '';
  let richTs = '';
  const blocks = [
    {type: 'header', text: {type: 'plain_text', text: 'TEST daily report'}},
    {
      type: 'section',
      text: {type: 'mrkdwn', text: '*Still open:* delivery is unverified.'},
      fields: [
        {type: 'mrkdwn', text: '*Uploaded*\n24 files'},
        {type: 'mrkdwn', text: '*Records*\n160'},
      ],
    },
    {type: 'divider'},
    {
      type: 'table',
      rows: [
        [
          {type: 'raw_text', text: 'Check'},
          {type: 'raw_text', text: 'Result'},
        ],
        [
          {type: 'raw_text', text: 'Coverage'},
          {type: 'raw_number', value: 0, text: '0'},
        ],
      ],
      column_settings: [{is_wrapped: true}, {align: 'right'}],
    },
    {
      type: 'context',
      elements: [
        {type: 'mrkdwn', text: '<https://example.com/evidence|Evidence>'},
      ],
    },
  ];
  try {
    await step('ordinary text and splitting remain unchanged', async () => {
      const result = await write('slack_post_message', {text: 'Plain update'});
      plainTs = (result.details.parts as Array<{ts: string}>)[0].ts;
      assert.equal(writes()[0].body.text, 'Plain update');
      assert.equal(writes()[0].body.blocks, undefined);
      const before = writes().length;
      await write('slack_post_message', {
        text: 'Repeated line.\n'.repeat(100),
        longTextMode: 'split',
        maxChars: 500,
        threadTs: plainTs,
      });
      assert.ok(writes().length > before + 1);
      assert.ok(
        writes()
          .slice(before)
          .every(
            call =>
              call.body.thread_ts === plainTs &&
              String(call.body.text).length <= 500,
          ),
      );
    });
    await step(
      'Markdown reaches Slack as a native block with a fallback and one reply',
      async () => {
        const markdown =
          '## Recovery\n**Still open:** delivery unverified.\n\n| Files | Records |\n| --- | --- |\n| 24 | 160 |';
        const before = writes().length;
        const result = await write('slack_post_message', {
          text: 'Recovery: 24 files, 160 records. Delivery unverified; still open.',
          markdown,
          threadTs: plainTs,
          replyBroadcast: false,
        });
        richTs = (result.details.parts as Array<{ts: string}>)[0].ts;
        assert.equal(result.details.format, 'markdown');
        assert.equal(writes().length, before + 1);
        assert.deepEqual(writes().at(-1)!.body.blocks, [
          {type: 'markdown', text: markdown},
        ]);
        assert.equal(writes().at(-1)!.body.thread_ts, plainTs);
        assert.equal(writes().at(-1)!.body.reply_broadcast, false);
      },
    );
    await step(
      'dashboard approval shows actual blocks; approved payload is snapshotted',
      async () => {
        const original = structuredClone(blocks);
        await write(
          'slack_post_message',
          {
            text: '24 files, 160 records. Coverage 0. Delivery unverified. https://example.com/evidence',
            blocks,
          },
          {
            hasUI: true,
            ui: {
              confirm: async (_title: string, preview: string) => {
                previews.push(preview);
                blocks[0].text!.text = 'Mutation after preview';
                return true;
              },
            },
          },
        );
        assert.match(previews[0], /TEST daily report/);
        assert.match(previews[0], /Delivery unverified/i);
        assert.match(previews[0], /https:\/\/example.com\/evidence/);
        assert.deepEqual(writes().at(-1)!.body.blocks, original);
      },
    );
    await step(
      'cancellation and missing non-interactive approval block rich writes',
      async () => {
        const before = writes().length;
        await assert.rejects(
          write(
            'slack_post_message',
            {text: 'fallback', markdown: '**Actual content**'},
            {
              hasUI: true,
              ui: {
                confirm: async (_title: string, preview: string) => {
                  previews.push(preview);
                  return false;
                },
              },
            },
          ),
          /cancelled/,
        );
        assert.match(previews.at(-1)!, /Actual content/);
        await assert.rejects(
          write('slack_post_message', {
            text: 'fallback',
            blocks,
            confirm: false,
          }),
          /confirm/,
        );
        assert.equal(writes().length, before);
      },
    );
    await step(
      'invalid, conflicting, oversized and split layouts fail without writes',
      async () => {
        const before = writes().length;
        const invalid = [
          {markdown: 'text', blocks},
          {markdown: 'text', mrkdwn: false},
          {markdown: 'text', text: ' '},
          {markdown: 'text', text: 'x'.repeat(4001)},
          {markdown: 'text', longTextMode: ' Split '},
          {markdown: 'x'.repeat(12001)},
          {blocks: [{type: 'actions', elements: []}]},
          {blocks: []},
          {blocks: [{type: 'section'}]},
          {blocks: [{type: 'table', rows: [[{type: 'raw_number', value: 0}]]}]},
          {
            blocks: [
              {
                type: 'table',
                rows: [
                  [{type: 'raw_text', text: 'one'}],
                  [
                    {type: 'raw_text', text: 'two'},
                    {type: 'raw_text', text: 'extra'},
                  ],
                ],
              },
            ],
          },
          {
            blocks: [
              {
                type: 'table',
                rows: [
                  [
                    {type: 'raw_text', text: 'x'.repeat(6000)},
                    {type: 'raw_text', text: 'y'.repeat(6000)},
                  ],
                ],
              },
            ],
          },
          {
            blocks: Array.from({length: 5}, () => ({
              type: 'section',
              text: {type: 'mrkdwn', text: 'x'.repeat(3000)},
            })),
          },
          {
            blocks: [
              {
                type: 'header',
                text: {type: 'plain_text', text: 'x'.repeat(151)},
              },
            ],
          },
          {blocks: Array.from({length: 51}, () => ({type: 'divider'}))},
        ];
        for (const input of invalid)
          await assert.rejects(async () =>
            write('slack_post_message', {text: 'Fallback', ...input}),
          );
        await assert.rejects(
          write('slack_update_message', {
            ts: richTs,
            text: 'Fallback',
            markdown: 'report',
            clearBlocks: true,
          }),
          /clearBlocks/,
        );
        assert.equal(writes().length, before);
      },
    );
    await step(
      'read and research include translated tables, metrics, links, lists and legacy attachments',
      async () => {
        // A representative Slack response, not a local Markdown renderer.
        messages.set(richTs, {
          ts: richTs,
          thread_ts: plainTs,
          text: 'Short fallback',
          blocks: [
            ...blocks,
            {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_list',
                  style: 'ordered',
                  offset: 2,
                  elements: [
                    {
                      type: 'rich_text_section',
                      elements: [
                        {
                          type: 'text',
                          text: 'duplicate safeguard',
                          style: {bold: true},
                        },
                      ],
                    },
                  ],
                },
                {
                  type: 'rich_text_section',
                  elements: [
                    {
                      type: 'link',
                      url: 'https://example.com/check',
                      text: 'Check submissions',
                    },
                  ],
                },
              ],
            },
            {
              type: 'table',
              rows: [
                [
                  {
                    type: 'rich_text',
                    elements: [
                      {
                        type: 'rich_text_section',
                        elements: [
                          {
                            type: 'text',
                            text: 'retrievePolicy',
                            style: {code: true},
                          },
                        ],
                      },
                    ],
                  },
                  {type: 'raw_number', value: 1250, text: '$1,250'},
                ],
              ],
            },
            {type: 'unknown_future_block', text: 'inspect source'},
          ],
          attachments: [
            {
              title: 'Legacy evidence',
              fields: [{title: 'Batch', value: 'archive-only-keyword'}],
              blocks: [
                {
                  type: 'section',
                  text: {type: 'plain_text', text: 'Attachment detail'},
                },
              ],
            },
          ],
        });
        const reads = [
          await run('slack_read_messages', {
            channel,
            limit: 100,
            formatMode: 'verbatim',
          }),
          await run('slack_read_thread', {
            channel,
            threadTs: plainTs,
            limit: 100,
            formatMode: 'verbatim',
          }),
          await run('slack_read_permalink', {
            url: `https://example.slack.com/archives/${channel}/p${richTs.replace('.', '')}?thread_ts=${plainTs}`,
            limit: 100,
            formatMode: 'verbatim',
          }),
        ];
        for (const result of reads) {
          const text = readText(result);
          for (const expected of [
            '24 files',
            '160',
            'Coverage | 0',
            '3. *duplicate safeguard*',
            '<https://example.com/check|Check submissions>',
            '`retrievePolicy` | $1,250',
            'Unsupported Slack content: unknown_future_block',
            'archive-only-keyword',
            'Attachment detail',
          ])
            assert.ok(text.includes(expected), expected);
        }
        const source = await run('slack_read_thread', {
          channel,
          threadTs: plainTs,
          limit: 100,
          formatMode: 'blocks',
        });
        assert.match(readText(source), /unknown_future_block/);
        assert.match(readText(source), /inspect source/);
        const research = await run('slack_research_messages', {
          query: 'retrievePolicy archive-only-keyword',
          channels: [channel],
          oldest: '1',
          maxMessagesPerChannel: 100,
        });
        assert.match(readText(research), /Found 1 result/);
        assert.match(readText(research), /retrievePolicy/i);
      },
    );
    await step(
      'text-only edits refuse rich layouts, fail closed on unreadable/missing targets, and allow explicit clearing',
      async () => {
        const before = writes().length;
        const update = {ts: richTs, threadTs: plainTs, text: 'Replacement'};
        await assert.rejects(
          write('slack_update_message', update),
          /contains blocks/,
        );
        delete process.env.SLACK_USER_TOKEN;
        await assert.rejects(
          write('slack_update_message', update),
          /SLACK_USER_TOKEN/,
        );
        process.env.SLACK_USER_TOKEN = 'fixture-user';
        denyReads = true;
        await assert.rejects(
          write('slack_update_message', update),
          /missing_scope/,
        );
        denyReads = false;
        await assert.rejects(
          write('slack_update_message', {...update, ts: '9999.000001'}),
          /exact Slack message/,
        );
        assert.equal(writes().length, before);
        await write('slack_update_message', {...update, clearBlocks: true});
        assert.deepEqual(writes().at(-1)!.body.blocks, []);
        assert.equal(writes().at(-1)!.body.ts, richTs);
        await write('slack_update_message', {
          ts: plainTs,
          text: 'Updated plain text',
        });
        assert.equal(writes().at(-1)!.body.blocks, undefined);
      },
    );
    await step(
      'rich edits keep a complete layout, do not retry API rejection, and read output remains bounded',
      async () => {
        const before = writes().length;
        await write('slack_update_message', {
          ts: richTs,
          text: 'Delivery remains unverified.',
          markdown: '**Still open:** delivery remains unverified.',
        });
        assert.deepEqual(writes().at(-1)!.body.blocks, [
          {
            type: 'markdown',
            text: '**Still open:** delivery remains unverified.',
          },
        ]);
        failWrite = true;
        await assert.rejects(
          write('slack_update_message', {ts: richTs, text: 'Fallback', blocks}),
          /invalid_blocks/,
        );
        failWrite = false;
        assert.equal(writes().length, before + 2);
        messages.set('9999999999.000001', {
          ts: '9999999999.000001',
          blocks: [
            {
              type: 'section',
              text: {type: 'plain_text', text: 'x'.repeat(60000)},
            },
          ],
        });
        const result = await run('slack_read_thread', {
          channel,
          threadTs: '9999999999.000001',
          formatMode: 'blocks',
        });
        assert.match(readText(result), /Slack output truncated/);
        assert.equal(
          (result.details.truncation as {truncated: boolean}).truncated,
          true,
        );
      },
    );
    await step(
      'thread allowance covers verified root/reply edits and survives reload without weakening boundaries',
      async () => {
        const state = {
          sessionId: 'edit-session',
          selections: 0,
          confirmations: 0,
          choice: 'Approve thread for this session',
          allowOnce: false,
        };
        const ctx = {
          hasUI: true,
          sessionManager: {
            getSessionId: () => state.sessionId,
            getEntries: () => entries,
          },
          ui: {
            notify() {},
            select: async (preview: string) => {
              previews.push(preview);
              state.selections++;
              return state.choice;
            },
            confirm: async (_title: string, preview: string) => {
              previews.push(preview);
              state.confirmations++;
              return state.allowOnce;
            },
          },
        };
        const reply = await write(
          'slack_post_message',
          {text: 'Approved thread reply', threadTs: plainTs},
          ctx,
        );
        const replyTs = (reply.details.parts as Array<{ts: string}>)[0].ts;
        assert.equal(state.selections, 1);
        assert.match(previews.at(-1)!, /edits to verified messages/);
        state.choice = 'Cancel';
        const edit = {
          ts: replyTs,
          text: 'Verified edit',
          markdown: '**Verified edit**',
        };
        const updated = await write('slack_update_message', edit, ctx);
        assert.equal(
          updated.details.threadTs,
          plainTs,
          'Discover the real parent even without a caller hint.',
        );
        await write(
          'slack_update_message',
          {ts: plainTs, text: 'Approved root edit', clearBlocks: true},
          ctx,
        );
        slackExtension(pi as never);
        await write('slack_update_message', {...edit, threadTs: plainTs}, ctx);
        assert.equal(state.selections, 1);
        assert.equal(state.confirmations, 0);
        const beforeGuard = writes().length;
        await assert.rejects(
          write(
            'slack_update_message',
            {ts: replyTs, text: 'Do not flatten'},
            ctx,
          ),
          /contains blocks/,
        );
        assert.equal(writes().length, beforeGuard);
        const splitStart = writes().length;
        await write(
          'slack_update_message',
          {
            ts: replyTs,
            text: 'Continuation line.\n'.repeat(90),
            clearBlocks: true,
            longTextMode: 'split',
            maxChars: 500,
          },
          ctx,
        );
        assert.ok(writes().length > splitStart + 1);
        assert.ok(
          writes()
            .slice(splitStart + 1)
            .every(call => call.body.thread_ts === plainTs),
        );
        assert.equal(state.selections, 1);
        assert.equal(state.confirmations, 0);
        const other = await write('slack_post_message', {text: 'Other thread'});
        const otherTs = (other.details.parts as Array<{ts: string}>)[0].ts;
        const otherChannel = 'C87654321';
        const elsewhere = await write('slack_post_message', {
          channel: otherChannel,
          text: 'Other channel',
        });
        const elsewhereTs = (elsewhere.details.parts as Array<{ts: string}>)[0]
          .ts;
        const beforeRejected = writes().length;
        await assert.rejects(
          write(
            'slack_update_message',
            {...edit, ts: otherTs, threadTs: plainTs},
            ctx,
          ),
          /does not match/,
        );
        await assert.rejects(
          write('slack_update_message', {...edit, ts: otherTs}, ctx),
          /cancelled/,
        );
        await assert.rejects(
          write(
            'slack_update_message',
            {...edit, channel: otherChannel, ts: elsewhereTs},
            ctx,
          ),
          /cancelled/,
        );
        messages.get(replyTs)!.subtype = 'thread_broadcast';
        await assert.rejects(
          write('slack_update_message', edit, ctx),
          /cancelled/,
        );
        delete messages.get(replyTs)!.subtype;
        denyReads = true;
        await assert.rejects(
          write('slack_update_message', edit, ctx),
          /cancelled/,
        );
        denyReads = false;
        assert.match(previews.at(-1)!, /membership could not be verified/);
        delete process.env.SLACK_USER_TOKEN;
        await assert.rejects(
          write('slack_update_message', edit, ctx),
          /cancelled/,
        );
        process.env.SLACK_USER_TOKEN = 'fixture-user';
        state.sessionId = 'other-session';
        await assert.rejects(
          write('slack_update_message', edit, ctx),
          /cancelled/,
        );
        state.sessionId = 'edit-session';
        delete process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES;
        await assert.rejects(
          write('slack_update_message', edit, {...ctx, hasUI: false}),
          /blocked in non-interactive/,
        );
        process.env.PI_SLACK_ALLOW_NONINTERACTIVE_WRITES = '1';
        assert.equal(writes().length, beforeRejected);
        state.allowOnce = true;
        await commands.get('slack-approvals')!.handler('clear', ctx);
        state.allowOnce = false;
        await assert.rejects(
          write('slack_update_message', edit, ctx),
          /cancelled/,
        );
        assert.equal(writes().length, beforeRejected);
      },
    );
  } finally {
    const directory = new URL('../tmp/message-layout-e2e/', import.meta.url);
    await mkdir(directory, {recursive: true});
    await writeFile(
      new URL('report.json', directory),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          command: 'node --test slack/test/message-layout.test.ts',
          scope:
            'registered tools and real local HTTP transport; no live Slack writes or rendering checks',
          checks,
          previews,
          requests: calls.map(({method, body}) => ({method, body})),
        },
        null,
        2,
      ) + '\n',
    );
  }
});
