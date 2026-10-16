import assert from 'node:assert/strict';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createServer, type ServerResponse} from 'node:http';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const pkg = fileURLToPath(new URL('..', import.meta.url));
const {TaskStore} = (await import(
  path.join(pkg, 'dist/store.js')
)) as typeof import('../src/store.ts');
const {prepareTaskSession} = (await import(
  path.join(pkg, 'dist/worker.js')
)) as typeof import('../src/worker.ts');
const plain = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(p => p.text ?? '').join('')
      : '';

test('scoped log polling through the compiled CLI and real Pi sessions', async t => {
  await mkdir(path.join(pkg, 'tmp'), {recursive: true});
  const evidence = await mkdtemp(path.join(pkg, 'tmp/logs-e2e-'));
  const agentDir = path.join(evidence, 'agent');
  await mkdir(agentDir);
  const preload = path.join(evidence, 'fetch.mjs');
  await writeFile(
    preload,
    "const original=fetch;globalThis.fetch=(input,options)=>{const u=new URL(String(input));if(['https://slack.com','https://grafana.britecorepro.com'].includes(u.origin))return original(process.env.FIXTURE_ORIGIN+u.pathname+u.search,options);if(u.origin===process.env.FIXTURE_ORIGIN)return original(input,options);throw Error('Unexpected destination');};",
  );
  const clock = path.join(evidence, 'clock.mjs');
  await writeFile(
    clock,
    "import timers from 'node:timers/promises';import {performance} from 'node:perf_hooks';import {syncBuiltinESMExports} from 'node:module';const now=performance.now.bind(performance),origin=now(),sleep=timers.setTimeout;Object.defineProperty(performance,'now',{value:()=>new Error().stack.includes('/dist/cadence.js')?origin+(now()-origin)*1000:now()});timers.setTimeout=(ms,...args)=>sleep(new Error().stack.includes('/dist/cadence.js')?ms/1000:ms,...args);syncBuiltinESMExports();",
  );
  let mode = 'ok';
  let quality = false,
    quiet = false,
    traceMode = 'ok',
    postMode = 'ok';
  let invalidPublic = '';
  let followupMode = false,
    checkpointFault = '';
  const traceSearches: string[] = [];
  const qualityPrompts: {
    investigation: {
      previous_checkpoint?: unknown;
      planned_followup?: unknown;
      can_schedule_one_followup?: boolean;
    };
    new_log_observations?: unknown;
  }[] = [];
  let manifestPath = '',
    chartPath = '';
  let traceCalls = 0;
  const publicMessages: Record<string, string>[] = [];
  const qualityEvidence: unknown[] = [];
  const traceId = '0123456789abcdef0123456789abcdef';
  const rankedIds = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32), traceId];
  const fetchedTraces: string[] = [];
  const answer = [
    '*Finding:* Faro is configured on.',
    '',
    '- *Evidence:* Sampled trace returned HTTP 404.',
    '- *Limit:* User impact is not established.',
    '',
    '*Next:* Check the failed request.',
  ].join('\n');
  let rows: [string, string][] = [];
  let logCalls = 0,
    slackCalls = 0,
    modelCalls = 0;
  let activeModels = 0,
    maxModels = 0,
    activeLogs = 0,
    maxLogs = 0;
  let held: (() => void) | undefined;
  let holdNext = false;
  let replyText = '';
  const ownerTs = `${Math.floor(Date.now() / 1000) - 1}.000009`;
  let fixtureError: unknown;
  let injectBadTool = false;
  let modelStatus = 'review';
  const snapshots: {sequence: number; rows: {message: string}[]}[] = [];
  const prompts: Record<string, unknown>[] = [];
  const outcomes: unknown[] = [];
  const children: ChildProcess[] = [];
  const stream = (
    res: ServerResponse,
    calls?: {name: string; arguments: string}[],
    text = 'Recorded.',
  ) => {
    const id = `call_${modelCalls}`;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const delta = calls
      ? {
          role: 'assistant',
          tool_calls: calls.map((call, index) => ({
            index,
            id: `${id}_${index}`,
            type: 'function',
            function: call,
          })),
        }
      : {role: 'assistant', content: text};
    for (const [d, finish] of [
      [delta, null],
      [{}, calls ? 'tool_calls' : 'stop'],
    ])
      res.write(
        `data: ${JSON.stringify({id, object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{index: 0, delta: d, finish_reason: finish}]})}\n\n`,
      );
    res.end('data: [DONE]\n\n');
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://fixture');
      let body = '';
      for await (const part of req) body += part;
      const json = (value: unknown) => {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify(value));
      };
      if (
        url.pathname === '/api/datasources/name/tempo-test' ||
        url.pathname.startsWith('/api/datasources/proxy/uid/fixture-tempo/')
      ) {
        traceCalls++;
        assert.equal(req.method, 'GET');
        assert.equal(
          req.headers.authorization,
          'Bearer grafana-fixture-secret',
        );
        if (traceMode === 'denied') {
          res.writeHead(403);
          return res.end();
        }
        if (traceMode === 'rate') {
          res.writeHead(429, {'retry-after': '60'});
          return res.end();
        }
        if (traceMode === 'hang') return;
        if (url.pathname.endsWith('/tempo-test'))
          return json({
            name: 'tempo-test',
            type: 'tempo',
            uid: 'fixture-tempo',
          });
        if (url.pathname.endsWith('/api/search')) {
          traceSearches.push(url.searchParams.get('q')!);
          assert.match(
            url.searchParams.get('q')!,
            /resource.client_name = "acme-test"/,
          );
          assert.equal(url.searchParams.get('limit'), '6');
          assert.ok(
            url.searchParams.get('start') && url.searchParams.get('end'),
          );
          if (traceMode === 'malformed') return json({});
          return json({
            traces: traceMode.startsWith('ranked')
              ? rankedIds.map(id => ({
                  traceID: id,
                  rootServiceName:
                    id === traceId ? 'britecore' : 'britecore-frontend',
                }))
              : traceMode === 'empty'
                ? []
                : [{traceID: traceId}],
            metrics: {
              totalJobs: 1,
              completedJobs: traceMode === 'partial' ? 0 : 1,
            },
          });
        }
        const requestedId = url.pathname.split('/').at(-1)!;
        assert.ok(
          (traceMode.startsWith('ranked') ? rankedIds : [traceId]).includes(
            requestedId,
          ),
        );
        assert.equal(
          url.pathname,
          `/api/datasources/proxy/uid/fixture-tempo/api/traces/${requestedId}`,
        );
        fetchedTraces.push(requestedId);
        const backend =
          !traceMode.startsWith('ranked') || requestedId === traceId;
        const attributes =
          traceMode === 'unattributed'
            ? []
            : [
                {
                  key: 'client_name',
                  value: {
                    stringValue:
                      traceMode === 'cross' ||
                      (traceMode === 'ranked-cross' && backend)
                        ? 'other-site'
                        : 'acme-test',
                  },
                },
              ];
        attributes.push({
          key: 'service.name',
          value: {
            stringValue: !backend
              ? 'britecore-frontend'
              : traceMode.startsWith('ranked')
                ? 'britecore'
                : 'briteauth',
          },
        });
        const spans = [
          {
            traceId: requestedId,
            name: backend ? 'GET /users/None' : 'browser.request',
            startTimeUnixNano: '1791830000000000000',
            endTimeUnixNano: '1791830000040000000',
            status: {code: backend ? 2 : 0},
            attributes: [
              {key: 'http.status_code', value: {intValue: backend ? 404 : 200}},
              {
                key: 'authorization',
                value: {stringValue: 'grafana-fixture-secret'},
              },
              {key: 'user.email', value: {stringValue: 'private@example.com'}},
            ],
          },
        ];
        return json({
          batches: [
            {
              resource: {attributes},
              scopeSpans: [
                {
                  spans:
                    traceMode === 'span-cap'
                      ? Array.from({length: 501}, () => spans[0])
                      : spans,
                },
              ],
            },
          ],
        });
      }
      if (url.pathname.startsWith('/api/datasources/')) {
        assert.equal(req.method, 'GET');
        assert.equal(
          req.headers.authorization,
          'Bearer grafana-fixture-secret',
        );
        if (url.pathname === '/api/datasources/name/loki-test')
          return json({uid: 'fixture-loki', name: 'loki-test', type: 'loki'});
        assert.equal(
          url.pathname,
          '/api/datasources/proxy/uid/fixture-loki/loki/api/v1/query_range',
        );
        assert.ok(
          url.searchParams
            .get('query')!
            .startsWith('{client_name="acme-test"}'),
        );
        assert.equal(url.searchParams.get('limit'), '201');
        logCalls++;
        activeLogs++;
        maxLogs = Math.max(maxLogs, activeLogs);
        res.once('close', () => activeLogs--);
        if (mode === 'rate') {
          res.writeHead(429, {'retry-after': '60'});
          return res.end();
        }
        if (mode === 'redirect') {
          res.writeHead(302, {location: '/forbidden'});
          return res.end();
        }
        if (mode === 'hang') return;
        if (mode === 'large')
          return json({status: 'success', padding: 'x'.repeat(2100000)});
        if (mode === 'bad')
          return json({status: 'success', data: {result: []}});
        const values =
          mode === 'cap'
            ? Array.from({length: 201}, (_, i) => [
                String(BigInt(Date.now() - 1000) * 1000000n + BigInt(i)),
                'Error',
              ])
            : rows;
        return json({
          status: 'success',
          data: {
            resultType: 'streams',
            result: values.length
              ? [
                  {
                    stream: {
                      client_name:
                        mode === 'cross' ? 'other-site' : 'acme-test',
                      service_name: 'britecore',
                      ...(traceMode === 'ranked-linked'
                        ? {trace_id: rankedIds[2]}
                        : {}),
                      levelname: 'ERROR',
                      authorization: 'not-for-model',
                    },
                    values,
                  },
                ]
              : [],
          },
        });
      }
      if (url.pathname.endsWith('/chat/completions')) {
        modelCalls++;
        activeModels++;
        maxModels = Math.max(maxModels, activeModels);
        res.once('close', () => activeModels--);
        const input = JSON.parse(body);
        const messages = input.messages;
        const names = (input.tools ?? []).map(
          (x: {function: {name: string}}) => x.function.name,
        );
        const data = JSON.parse(
          plain(
            messages.filter((m: {role: string}) => m.role === 'user').at(-1)
              .content,
          ),
        );
        if (!names.length)
          return stream(
            res,
            undefined,
            JSON.stringify({
              action: 'route',
              task_id: data.receipt.candidate_task_ids[0],
            }),
          );
        assert.ok(
          names.every((n: string) =>
            [
              'write_artifact',
              'finish_task',
              'task_sync_slack',
              'task_reply',
              'read_source_thread',
              'read_task_logs',
              'read_site_configuration',
              'inspect_task_traces',
            ].includes(n),
          ),
        );
        const last = messages.at(-1);
        if (quality) {
          const current = messages
            .slice(
              messages.map((m: {role: string}) => m.role).lastIndexOf('user') +
                1,
            )
            .filter((m: {role: string}) => m.role === 'tool');
          if (!current.length) {
            qualityPrompts.push(data);
            if (checkpointFault === 'fail') {
              checkpointFault = '';
              return stream(res, undefined, 'Stopped without an outcome.');
            }
            const skip = checkpointFault === 'skip';
            if (skip) checkpointFault = '';
            return stream(res, [
              ...(data.new_log_observations
                ? [{name: 'read_task_logs', arguments: '{}'}]
                : []),
              {
                name: 'read_site_configuration',
                arguments: '{"path":"other.yaml"}',
              },
              {name: 'inspect_task_traces', arguments: '{"site":"other-site"}'},
              {name: 'read_site_configuration', arguments: '{}'},
              ...(!skip
                ? [
                    {name: 'inspect_task_traces', arguments: '{}'},
                    {name: 'inspect_task_traces', arguments: '{}'},
                  ]
                : []),
            ]);
          }
          const parsed = current.flatMap((m: {content: unknown}) => {
            try {
              return [JSON.parse(plain(m.content))];
            } catch {
              return [];
            }
          });
          if (
            current.some((m: {content: unknown}) =>
              plain(m.content).includes('planned_followup_not_checked'),
            ) &&
            !parsed.some((value: {search?: unknown}) => value.search)
          )
            return stream(res, [
              {name: 'inspect_task_traces', arguments: '{}'},
            ]);
          if (
            current.some((m: {content: unknown}) =>
              plain(m.content).includes('"recorded":true'),
            )
          )
            return stream(res);
          qualityEvidence.push(
            ...current.map((m: {content: unknown}) => {
              try {
                return JSON.parse(plain(m.content));
              } catch {
                return {tool_error: plain(m.content)};
              }
            }),
          );
          const bad = invalidPublic;
          invalidPublic = '';
          const plan: Record<string, unknown> = {
            question: 'What does the scoped telemetry establish?',
            lead: 'Check whether the authentication error has a failing dependency.',
            result: 'The checks are bounded; user impact remains unknown.',
            status:
              followupMode && data.investigation.can_schedule_one_followup
                ? 'follow_up'
                : 'blocked',
            evidence_refs: [
              ...new Set(
                parsed.flatMap((value: {evidence_ref?: string}) =>
                  value.evidence_ref ? [value.evidence_ref] : [],
                ),
              ),
            ].slice(0, 8),
            next_check:
              followupMode && data.investigation.can_schedule_one_followup
                ? {
                    service: 'briteauth',
                    purpose:
                      'Inspect additional authentication traces for dependency failures.',
                  }
                : null,
          };
          if (checkpointFault === 'evidence')
            plan.evidence_refs = ['evidence:invented'];
          if (checkpointFault === 'service') {
            plan.status = 'follow_up';
            plan.next_check = {
              service: 'unobserved-service',
              purpose: 'Read another service.',
            };
          }
          if (checkpointFault === 'exhausted') {
            plan.status = 'follow_up';
            plan.next_check = {
              service: 'briteauth',
              purpose: 'Repeat the completed check.',
            };
          }
          checkpointFault = '';
          return stream(res, [
            {
              name: 'finish_task',
              arguments: JSON.stringify({
                status: 'review',
                summary:
                  bad || 'Faro is configured; trace findings require review.',
                next_action: 'Confirm user impact before taking action.',
                question: null,
                reply: quiet
                  ? null
                  : 'This completion must not echo the final answer.',
                private_notes:
                  'Sent one concise task-DM reply. findings.md remains local.',
                investigation: plan,
              }),
            },
            ...(!quiet
              ? [
                  {
                    name: 'task_reply',
                    arguments: JSON.stringify({
                      task_id: data.task_id,
                      text: answer,
                      needs_response: false,
                    }),
                  },
                ]
              : []),
          ]);
        }
        if (last.role !== 'tool') {
          prompts.push(data);
          if (holdNext) {
            holdNext = false;
            await new Promise<void>(resolve => {
              held = resolve;
              res.once('close', resolve);
            });
            if (res.destroyed) return;
          }
          if (data.new_log_observations) {
            const calls = [{name: 'read_task_logs', arguments: '{}'}];
            if (injectBadTool)
              calls.unshift({
                name: 'read_task_logs',
                arguments: JSON.stringify({
                  site: 'other-site',
                  query: '{}',
                  url: 'https://evil.invalid',
                }),
              });
            return stream(res, calls);
          }
        }
        const currentTools = messages
          .slice(
            messages.map((m: {role: string}) => m.role).lastIndexOf('user') + 1,
          )
          .filter((m: {role: string}) => m.role === 'tool');
        if (
          currentTools.some((m: {content: unknown}) =>
            plain(m.content).includes('"recorded":true'),
          )
        )
          return stream(res);
        const logResult = currentTools
          .map((m: {content: unknown}) => {
            try {
              return JSON.parse(plain(m.content));
            } catch {
              return null;
            }
          })
          .find((x: {scope?: unknown} | null) => x?.scope);
        if (logResult) snapshots.push(logResult);
        return stream(res, [
          {
            name: 'write_artifact',
            arguments: JSON.stringify({
              filename: 'findings.md',
              content: JSON.stringify(logResult ?? {owner_followup: true}),
            }),
          },
          {
            name: 'finish_task',
            arguments: JSON.stringify({
              status: modelStatus,
              summary:
                'Reviewed local log evidence; user impact remains unverified.',
              next_action: 'Review local findings.',
              reply:
                modelStatus === 'waiting'
                  ? null
                  : 'Reviewed local log evidence; user impact remains unverified.',
              question:
                modelStatus === 'waiting' ? 'Please clarify scope.' : null,
            }),
          },
        ]);
      }
      const params = Object.fromEntries(new URLSearchParams(body));
      slackCalls++;
      if (url.pathname === '/api/chat.update')
        return json({ok: true, channel: params.channel, ts: params.ts});
      if (url.pathname === '/api/chat.postMessage') {
        assert.equal(params.channel, 'DASSIST');
        assert.match(params.thread_ts, /^1791830000\.\d{6}$/);
        const ts = `${Math.floor(Date.now() / 1000)}.${String(publicMessages.length + 1).padStart(6, '0')}`;
        publicMessages.push({...params, ts, user: 'UBOT'});
        if (postMode === 'uncertain') {
          postMode = 'ok';
          res.writeHead(502);
          return res.end();
        }
        return json({ok: true, channel: params.channel, ts});
      }
      const bot = req.headers.authorization === 'Bearer fixture-bot';
      if (url.pathname === '/api/auth.test')
        return json({
          ok: true,
          team_id: 'TONE',
          user_id: bot ? 'UBOT' : 'UOWNER',
          ...(bot ? {bot_id: 'BONE'} : {}),
        });
      if (url.pathname === '/api/conversations.info')
        return json({
          ok: true,
          channel: {id: 'DASSIST', is_im: true, user: 'UOWNER'},
        });
      if (url.pathname === '/api/conversations.history')
        return json({
          ok: true,
          messages: [],
          has_more: false,
          response_metadata: {next_cursor: ''},
        });
      if (url.pathname === '/api/conversations.replies')
        return json({
          ok: true,
          messages: [
            ...(params.channel === 'DASSIST'
              ? publicMessages.filter(
                  message => message.thread_ts === params.ts,
                )
              : []),
            ...(params.channel === 'DASSIST' && replyText
              ? [
                  {
                    user: 'UOWNER',
                    ts: ownerTs,
                    thread_ts: params.ts,
                    text: replyText,
                  },
                ]
              : []),
          ],
          has_more: false,
          response_metadata: {next_cursor: ''},
        });
      assert.fail(`Unexpected endpoint ${url.pathname}`);
    })().catch(error => {
      fixtureError = error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: origin + '/v1',
          api: 'openai-completions',
          apiKey: 'fake-key',
          models: [
            {
              id: 'fixture-model',
              name: 'Fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
              compat: {supportsDeveloperRole: false},
            },
          ],
        },
      },
    }),
  );
  let parentSequence = 0;
  const create = async (name: string) => {
    const root = path.join(evidence, name);
    const store = await TaskStore.acquire(root);
    try {
      const {item} = await store.enqueue({
        request: 'Monitor only the selected site logs. Keep findings local.',
        outcome: 'A bounded local log report, with uncertainty.',
        sources: [
          {
            workspace_id: 'TONE',
            channel_id: 'CSOURCE',
            message_ts: '1791830000.000000',
          },
        ],
        inbox: {
          workspace_id: 'TONE',
          channel_id: 'DASSIST',
          owner_user_id: 'UOWNER',
          bot_user_id: 'UBOT',
        },
      });
      await prepareTaskSession(store, item.task);
      // Separate roots represent distinct published threads, not other bots' history.
      item.task.slack.parent_ts = `1791830000.${String(++parentSequence).padStart(6, '0')}`;
      await store.save(item.task);
      return {root, id: item.task.id, session: item.task.session.id};
    } finally {
      await store.close();
    }
  };
  const run = (
    task: {root: string; id: string},
    seconds?: number,
    site = 'acme-test',
    omitLogs = false,
  ) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        preload,
        ...(seconds ? ['--import', clock] : []),
        path.join(pkg, 'dist/cli.js'),
        'serve',
        '--root',
        task.root,
        '--provider',
        'fixture',
        '--model',
        'fixture-model',
        '--agent-dir',
        agentDir,
        '--search-api',
        'legacy',
        '--conversation',
        'DASSIST',
        '--inbox-only',
        '--task-id',
        task.id,
        ...(seconds ? ['--pilot-seconds', String(seconds)] : ['--once']),
        ...(omitLogs ? [] : ['--log-site', site, '--log-environment', 'test']),
        ...(quality
          ? [
              '--site-manifest',
              manifestPath,
              '--bundle-chart',
              chartPath,
              '--allow-slack-writes',
            ]
          : []),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: agentDir,
          SLACK_USER_TOKEN: 'fixture-user',
          SLACK_BOT_TOKEN: 'fixture-bot',
          GRAFANA_SERVICE_ACCOUNT_KEY: 'grafana-fixture-secret',
          FIXTURE_ORIGIN: origin,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let stdout = '',
      stderr = '';
    child.stdout!.on('data', v => (stdout += v));
    child.stderr!.on('data', v => (stderr += v));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const result = new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>(resolve =>
      child.once('exit', code => {
        clearTimeout(timer);
        resolve({code, stdout, stderr});
      }),
    );
    return {child, result};
  };
  const waitFor = async (check: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      if (fixtureError) throw fixtureError;
      if (await check()) return;
      await sleep(10);
    }
    throw Error('Fixture wait timed out');
  };
  const state = async (task: {root: string; id: string}) =>
    JSON.parse(
      await readFile(
        path.join(task.root, 'intake', 'logs', task.id + '.json'),
        'utf8',
      ),
    );
  const journal = async (task: {root: string; id: string}) =>
    JSON.parse(
      await readFile(path.join(task.root, 'runs', task.id + '.json'), 'utf8'),
    );
  const row = (message: string, offset = 0): [string, string] => [
    String(BigInt(Date.now() - 1000) * 1000000n + BigInt(offset)),
    message,
  ];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    held?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(
      path.join(evidence, 'report.json'),
      JSON.stringify(
        {
          suite: 'scoped-log-cli',
          base_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: pkg,
            encoding: 'utf8',
          }).trim(),
          worktree: true,
          node: process.version,
          pi: JSON.parse(
            await readFile(
              new URL(
                '../package.json',
                import.meta.resolve('@earendil-works/pi-coding-agent'),
              ),
              'utf8',
            ),
          ).version,
          outcomes,
          live_slack: false,
          live_grafana: false,
          live_model: false,
        },
        null,
        2,
      ),
    );
    t.diagnostic(`Evidence: ${path.join(evidence, 'report.json')}`);
  });

  await t.test(
    'snapshot is scoped/redacted; unchanged restart is idle',
    async () => {
      const task = await create('restart');
      rows = [
        row(
          'Unauthorized token=grafana-fixture-secret\nAuthorization: Basic Zm9vOmJhcg==\npassword="multi word secret"\nuser@example.com',
        ),
      ];
      injectBadTool = true;
      const first = await run(task).result;
      assert.equal(first.code, 0, first.stdout + first.stderr);
      assert.equal((await journal(task)).handled_logs, 1);
      assert.equal(snapshots.at(-1)!.rows.length, 1);
      assert.ok(
        !JSON.stringify(snapshots.at(-1)).includes('grafana-fixture-secret'),
      );
      assert.ok(!JSON.stringify(snapshots.at(-1)).includes('not-for-model'));
      assert.doesNotMatch(
        JSON.stringify(snapshots.at(-1)),
        /Zm9vOmJhcg|multi word secret|user@example/,
      );
      const before = modelCalls;
      assert.equal((await run(task).result).code, 0);
      assert.equal(modelCalls, before);
      assert.equal((await journal(task)).session_id, task.session);
      injectBadTool = false;
      outcomes.push({
        scenario: 'restart-idle-scope-redaction',
        task_id: task.id,
        session: task.session,
        passed: true,
      });
      const requests = slackCalls + logCalls;
      assert.equal((await run(task, undefined, 'other-site').result).code, 1);
      assert.equal(
        (await run(task, undefined, 'acme-test', true).result).code,
        1,
      );
      assert.equal(slackCalls + logCalls, requests);
      assert.equal((await run(task, undefined, 'acme-test.*').result).code, 1);
      assert.equal(slackCalls + logCalls, requests);
    },
  );
  await t.test(
    'empty first window is analyzed once without claiming health',
    async () => {
      const task = await create('empty');
      rows = [];
      const before = modelCalls;
      assert.equal((await run(task).result).code, 0);
      assert.ok(modelCalls > before);
      assert.equal(snapshots.at(-1)!.rows.length, 0);
      const count = modelCalls;
      assert.equal((await run(task).result).code, 0);
      assert.equal(modelCalls, count);
      outcomes.push({scenario: 'empty-once', passed: true});
    },
  );
  await t.test(
    'capped, malformed, cross-site, oversized and redirect results fail closed',
    async () => {
      for (const failure of ['cap', 'bad', 'cross', 'large', 'redirect']) {
        const task = await create(failure);
        mode = failure;
        rows = [row('Error')];
        const before = modelCalls;
        const result = await run(task).result;
        assert.equal(result.code, 1, result.stdout);
        assert.equal(modelCalls, before);
        assert.equal((await state(task)).sequence, 0);
        assert.equal((await state(task)).last_poll.status, 'partial');
        outcomes.push({scenario: failure, passed: true});
      }
      mode = 'ok';
    },
  );
  await t.test('Retry-After survives process restart', async () => {
    const task = await create('rate');
    mode = 'rate';
    assert.equal((await run(task).result).code, 1);
    const before = logCalls;
    mode = 'ok';
    assert.equal((await run(task).result).code, 1);
    assert.equal(logCalls, before);
    outcomes.push({scenario: 'persisted-cooldown', passed: true});
  });
  await t.test(
    'new logs and owner reply during active model work resume one session after settlement',
    async () => {
      const task = await create('overlap');
      rows = [row('first-error')];
      holdNext = true;
      const before = snapshots.length;
      const running = run(task, 8);
      try {
        await waitFor(() => Boolean(held));
        const calls = logCalls;
        rows.push(row('second-error', 1));
        replyText = 'Please retain the uncertainty in the local findings.';
        await waitFor(
          async () => logCalls > calls && (await state(task)).sequence === 2,
        );
        held!();
        held = undefined;
        await waitFor(async () => {
          try {
            return (
              (await journal(task)).phase === 'settled' &&
              (await journal(task)).handled_logs === 2
            );
          } catch {
            return false;
          }
        });
        assert.equal(snapshots[before].sequence, 1);
        assert.equal(snapshots[before].rows.length, 1);
        assert.equal(snapshots.at(-1)!.sequence, 2);
        assert.equal(snapshots.at(-1)!.rows[0].message, 'second-error');
        assert.equal((await journal(task)).session_id, task.session);
        assert.equal(maxModels, 1);
        assert.equal(maxLogs, 1);
        assert.ok(
          prompts.some(prompt =>
            JSON.stringify(prompt.new_information).includes(replyText),
          ),
        );
        assert.equal((await journal(task)).handled.length, 1);
        running.child.kill('SIGTERM');
        assert.equal((await running.result).code, 0);
        outcomes.push({
          scenario: 'active-overlap-snapshot-journal-owner-reply',
          passed: true,
        });
      } finally {
        replyText = '';
        held?.();
        held = undefined;
        running.child.kill('SIGTERM');
        await running.result;
      }
    },
  );
  await t.test(
    'a failed log poll cancels active work without acknowledging the snapshot',
    async () => {
      const task = await create('fail-active');
      rows = [row('pending-evidence')];
      holdNext = true;
      const running = run(task, 8);
      try {
        await waitFor(() => Boolean(held));
        mode = 'bad';
        const result = await running.result;
        assert.equal(result.code, 1, result.stdout);
        assert.equal((await journal(task)).handled_logs, 0);
        assert.equal((await journal(task)).error, 'cancelled');
        outcomes.push({scenario: 'failed-poll-cancels-worker', passed: true});
      } finally {
        mode = 'ok';
        held?.();
        held = undefined;
        running.child.kill('SIGTERM');
        await running.result;
      }
    },
  );
  await t.test(
    'deadline cancels active model without acknowledging unread newer evidence',
    async () => {
      const task = await create('cancel-model');
      rows = [row('resume-me')];
      holdNext = true;
      const running = run(task, 2);
      await waitFor(() => Boolean(held));
      const result = await running.result;
      held?.();
      held = undefined;
      assert.equal(result.code, 0, result.stdout);
      assert.equal((await journal(task)).handled_logs, 0);
      assert.equal((await journal(task)).error, 'cancelled');
      assert.equal((await run(task).result).code, 0);
      assert.equal((await journal(task)).handled_logs, 1);
      const store = await TaskStore.acquire(task.root);
      await store.close();
      outcomes.push({scenario: 'deadline-and-recovery', passed: true});
    },
  );
  await t.test(
    'deadline aborts a held log HTTP request and releases ownership',
    async () => {
      const task = await create('cancel-http');
      mode = 'hang';
      const result = await run(task, 2).result;
      assert.equal(result.code, 0, result.stdout);
      assert.equal((await state(task)).sequence, 0);
      const store = await TaskStore.acquire(task.root);
      await store.close();
      mode = 'ok';
      outcomes.push({scenario: 'http-cancellation', passed: true});
    },
  );
  await t.test(
    'waiting task is not reopened by a new log observation',
    async () => {
      const task = await create('waiting');
      rows = [row('question')];
      modelStatus = 'waiting';
      assert.equal((await run(task).result).code, 0);
      const before = modelCalls;
      rows.push(row('new-error', 2));
      assert.equal((await run(task).result).code, 0);
      assert.equal(modelCalls, before);
      assert.equal((await state(task)).sequence, 2);
      assert.equal((await journal(task)).handled_logs, 1);
      modelStatus = 'review';
      outcomes.push({scenario: 'waiting-preserved', passed: true});
    },
  );
  await t.test(
    'configuration and trace tools produce one answer, silence unchanged findings, and recover uncertain delivery before new work',
    async () => {
      quality = true;
      quiet = false;
      rows = [row('auth warning')];
      publicMessages.length = 0;
      chartPath = path.join(evidence, 'bundle');
      await mkdir(chartPath);
      manifestPath = path.join(evidence, 'site.yaml');
      const manifest = (enabled?: boolean, extras = '') =>
        `kind: Site\nmetadata:\n  name: acme-test\nspec:\n  client: acme-test\n  environment: test\n${extras}  application:\n    chart:\n      version: 1.2.3\n    values:\n      global:\n        client: acme-test\n        faro:\n${enabled === undefined ? '' : `          enabled: ${enabled}\n`}      credentials: private@example.com\n`;
      await writeFile(
        path.join(chartPath, 'Chart.yaml'),
        'name: bundle\nversion: 1.2.3\n',
      );
      await writeFile(
        path.join(chartPath, 'values.yaml'),
        'global:\n  faro:\n    enabled: false\nbritecore:\n  enabled: true\nbriteauth:\n  enabled: false\n',
      );
      await writeFile(manifestPath, manifest(true));
      const task = await create('quality');
      postMode = 'uncertain';
      const first = await run(task).result;
      assert.equal(first.code, 2, first.stdout + first.stderr);
      assert.equal(publicMessages.length, 1);
      assert.equal(publicMessages[0].text, answer);
      assert.equal(publicMessages[0].mrkdwn, 'true');
      assert.equal((await journal(task)).outcome.reply, answer);
      assert.equal(
        traceCalls,
        3,
        'Invalid configuration/trace overrides must not cause additional reads',
      );
      assert.match((await journal(task)).outcome.private_notes, /findings.md/);
      rows.push(row('same auth warning', 4));
      quiet = true;
      const recovered = await run(task).result;
      assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
      assert.equal(publicMessages.length, 1);
      assert.equal((await journal(task)).outcome.reply, null);
      const calls = modelCalls;
      assert.equal((await run(task).result).code, 0);
      assert.equal(modelCalls, calls);
      assert.equal(publicMessages.length, 1);
      const legacy = await journal(task);
      legacy.investigation_version = 1;
      await writeFile(
        path.join(task.root, 'runs', task.id + '.json'),
        JSON.stringify(legacy),
      );
      const beforeUpgrade: number = modelCalls;
      const upgraded = await run(task).result;
      assert.equal(upgraded.code, 0, upgraded.stdout + upgraded.stderr);
      assert.ok(modelCalls > beforeUpgrade);
      assert.equal((await journal(task)).investigation_version, 4);
      assert.equal(publicMessages.length, 1);
      outcomes.push({
        scenario: 'capability-upgrade-rechecks-same-task-without-new-logs',
        passed: true,
      });
      quiet = false;
      replyText = 'Is Faro enabled, and what do the traces show?';
      assert.equal((await run(task).result).code, 0);
      assert.equal(publicMessages.length, 2);
      assert.equal(publicMessages[1].text, answer);
      assert.equal((await journal(task)).session_id, task.session);
      replyText = '';
      const config = qualityEvidence.find(x =>
        Boolean((x as {faro?: unknown}).faro),
      ) as {faro: {effective: boolean; source: string}; services: unknown[]};
      assert.equal(config.faro.effective, true);
      assert.equal(config.faro.source, 'manifest');
      const trace = qualityEvidence.find(x =>
        Boolean((x as {traces?: unknown}).traces),
      ) as {traces: {error_span_count: number}[]};
      assert.equal(trace.traces[0].error_span_count, 1);
      assert.doesNotMatch(
        JSON.stringify(qualityEvidence),
        /grafana-fixture-secret|private@example/,
      );
      outcomes.push({
        scenario:
          'one-answer-silence-uncertain-recovery-owner-repeat-config-trace',
        passed: true,
      });
      for (const bad of [
        'See findings.md for the details.',
        'Sent one concise task-DM reply.',
      ]) {
        invalidPublic = bad;
        const check = await create('bad-output-' + publicMessages.length);
        const before: number = publicMessages.length;
        const result = await run(check).result;
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(publicMessages.length, before + 1);
        assert.equal(publicMessages.at(-1)!.text, answer);
        assert.doesNotMatch(
          await readFile(
            path.join(check.root, 'review', check.id, 'task.json'),
            'utf8',
          ),
          /Sent one concise|findings.md/,
        );
      }
      outcomes.push({
        scenario:
          'internal-notes-and-inaccessible-filename-rejected-before-publication',
        passed: true,
      });
      for (const failure of [
        'empty',
        'denied',
        'partial',
        'cross',
        'unattributed',
        'span-cap',
        'malformed',
      ]) {
        traceMode = failure;
        const check = await create('trace-' + failure);
        const before = qualityEvidence.length;
        const result = await run(check).result;
        assert.equal(result.code, 0, result.stdout + result.stderr);
        const resultTrace = qualityEvidence
          .slice(before)
          .find(x => Boolean((x as {traces?: unknown}).traces)) as {
          search: {status: string};
          traces: {status: string}[];
        };
        assert.ok(resultTrace);
        if (failure === 'empty') assert.equal(resultTrace.traces.length, 0);
        else if (['denied', 'malformed'].includes(failure))
          assert.equal(resultTrace.search.status, 'unavailable');
        else if (failure === 'partial') {
          assert.equal(resultTrace.search.status, 'queried');
          assert.equal(resultTrace.traces[0].status, 'inspected');
          assert.match(JSON.stringify(resultTrace), /"job_coverage":"partial"/);
        } else assert.equal(resultTrace.traces[0].status, 'unavailable');
        outcomes.push({scenario: 'trace-' + failure, passed: true});
      }
      for (const selectedMode of ['ranked', 'ranked-linked', 'ranked-cross']) {
        traceMode = selectedMode;
        const check = await create(selectedMode),
          beforeFetch = fetchedTraces.length,
          beforeEvidence = qualityEvidence.length;
        const checked = await run(check).result;
        assert.equal(checked.code, 0, checked.stdout + checked.stderr);
        assert.deepEqual(
          fetchedTraces.slice(beforeFetch),
          selectedMode === 'ranked-linked'
            ? [rankedIds[2], traceId, rankedIds[0]]
            : [traceId, rankedIds[0], rankedIds[1]],
        );
        const resultTrace = qualityEvidence
          .slice(beforeEvidence)
          .find(x => Boolean((x as {traces?: unknown}).traces)) as {
          traces: {
            trace_id: string;
            status: string;
            selection_hint: string;
            error?: string;
          }[];
        };
        const relevant = resultTrace.traces.find(t => t.trace_id === traceId)!;
        assert.equal(relevant.selection_hint, 'error_service_match');
        assert.equal(
          relevant.status,
          selectedMode === 'ranked-cross' ? 'unavailable' : 'inspected',
        );
        if (selectedMode === 'ranked-cross') {
          assert.equal(relevant.error, 'tempo_cross_site_trace');
          assert.doesNotMatch(
            JSON.stringify(relevant),
            /http_status|services|slowest_spans/,
          );
        }
        outcomes.push({
          scenario: selectedMode + '-three-request-budget',
          passed: true,
        });
      }
      traceMode = 'hang';
      const cancellation = await create('trace-cancel');
      const sentBefore = publicMessages.length;
      const interrupted = await run(cancellation, 2).result;
      assert.equal(
        interrupted.code,
        0,
        interrupted.stdout + interrupted.stderr,
      );
      assert.equal((await journal(cancellation)).error, 'cancelled');
      assert.equal((await journal(cancellation)).handled_logs, 0);
      assert.equal(publicMessages.length, sentBefore);
      traceMode = 'ok';
      const resumed = await run(cancellation).result;
      assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
      assert.equal((await journal(cancellation)).investigation_version, 4);
      assert.equal(
        (await journal(cancellation)).session_id,
        cancellation.session,
      );
      outcomes.push({
        scenario: 'trace-request-cancellation-and-same-session-recovery',
        passed: true,
      });
      await writeFile(
        manifestPath,
        'kind: HelmRelease\nmetadata:\n  name: acme-test\nspec:\n  chart:\n    spec:\n      chart: bundle\n      version: 1.2.3\n  values:\n    global:\n      client: acme-test\n      environment: test\n      faro:\n        enabled: false\n',
      );
      const helm = await create('helm-manifest');
      const helmResult = await run(helm).result;
      assert.equal(helmResult.code, 0, helmResult.stdout + helmResult.stderr);
      assert.equal(
        (
          qualityEvidence
            .filter(x => Boolean((x as {faro?: unknown}).faro))
            .at(-1) as {faro: {effective: unknown}}
        ).faro.effective,
        false,
      );
      await writeFile(manifestPath, manifest());
      const inherited = await create('inherited');
      await run(inherited).result;
      assert.equal(
        (
          qualityEvidence
            .filter(x => Boolean((x as {faro?: unknown}).faro))
            .at(-1) as {faro: {source: string}}
        ).faro.source,
        'chart_default',
      );
      await writeFile(
        manifestPath,
        manifest(
          true,
          '  valuesFrom:\n    - kind: Secret\n      name: unseen\n',
        ),
      );
      const extra = await create('extra-values');
      await run(extra).result;
      assert.equal(
        (
          qualityEvidence
            .filter(x => Boolean((x as {faro?: unknown}).faro))
            .at(-1) as {faro: {effective: unknown}}
        ).faro.effective,
        null,
      );
      for (const [name, text] of [
        [
          'wrong-site',
          manifest(true).replace('client: acme-test', 'client: other'),
        ],
        [
          'wrong-version',
          manifest(true).replace('version: 1.2.3', 'version: 9.9.9'),
        ],
      ]) {
        await writeFile(manifestPath, text);
        const wrong = await create(name);
        const before: number = slackCalls + traceCalls + logCalls + modelCalls;
        assert.equal((await run(wrong).result).code, 1);
        assert.equal(slackCalls + traceCalls + logCalls + modelCalls, before);
      }
      await writeFile(manifestPath, manifest(true));
      quality = false;
      const before = slackCalls + modelCalls + logCalls;
      assert.equal((await run(task).result).code, 1);
      assert.equal(slackCalls + modelCalls + logCalls, before);
      outcomes.push({
        scenario:
          'config-default-extra-values-identity-version-missing-capability',
        passed: true,
      });
    },
  );
  await t.test(
    'saved leads drive one scoped follow-up across CLI restarts without poll-driven loops',
    async () => {
      quality = true;
      quiet = true;
      followupMode = true;
      traceMode = 'ok';
      rows = [row('Authentication path needs investigation.')];
      const task = await create('followup');
      const first = await run(task).result;
      assert.equal(first.code, 0, first.stdout + first.stderr);
      const saved = (await journal(task)).investigation_progress;
      assert.equal(saved.checkpoint.status, 'follow_up');
      assert.equal(saved.checkpoint.next_check.service, 'briteauth');
      assert.ok(
        saved.checkpoint.references.some(
          (ref: {ref: string}) =>
            ref.ref === saved.checkpoint.next_check.basis_ref,
        ),
      );
      const sent = publicMessages.length,
        queries = traceSearches.length,
        fetched = fetchedTraces.length;
      checkpointFault = 'skip';
      const next = await run(task).result;
      assert.equal(next.code, 0, next.stdout + next.stderr);
      assert.equal((await journal(task)).session_id, task.session);
      assert.deepEqual(
        qualityPrompts.at(-1)!.investigation.previous_checkpoint,
        saved.checkpoint,
      );
      assert.equal(qualityPrompts.at(-1)!.new_log_observations, undefined);
      assert.equal(traceSearches.length, queries + 1);
      assert.ok(
        traceSearches
          .at(-1)!
          .includes(') && resource.service.name = "briteauth"'),
      );
      assert.equal(fetchedTraces.length, fetched + 1); // Concurrent identical calls share one request.
      assert.equal(
        (await journal(task)).investigation_progress.followup_used,
        true,
      );
      assert.equal(
        (await journal(task)).investigation_progress.checkpoint.status,
        'blocked',
      );
      const beforeIdle = modelCalls;
      assert.equal((await run(task).result).code, 0);
      assert.equal(modelCalls, beforeIdle);
      assert.equal(publicMessages.length, sent);
      rows = [
        row('A later observation cannot replenish the follow-up budget.'),
      ];
      checkpointFault = 'exhausted';
      assert.equal((await run(task).result).code, 0);
      assert.equal(
        qualityPrompts.at(-1)!.investigation.can_schedule_one_followup,
        false,
      );
      assert.equal(
        (await journal(task)).investigation_progress.followup_used,
        true,
      );
      for (const fault of ['evidence', 'service']) {
        checkpointFault = fault;
        const bad = await create('followup-invalid-' + fault);
        const repaired = await run(bad).result;
        assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
        const session = await readFile(
          (await journal(bad)).session_file,
          'utf8',
        );
        assert.match(
          session,
          fault === 'evidence'
            ? /unknown_checkpoint_evidence/
            : /followup_service_not_observed/,
        );
        assert.equal(
          (await journal(bad)).investigation_progress.checkpoint.next_check
            .service,
          'briteauth',
        );
      }
      const session = await readFile(
        (await journal(task)).session_file,
        'utf8',
      );
      assert.match(session, /planned_followup_not_checked/);
      assert.match(session, /followup_budget_exhausted/);
      outcomes.push({
        scenario:
          'durable-lead-one-followup-idle-budget-evidence-service-guards',
        passed: true,
      });
    },
  );
  await t.test(
    'cancelled follow-ups retain their checkpoint and settle in the same session; owner changes supersede old checks',
    async () => {
      quality = true;
      quiet = true;
      followupMode = true;
      traceMode = 'ok';
      rows = [row('A scoped error lead.')];
      const task = await create('followup-recovery');
      assert.equal((await run(task).result).code, 0);
      const saved = (await journal(task)).investigation_progress;
      const sent = publicMessages.length;
      traceMode = 'hang';
      const stopped = await run(task, 2).result;
      assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
      assert.equal((await journal(task)).error, 'cancelled');
      assert.deepEqual((await journal(task)).investigation_progress, saved);
      assert.equal(publicMessages.length, sent);
      traceMode = 'cross';
      const resumed = await run(task).result;
      assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
      assert.equal((await journal(task)).session_id, task.session);
      assert.equal(
        (await journal(task)).investigation_progress.followup_used,
        true,
      );
      const withheld = qualityEvidence
        .filter(x =>
          Boolean((x as {followup_service?: string}).followup_service),
        )
        .at(-1) as {traces: unknown[]};
      assert.match(JSON.stringify(withheld.traces), /tempo_cross_site_trace/);
      assert.doesNotMatch(
        JSON.stringify(withheld.traces),
        /http_status|services|slowest_spans/,
      );
      const beforeIdle = modelCalls;
      assert.equal((await run(task).result).code, 0);
      assert.equal(modelCalls, beforeIdle);
      traceMode = 'ok';
      const redirected = await create('followup-owner-correction');
      assert.equal((await run(redirected).result).code, 0);
      followupMode = false;
      quiet = false;
      replyText =
        'Change the question: only establish Faro configuration; do not continue the old authentication check.';
      const queryStart = traceSearches.length;
      const revised = await run(redirected).result;
      assert.equal(revised.code, 0, revised.stdout + revised.stderr);
      assert.equal(
        qualityPrompts.at(-1)!.investigation.planned_followup,
        undefined,
      );
      assert.equal(
        qualityPrompts.at(-1)!.investigation.can_schedule_one_followup,
        true,
      );
      assert.ok(
        traceSearches
          .slice(queryStart)
          .every(query => !query.includes('resource.service.name')),
      );
      assert.equal(
        (await journal(redirected)).investigation_progress.followup_used,
        false,
      );
      assert.equal(
        (await journal(redirected)).investigation_progress.checkpoint.status,
        'blocked',
      );
      replyText = '';
      quiet = true;
      followupMode = true;
      for (const status of ['waiting', 'done'] as const) {
        const held = await create('followup-no-reopen-' + status);
        assert.equal((await run(held).result).code, 0);
        const store = await TaskStore.acquire(held.root);
        await store.move(held.id, status);
        await store.close();
        const before = modelCalls;
        assert.equal((await run(held).result).code, 0);
        assert.equal(modelCalls, before);
      }
      outcomes.push({
        scenario:
          'followup-cancellation-attribution-owner-supersession-waiting-done',
        passed: true,
      });
      quality = false;
      followupMode = false;
    },
  );
  await t.test(
    'failed follow-ups retain their checkpoint without retry and changed progress scope fails closed',
    async () => {
      quality = true;
      quiet = true;
      followupMode = true;
      traceMode = 'ok';
      rows = [row('Error requiring a follow-up.')];
      const failed = await create('followup-worker-failure');
      assert.equal((await run(failed).result).code, 0);
      const beforeFailure = (await journal(failed)).investigation_progress;
      checkpointFault = 'fail';
      assert.equal((await run(failed).result).code, 2);
      assert.equal((await journal(failed)).phase, 'failed');
      assert.deepEqual(
        (await journal(failed)).investigation_progress,
        beforeFailure,
      );
      const failedCalls = modelCalls;
      assert.equal((await run(failed).result).code, 0);
      assert.equal(modelCalls, failedCalls);
      const corrupt = await create('followup-scope-mismatch');
      assert.equal((await run(corrupt).result).code, 0);
      const wrongScope = await journal(corrupt);
      wrongScope.investigation_progress.scope.site = 'other-site';
      await writeFile(
        path.join(corrupt.root, 'runs', corrupt.id + '.json'),
        JSON.stringify(wrongScope),
      );
      const beforeScope = modelCalls + traceCalls;
      const rejected = await run(corrupt).result;
      assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
      assert.match(
        rejected.stdout + rejected.stderr,
        /investigation_progress_scope_mismatch/,
      );
      assert.equal(modelCalls + traceCalls, beforeScope);
      outcomes.push({
        scenario: 'failed-checkpoint-retained-no-retry-and-scope-mismatch',
        passed: true,
      });
      quality = false;
      followupMode = false;
    },
  );
  assert.equal(fixtureError, undefined);
});
