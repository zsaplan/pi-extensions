// Offline upgrade acceptance: real Pi SDK, extension loader, HTTP transport,
// child reviewers, tool execution, and restored session context. No paid calls.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import console from 'node:console';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {clearTimeout, setTimeout} from 'node:timers';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.resolve(process.argv[2] ?? 'tmp/pi-upgrade-smoke.json');
const scratch = await mkdtemp(path.join(tmpdir(), 'pi-upgrade-'));
process.env.PI_CODING_AGENT_DIR = path.join(scratch, 'agent');
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
const requests = [];
const results = [];
let session;
let timer;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer upgrade-fixture');
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const tools = (request.tools ?? []).map(tool => tool.function.name);
    const toolResults = request.messages.filter(
      message => message.role === 'tool',
    );
    const child = tools.includes('submit_review');
    let name;
    let args = {};
    if (child) {
      name = ['git_status', 'git_diff', 'submit_review'][toolResults.length];
      assert.ok(name, 'Reviewer should terminate after submit_review');
      if (name === 'submit_review') {
        args = {
          status: 'approve',
          summary: 'Local transport fixture completed.',
          findings: [],
        };
      }
    } else if (!toolResults.length) {
      name = 'polish_solution_review';
      args = {baseRef: 'HEAD'};
    }
    requests.push({
      child,
      tools,
      call: name ?? null,
      toolResults: toolResults.length,
    });
    const delta = name
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}`,
              type: 'function',
              function: {name, arguments: JSON.stringify(args)},
            },
          ],
        }
      : {role: 'assistant', content: 'Upgrade fixture complete.'};
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    for (const [part, finish] of [
      [delta, null],
      [{}, name ? 'tool_calls' : 'stop'],
    ]) {
      res.write(
        `data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'upgrade-fixture', choices: [{index: 0, delta: part, finish_reason: finish}]})}\n\n`,
      );
    }
    res.end('data: [DONE]\n\n');
  } catch (error) {
    results.push({serverError: String(error)});
    res.writeHead(500);
    res.end('Fixture rejected request');
  }
});

try {
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  const cwd = path.join(scratch, 'repo');
  await mkdir(cwd);
  const git = (...args) => execFileSync('git', args, {cwd, stdio: 'pipe'});
  git('init', '-b', 'main');
  await writeFile(path.join(cwd, 'example.txt'), 'before\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Upgrade Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture baseline',
  );
  await writeFile(path.join(cwd, 'example.txt'), 'after\n');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sdk = await import('@earendil-works/pi-coding-agent');
  const manifest = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  );
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      ...manifest.pi.extensions.map(entry => path.join(root, entry)),
      ...process.argv.slice(3),
    ],
    extensionFactories: [
      pi =>
        pi.registerProvider('upgrade-fixture', {
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'upgrade-fixture',
          models: [
            {
              id: 'upgrade-fixture',
              name: 'Upgrade fixture',
              reasoning: false,
              input: ['text'],
              cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
              contextWindow: 100000,
              maxTokens: 4096,
            },
          ],
        }),
    ],
  });
  await loader.reload();
  assert.deepEqual(
    loader.getExtensions().errors,
    [],
    'Every extension must load',
  );
  const runtime = await sdk.ModelRuntime.create();
  const manager = sdk.SessionManager.inMemory(cwd);
  ({session} = await sdk.createAgentSession({
    cwd,
    resourceLoader: loader,
    modelRuntime: runtime,
    sessionManager: manager,
    noTools: 'builtin',
    settingsManager: sdk.SettingsManager.inMemory({
      cacheWarming: 'off',
      compaction: {enabled: false},
      retry: {enabled: false},
    }),
  }));
  const model = runtime.getModel('upgrade-fixture', 'upgrade-fixture');
  assert.ok(model);
  await session.setModel(model);
  session.setActiveToolsByName(['polish_solution_review']);
  session.subscribe(event => {
    if (event.type === 'tool_execution_end')
      results.push({
        tool: event.toolName,
        isError: event.isError,
        result: event.result,
      });
  });
  timer = setTimeout(() => void session.abort(), 60000);
  await session.prompt('Run the review fixture.');
  clearTimeout(timer);
  assert.equal(session.getLastAssistantText(), 'Upgrade fixture complete.');
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, false, JSON.stringify(results));
  assert.equal(
    results[0].result.details.status,
    'approve',
    JSON.stringify(results),
  );
  assert.equal(
    requests.filter(request => request.call === 'submit_review').length,
    5,
  );
  const restored = sdk.SessionManager.inMemory(
    cwd,
    {id: manager.getSessionId()},
    manager.getEntries(),
  );
  assert.deepEqual(
    restored.buildSessionContext().messages,
    manager.buildSessionContext().messages,
  );
  const report = {
    status: 'passed',
    piVersion: JSON.parse(
      await readFile(
        path.join(
          root,
          'node_modules/@earendil-works/pi-coding-agent/package.json',
        ),
        'utf8',
      ),
    ).version,
    loadedExtensions: loader
      .getExtensions()
      .extensions.map(extension => extension.path),
    restoredContext: true,
    requests,
    results,
  };
  await mkdir(path.dirname(artifact), {recursive: true});
  await writeFile(artifact, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `Passed: ${requests.length} local HTTP requests; five isolated reviewers; session restore. Artifact: ${artifact}`,
  );
} catch (error) {
  await mkdir(path.dirname(artifact), {recursive: true});
  await writeFile(
    artifact,
    JSON.stringify(
      {status: 'failed', error: String(error), requests, results},
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  clearTimeout(timer);
  session?.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, {recursive: true, force: true});
}
