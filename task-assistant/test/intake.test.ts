import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(pkg, 'dist/cli.js');
const inbox = {
  workspace_id: 'TONE',
  channel_id: 'DASSIST',
  owner_user_id: 'UOWNER',
  bot_user_id: 'UBOT',
};
const now = Math.floor(Date.now() / 1000);
const ts = (offset: number) => `${now + offset}.000001`;
const msg = (timestamp: string, text: string, extra = {}) => ({
  ts: timestamp,
  text,
  user: 'UOWNER',
  ...extra,
});

test('checkpointed intake through the compiled CLI', async t => {
  await mkdir(path.join(pkg, 'tmp'), {recursive: true});
  const artifact = await mkdtemp(path.join(pkg, 'tmp/intake-e2e-'));
  const root = path.join(artifact, 'state');
  const preload = path.join(artifact, 'fetch.mjs');
  await writeFile(
    preload,
    "const fetch=globalThis.fetch;globalThis.fetch=(url,options)=>{const u=new URL(String(url));if(u.origin!=='https://slack.com')throw Error('unexpected host');return fetch(new URL(u.pathname,process.env.FIXTURE_ORIGIN),options);};",
  );
  let scenario = 'happy';
  let discoveredRoot = ts(-10);
  const requests: {method: string; params: Record<string, string>}[] = [];
  const searchTs = ts(-250);
  const directTs = ts(-200);
  const replyTs = ts(-100);
  const rootTs = '1700000000.000001';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = Object.fromEntries(new URLSearchParams(body));
    const method = (req.url ?? '').replace('/api/', '');
    requests.push({method, params});
    const bot = req.headers.authorization === 'Bearer fixture-bot';
    const reply = (value: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    assert.equal(req.method, 'POST');
    if (method === 'auth.test')
      return reply({
        ok: true,
        team_id: 'TONE',
        user_id: bot ? 'UBOT' : 'UOWNER',
        ...(bot ? {bot_id: 'BONE'} : {}),
      });
    if (method === 'usergroups.list') {
      assert.equal(bot, true, 'Only group metadata uses the bot token');
      if (scenario === 'discovery-group-denied')
        return reply({
          ok: false,
          error: 'missing_scope',
          needed: 'usergroups:read',
        });
      return reply({
        ok: true,
        usergroups: [
          {
            id: 'SGROUP',
            handle: 'cloud-ops',
            team_id: scenario === 'discovery-wrong-team' ? 'TOTHER' : 'TONE',
            date_delete: scenario === 'discovery-disabled' ? 1 : 0,
          },
        ],
      });
    }
    if (method === 'conversations.info' && params.channel === 'CWATCH') {
      assert.equal(bot, false);
      return reply({
        ok: true,
        channel: {
          id: 'CWATCH',
          is_im: scenario === 'discovery-bad-channel',
          context_team_id: 'TONE',
        },
      });
    }
    if (method === 'conversations.info')
      return reply({
        ok: true,
        channel: {id: 'DASSIST', is_im: true, user: 'UOWNER'},
      });
    if (method === 'search.messages') {
      if (scenario.startsWith('discovery')) {
        assert.equal(bot, false);
        const group = params.query.startsWith('@cloud-ops ');
        return reply({
          ok: true,
          messages: {
            pagination: {page_count: group ? 2 : 1},
            matches:
              params.page === '2'
                ? [
                    msg(
                      ts(-170),
                      '<!subteam^SGROUP|cloud-ops> Prepare another local note.',
                      {user: 'UOTHER', channel: {id: 'CTEAM'}},
                    ),
                  ]
                : [
                    msg(ts(-180), 'Hi <@SGROUP>, draft the staging review.', {
                      user: 'UOTHER',
                      channel: {id: 'CTEAM'},
                    }),
                    msg(ts(-190), '@cloud-ops is a plain-text alias.', {
                      user: 'UOTHER',
                      channel: {id: 'CTEAM'},
                    }),
                    msg(
                      discoveredRoot,
                      '<@UOWNER> <@SGROUP> Draft this local checklist.',
                      {user: 'UOTHER', channel: {id: 'CWATCH'}},
                    ),
                  ],
          },
        });
      }
      if (scenario.startsWith('representations'))
        return reply({
          ok: true,
          messages: {
            pagination: {page_count: 1},
            matches: [
              msg(
                searchTs,
                '<@UOWNER> Check search & thread representations.',
                {
                  user: 'UOTHER',
                  channel: {id: 'CREPR'},
                  permalink: `https://fixture.slack.com/archives/CREPR/p${searchTs.replace('.', '')}?thread_ts=${rootTs}`,
                },
              ),
              msg(replyTs, 'Unmentioned source context.', {
                user: 'UOTHER',
                channel: {id: 'CREPR'},
                permalink: `https://fixture.slack.com/archives/CREPR/p${replyTs.replace('.', '')}?thread_ts=${rootTs}`,
              }),
              ...(scenario === 'representations-down'
                ? [
                    msg(ts(-20), '<@UOWNER> A new search-only request.', {
                      user: 'UOTHER',
                      channel: {id: 'CNEW'},
                    }),
                  ]
                : []),
            ],
          },
        });
      if (scenario === 'rate' && params.page === '2') {
        res.statusCode = 429;
        res.setHeader('retry-after', '600');
        return reply({ok: false, error: 'ratelimited'});
      }
      return reply({
        ok: true,
        messages: {
          pagination: {page_count: 2},
          matches:
            params.page === '1'
              ? [
                  msg(searchTs, '<@UOWNER> fixture-private-request', {
                    user: 'UOTHER',
                    channel: {id: 'CSEARCH'},
                    permalink: `https://fixture.slack.com/archives/CSEARCH/p${searchTs.replace('.', '')}?thread_ts=${rootTs}`,
                  }),
                ]
              : [
                  msg(ts(-50), '<@UOWNER> own-status', {
                    user: 'UBOT',
                    bot_id: 'BONE',
                    channel: {id: 'DASSIST'},
                  }),
                ],
        },
      });
    }
    if (method === 'conversations.history' && params.channel === 'CWATCH') {
      assert.equal(bot, false);
      return reply({
        ok: true,
        messages: params.cursor
          ? [
              msg(
                `${Number(discoveredRoot.split('.')[0])}.000002`,
                'A new unmentioned request: draft a local note.',
                {user: 'UOTHER'},
              ),
            ]
          : [
              msg(ts(-40000), 'Old bumped thread', {
                user: 'UOTHER',
                reply_count: 10,
                latest_reply: discoveredRoot,
              }),
              msg(
                discoveredRoot,
                '<@UOWNER> <!subteam^SGROUP> Draft this local checklist.',
                {user: 'UOTHER', thread_ts: discoveredRoot},
              ),
              msg(
                discoveredRoot.replace('000001', '000003'),
                'Broadcast reply',
                {thread_ts: ts(-40000), subtype: 'thread_broadcast'},
              ),
              msg(discoveredRoot.replace('000001', '000004'), 'joined', {
                subtype: 'channel_join',
              }),
              msg(discoveredRoot.replace('000001', '000005'), 'Own bot', {
                user: 'UBOT',
                bot_id: 'BONE',
              }),
            ],
        has_more: !params.cursor,
        response_metadata: {next_cursor: params.cursor ? '' : 'channel-next'},
      });
    }
    if (method === 'conversations.history')
      return reply({
        ok: true,
        messages: params.cursor
          ? [msg(ts(-30), 'own-bot', {user: 'UBOT', bot_id: 'BONE'})]
          : [msg(directTs, 'unmentioned direct request')],
        has_more: !params.cursor,
        response_metadata: {next_cursor: params.cursor ? '' : 'history-next'},
      });
    if (method === 'conversations.replies') {
      if (params.channel === 'CWATCH')
        return reply({
          ok: true,
          messages: [
            msg(discoveredRoot, 'parent'),
            msg(
              discoveredRoot.replace('000001', '000006'),
              'Updated scope without a mention.',
              {user: 'UOTHER', thread_ts: discoveredRoot},
            ),
          ],
          has_more: false,
          response_metadata: {next_cursor: ''},
        });
      if (params.channel === 'CREPR') {
        if (scenario === 'representations-down')
          return reply({ok: false, error: 'channel_not_found'});
        return reply({
          ok: true,
          messages: [
            msg(rootTs, 'old source parent'),
            msg(
              searchTs,
              scenario === 'representations-edit'
                ? '<@UOWNER> Changed instruction: keep the draft local.'
                : '<@UOWNER> Check search &amp; thread representations.',
              {user: 'UOTHER', thread_ts: rootTs},
            ),
            msg(replyTs, 'Unmentioned source context.', {
              user: 'UOTHER',
              thread_ts: rootTs,
            }),
          ],
          has_more: false,
          response_metadata: {next_cursor: ''},
        });
      }
      if (params.channel === 'CFAIL' && scenario === 'partial')
        return reply({ok: false, error: 'channel_not_found'});
      return reply({
        ok: true,
        messages: params.cursor
          ? [
              msg(replyTs, 'unmentioned thread follow-up', {
                thread_ts: rootTs,
                user: 'UOTHER',
              }),
            ]
          : [
              msg(rootTs, 'old parent'),
              msg(ts(-150), 'first reply', {thread_ts: rootTs, user: 'UOTHER'}),
            ],
        has_more: !params.cursor,
        response_metadata: {next_cursor: params.cursor ? '' : 'thread-next'},
      });
    }
    assert.fail(`unexpected method ${method}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  const evidence: string[] = [];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(
      path.join(artifact, 'report.json'),
      JSON.stringify(
        {
          schema_version: 1,
          suite: 'intake-cli-e2e',
          invocation: 'npm run test --workspace task-assistant',
          node: process.version,
          evidence,
          live_slack: false,
          model_invoked: false,
          unverified: [
            'Live index lag and private/DM recall',
            'Model classification',
            'Live task replies',
          ],
        },
        null,
        2,
      ) + '\n',
    );
    t.diagnostic(`Evidence: ${path.join(artifact, 'report.json')}`);
  });
  const run = (args: string[], input?: unknown) =>
    new Promise<{code: number | null; stdout: string; stderr: string}>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', preload, cli, ...args],
          {
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              SLACK_USER_TOKEN: 'fixture-user',
              SLACK_BOT_TOKEN: 'fixture-bot',
              FIXTURE_ORIGIN: origin,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', c => {
          stdout += c;
        });
        child.stderr.on('data', c => {
          stderr += c;
        });
        child.once('error', reject);
        child.once('exit', code => resolve({code, stdout, stderr}));
        child.stdin.end(input ? JSON.stringify(input) : '');
      },
    );
  const poll = (state = root, extra: string[] = []) =>
    run([
      'intake',
      '--root',
      state,
      '--search-api',
      'legacy',
      '--conversation',
      'DASSIST',
      '--once',
      ...extra,
    ]);
  const rows = async (state = root) =>
    Promise.all(
      (await readdir(path.join(state, 'intake', 'receipts'))).map(async f =>
        JSON.parse(
          await readFile(path.join(state, 'intake', 'receipts', f), 'utf8'),
        ),
      ),
    );
  await t.test(
    'reads all pages, persists receipts before checkpoints, and ignores own bot',
    async () => {
      const result = await poll();
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'passed');
      assert.ok(!result.stdout.includes('fixture-private-request'));
      const saved = await rows();
      assert.equal(saved.filter(r => r.disposition === 'pending').length, 2);
      assert.ok(
        saved.some(
          r =>
            r.source.message_ts === searchTs && r.source.thread_ts === rootTs,
        ),
      );
      assert.ok(
        saved.some(
          r => r.kind === 'direct' && r.text === 'unmentioned direct request',
        ),
      );
      assert.ok(
        saved
          .filter(r => r.disposition === 'ignored')
          .every(r => r.reason === 'own_bot'),
      );
      const state = JSON.parse(
        await readFile(path.join(root, 'intake', 'state.json'), 'utf8'),
      );
      assert.ok(state.feeds.mentions.checkpoint);
      assert.ok(state.feeds.inbox.checkpoint);
      const repeat = await poll();
      assert.equal(repeat.code, 0);
      assert.equal(
        (await rows()).filter(r => r.disposition === 'pending').length,
        2,
      );
      assert.ok(
        requests.some(
          r => r.method === 'search.messages' && r.params.page === '2',
        ),
      );
      assert.ok(
        requests.some(
          r =>
            r.method === 'conversations.history' &&
            r.params.cursor === 'history-next',
        ),
      );
      evidence.push(
        'pagination-older-parent-direct-requests-self-filter-replay',
      );
    },
  );
  await t.test(
    'one failed source thread does not block another thread or the inbox',
    async () => {
      for (const channel of ['CFAIL', 'CGOOD']) {
        const result = await run(['enqueue', '--root', root], {
          request: 'fixture source',
          outcome: 'local note',
          sources: [
            {
              workspace_id: 'TONE',
              channel_id: channel,
              message_ts: ts(-300),
              thread_ts: rootTs,
            },
          ],
          inbox,
        });
        assert.equal(result.code, 0, result.stdout);
      }
      scenario = 'partial';
      const result = await poll();
      assert.equal(result.code, 2);
      const state = JSON.parse(
        await readFile(path.join(root, 'intake', 'state.json'), 'utf8'),
      );
      assert.equal(state.feeds[`source:CFAIL:${rootTs}`].checkpoint, undefined);
      assert.equal(
        state.feeds[`source:CFAIL:${rootTs}`].error,
        'channel_not_found',
      );
      assert.ok(state.feeds[`source:CGOOD:${rootTs}`].checkpoint);
      const saved = await rows();
      assert.ok(
        saved.some(
          r =>
            r.kind === 'source_reply' &&
            r.text === 'unmentioned thread follow-up' &&
            r.candidate_task_ids.length === 1,
        ),
      );
      scenario = 'happy';
      assert.equal((await poll()).code, 0);
      evidence.push('independent-thread-failure-and-unmentioned-replies');
    },
  );
  await t.test(
    'conversation content survives search variants, failed reads, and restart without losing real edits',
    async () => {
      const stateRoot = path.join(artifact, 'representations-state');
      scenario = 'representations';
      const created = await run(['enqueue', '--root', stateRoot], {
        request: 'Track fixture source only',
        outcome: 'Local fixture',
        sources: [
          {workspace_id: 'TONE', channel_id: 'CREPR', message_ts: rootTs},
        ],
        inbox,
      });
      assert.equal(created.code, 0, created.stdout);
      assert.equal((await poll(stateRoot)).code, 0);
      let current = await rows(stateRoot);
      const canonical = current.find(r => r.source.message_ts === searchTs);
      const context = current.find(r => r.source.message_ts === replyTs);
      assert.equal(
        canonical.text,
        '<@UOWNER> Check search &amp; thread representations.',
      );
      // Persist completed decisions between real CLI runs, as a classifier would.
      for (const row of [canonical, context])
        await writeFile(
          path.join(stateRoot, 'intake/receipts', `${row.id}.json`),
          JSON.stringify({
            ...row,
            disposition: 'ignored',
            reason: 'fixture-reviewed',
          }),
        );
      assert.equal((await poll(stateRoot)).code, 0);
      current = await rows(stateRoot);
      for (const row of [canonical, context]) {
        const next = current.find(r => r.id === row.id);
        assert.equal(next.disposition, 'ignored');
        assert.equal(next.reason, 'fixture-reviewed');
        assert.equal(next.content_hash, row.content_hash);
        assert.equal(next.received_at, row.received_at);
      }
      assert.equal(
        context.disposition,
        'pending',
        'Search without literal mention must not suppress valid source context',
      );
      const checkpoint = JSON.parse(
        await readFile(path.join(stateRoot, 'intake/state.json'), 'utf8'),
      ).feeds[`source:CREPR:${rootTs}`].checkpoint;
      scenario = 'representations-down';
      assert.equal((await poll(stateRoot)).code, 2);
      current = await rows(stateRoot);
      assert.equal(
        current.find(r => r.id === canonical.id).disposition,
        'ignored',
      );
      assert.equal(
        current.find(r => r.id === canonical.id).text,
        canonical.text,
      );
      assert.ok(
        current.some(
          r => r.source.channel_id === 'CNEW' && r.disposition === 'pending',
        ),
      );
      const failedState = JSON.parse(
        await readFile(path.join(stateRoot, 'intake/state.json'), 'utf8'),
      );
      assert.equal(
        failedState.feeds[`source:CREPR:${rootTs}`].checkpoint,
        checkpoint,
      );
      assert.equal(
        failedState.feeds[`source:CREPR:${rootTs}`].error,
        'channel_not_found',
      );
      scenario = 'representations-edit';
      assert.equal((await poll(stateRoot)).code, 0);
      current = await rows(stateRoot);
      const edited = current.find(r => r.id === canonical.id);
      assert.equal(edited.disposition, 'pending');
      assert.notEqual(edited.content_hash, canonical.content_hash);
      assert.ok(edited.text.includes('Changed instruction'));
      assert.equal(
        current.find(r => r.id === context.id).disposition,
        'ignored',
      );
      await writeFile(
        path.join(stateRoot, 'intake/receipts', `${edited.id}.json`),
        JSON.stringify({
          ...edited,
          disposition: 'ignored',
          reason: 'fixture-reviewed-edit',
        }),
      );
      assert.equal((await poll(stateRoot)).code, 0);
      assert.equal(
        (await rows(stateRoot)).find(r => r.id === canonical.id).reason,
        'fixture-reviewed-edit',
      );
      evidence.push(
        'canonical-conversation-text-search-variants-failure-real-edits-and-unmentioned-context',
      );
    },
  );
  await t.test(
    'owner/team mentions and new channel roots deduplicate and track unmentioned updates across restart',
    async () => {
      scenario = 'discovery';
      const stateRoot = path.join(artifact, 'discovery');
      const flags = ['--mention-group', 'SGROUP', '--watch-channel', 'CWATCH'];
      assert.equal((await poll(stateRoot, flags)).code, 0);
      const binding = JSON.parse(
        await readFile(path.join(stateRoot, 'intake/discovery.json'), 'utf8'),
      );
      discoveredRoot = `${binding.since + 1}.000001`;
      await new Promise(resolve =>
        setTimeout(
          resolve,
          Math.max(0, (binding.since + 2) * 1000 - Date.now()),
        ),
      );
      assert.equal((await poll(stateRoot, flags)).code, 0);
      const saved = await rows(stateRoot);
      assert.equal(
        saved.filter(r => r.source.message_ts === discoveredRoot).length,
        1,
      );
      const shared = saved.find(r => r.source.message_ts === discoveredRoot);
      assert.equal(shared.kind, 'channel_thread');
      assert.equal(shared.content_source, 'conversation');
      assert.ok(shared.text.includes('<!subteam^SGROUP>'));
      assert.equal(
        saved.find(r => r.source.message_ts === ts(-180)).disposition,
        'pending',
        'Valid team feed must reconsider owner-search false positives',
      );
      assert.equal(
        saved.find(r => r.source.message_ts === ts(-170)).disposition,
        'pending',
      );
      assert.equal(
        saved.find(r => r.source.message_ts === ts(-190)).reason,
        'not_literal_mention',
      );
      assert.ok(
        saved.some(
          r =>
            r.kind === 'channel_thread' &&
            r.text.startsWith('A new unmentioned'),
        ),
      );
      assert.ok(
        !saved.some(r =>
          ['Old bumped thread', 'Broadcast reply', 'joined'].includes(r.text),
        ),
      );
      assert.equal(saved.find(r => r.text === 'Own bot').reason, 'own_bot');
      for (const row of saved.filter(r => r.disposition === 'pending'))
        await writeFile(
          path.join(stateRoot, 'intake/receipts', row.id + '.json'),
          JSON.stringify({
            ...row,
            disposition: 'ignored',
            reason: 'fixture-reviewed',
          }),
        );
      const unchanged = await poll(stateRoot, flags);
      assert.equal(unchanged.code, 0);
      assert.equal(
        JSON.parse(unchanged.stdout).feeds.reduce(
          (n: number, f: {saved?: number}) => n + (f.saved ?? 0),
          0,
        ),
        0,
      );
      assert.equal(
        (await rows(stateRoot)).find(r => r.id === shared.id).reason,
        'fixture-reviewed',
      );
      const enqueued = await run(['enqueue', '--root', stateRoot], {
        request: 'Track the selected channel thread',
        outcome: 'Local note',
        inbox,
        sources: [
          {
            workspace_id: 'TONE',
            channel_id: 'CWATCH',
            message_ts: discoveredRoot,
          },
        ],
      });
      assert.equal(enqueued.code, 0);
      const taskId = JSON.parse(enqueued.stdout).task_id;
      assert.equal((await poll(stateRoot, flags)).code, 0);
      const update = (await rows(stateRoot)).find(
        r => r.text === 'Updated scope without a mention.',
      );
      assert.equal(update.kind, 'source_reply');
      assert.deepEqual(update.candidate_task_ids, [taskId]);
      assert.equal(update.source.thread_ts, discoveredRoot);
      const before = requests.filter(
        r => r.method === 'search.messages',
      ).length;
      assert.equal((await poll(stateRoot)).code, 1);
      assert.equal(
        (
          await poll(stateRoot, [
            '--mention-group',
            'SOTHER',
            '--watch-channel',
            'CWATCH',
          ])
        ).code,
        1,
      );
      assert.equal(
        requests.filter(r => r.method === 'search.messages').length,
        before,
      );
      evidence.push(
        'three-source-discovery-native-search-group-markup-new-roots-dedup-restart-source-updates-binding',
      );
    },
  );
  await t.test(
    'invalid or inaccessible discovery feeds stay partial without advancing their checkpoints',
    async () => {
      for (const failure of [
        'group-denied',
        'wrong-team',
        'disabled',
        'bad-channel',
      ]) {
        scenario = `discovery-${failure}`;
        const stateRoot = path.join(artifact, scenario);
        const result = await poll(stateRoot, [
          '--mention-group',
          'SGROUP',
          '--watch-channel',
          'CWATCH',
        ]);
        assert.equal(result.code, 2, result.stdout + result.stderr);
        const state = JSON.parse(
          await readFile(path.join(stateRoot, 'intake/state.json'), 'utf8'),
        );
        const failed =
          failure === 'bad-channel' ? 'channel:CWATCH' : 'group:SGROUP';
        assert.equal(state.feeds[failed].checkpoint, undefined);
        assert.ok(state.feeds[failed].error);
        assert.ok(state.feeds.inbox.checkpoint);
        assert.ok(state.feeds.mentions.checkpoint);
        if (failure !== 'bad-channel')
          assert.equal(
            (await rows(stateRoot)).find(r => r.source.message_ts === ts(-180))
              .reason,
            'not_literal_mention',
          );
      }
      const before = requests.length;
      assert.equal(
        (
          await poll(path.join(artifact, 'bad-option'), [
            '--mention-group',
            'SGROUP OR other',
          ])
        ).code,
        1,
      );
      assert.equal(requests.length, before);
      evidence.push('discovery-scope-and-feed-failure-boundaries');
    },
  );
  await t.test(
    '429 leaves a checkpoint unadvanced and enforces cooldown across processes',
    async () => {
      const stateRoot = path.join(artifact, 'rate-state');
      scenario = 'rate';
      const first = await poll(stateRoot);
      assert.equal(first.code, 2);
      const state = JSON.parse(
        await readFile(path.join(stateRoot, 'intake', 'state.json'), 'utf8'),
      );
      assert.equal(state.feeds.mentions.checkpoint, undefined);
      assert.ok(state.feeds.inbox.checkpoint);
      assert.ok(
        (await rows(stateRoot)).some(r => r.source.message_ts === searchTs),
      );
      const before = requests.filter(
        r => r.method === 'search.messages',
      ).length;
      const second = await poll(stateRoot);
      assert.equal(second.code, 2);
      assert.equal(
        requests.filter(r => r.method === 'search.messages').length,
        before,
      );
      assert.ok(JSON.parse(second.stdout).retry_after_seconds > 590);
      evidence.push('partial-page-durability-and-persisted-rate-limit');
    },
  );
});
