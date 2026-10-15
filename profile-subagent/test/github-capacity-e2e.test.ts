import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import {
  registerGithubResearch,
  type ResearchBinding,
} from '../src/github-research.ts';

// Failure mode: separate CLI processes cannot exercise one factory's admission
// race or prove a cancelled slot is released only after its work settles.
test(
  'one research factory: two active sessions, third refused, cancellation releases a slot',
  {timeout: 30000},
  async () => {
    const parent = resolve(
      fileURLToPath(new URL('../tmp/github-research/', import.meta.url)),
    );
    await mkdir(parent, {recursive: true, mode: 0o700});
    const root = await mkdtemp(join(parent, 'capacity-')),
      agent = join(root, 'agent');
    await mkdir(agent, {mode: 0o700});
    const oldAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    const bindings = new Map<string, ResearchBinding>();
    const pending = new Map<string, {release: () => void}>();
    const requests: string[] = [],
      finished: string[] = [];
    let peak = 0,
      registrations = 0,
      passed = false;
    const sessions: Array<
      Awaited<ReturnType<typeof createAgentSession>>['session']
    > = [];
    const prompts: Array<Promise<void>> = [];
    const settings = () =>
      SettingsManager.inMemory({
        retry: {enabled: false},
        compaction: {enabled: false},
        cacheWarming: 'off',
      });
    const provider: Parameters<ExtensionAPI['registerProvider']>[1] = {
      api: 'openai-completions',
      apiKey: 'capacity-fixture',
      baseUrl: 'http://127.0.0.1:1',
      models: [
        {
          id: 'scripted',
          name: 'Fixture parent',
          reasoning: false,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 16000,
        },
        {
          id: 'gpt-6.1-sol',
          name: 'Fixture child',
          reasoning: true,
          input: ['text'],
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          contextWindow: 128000,
          maxTokens: 16000,
        },
      ],
      streamSimple(model, context) {
        const child = getCurrentSystemPrompt(context.messages).includes(
          'Profile: github-researcher.',
        );
        const results = context.messages.filter(m => m.role === 'toolResult');
        const repository = JSON.stringify(
          context.messages.find(m => m.role === 'user'),
        ).match(/fixture\/worker-[1-4]/)?.[0];
        assert.ok(repository);
        const message: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: [],
          stopReason: 'stop',
          usage: {
            input: 17,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 19,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
          },
        };
        if (!results.length) {
          message.stopReason = 'toolUse';
          message.content = [
            {
              type: 'toolCall',
              id: 'research',
              name: child ? 'github_research_read' : 'github_research_run',
              arguments: child
                ? {operation: 'file', repository, path: 'config/example.yml'}
                : {
                    task: `Research ${repository}; preserve unavailable evidence.`,
                  },
            },
          ];
        } else
          message.content = [
            {
              type: 'text',
              text: 'Fixture finished. No valid source observation was obtained; no research conclusion or delivery claimed.',
            },
          ];
        const stream = createAssistantMessageEventStream();
        stream.push({type: 'start', partial: message});
        stream.push({
          type: 'done',
          reason: message.stopReason as 'stop' | 'toolUse',
          message,
        });
        stream.end();
        return stream;
      },
    };
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: agent,
      settingsManager: settings(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        pi => {
          registrations++;
          registerGithubResearch(pi, {
            getBinding: ctx => bindings.get(ctx.sessionManager.getSessionId()),
            token: async () => 'capacity-fixture-token',
            fetch: async (url, options) => {
              const repository = new URL(String(url)).pathname.match(
                /fixture\/worker-[1-4]/,
              )?.[0];
              assert.ok(repository);
              assert.ok(options?.signal);
              assert.ok(!pending.has(repository));
              requests.push(repository);
              return new Promise<Response>((resolve, reject) => {
                const signal = options.signal!;
                const settle = (aborted: boolean) => {
                  signal.removeEventListener('abort', abort);
                  pending.delete(repository);
                  finished.push(repository);
                  if (aborted) reject(new Error('Fixture cancellation'));
                  else resolve(new Response('{}', {status: 200}));
                };
                const abort = () => settle(true);
                pending.set(repository, {release: () => settle(false)});
                peak = Math.max(peak, pending.size);
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, {once: true});
              });
            },
          });
        },
      ],
    });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'Fixture barrier timed out');
        await new Promise(r => setTimeout(r, 5));
      }
    };
    try {
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      for (let i = 1; i <= 4; i++) {
        const manager = SessionManager.inMemory(root),
          sessionId = manager.getSessionId();
        bindings.set(sessionId, {
          taskId: `fixture-task-${i}`,
          sessionId,
          threadKey: `fixture-thread-${i}`,
          reservationId: `fixture-reservation-${i}`,
          deadlineAt: Date.now() + 110000,
          repositories: [
            {
              repository: `fixture/worker-${i}`,
              head: 'a'.repeat(40),
              paths: ['config/'],
              history: false,
              discussions: [],
            },
          ],
        });
        const runtime = await ModelRuntime.create({
          authPath: join(agent, 'auth.json'),
          modelsPath: null,
        });
        runtime.registerProvider('github-capacity-fixture', provider);
        runtime.registerProvider('openai-codex', provider);
        const {session} = await createAgentSession({
          cwd: root,
          agentDir: agent,
          modelRuntime: runtime,
          model: runtime.getModel('github-capacity-fixture', 'scripted'),
          thinkingLevel: 'off',
          tools: ['github_research_run', 'github_research_read'],
          resourceLoader: loader,
          settingsManager: settings(),
          sessionManager: manager,
        });
        sessions.push(session);
      }
      assert.equal(registrations, 1);
      prompts.push(sessions[0].prompt('Research fixture/worker-1'));
      prompts.push(sessions[1].prompt('Research fixture/worker-2'));
      await waitFor(() => pending.size === 2);
      await sessions[2].prompt('Research fixture/worker-3');
      assert.ok(!requests.includes('fixture/worker-3'));
      const denied = sessions[2].messages.find(m => m.role === 'toolResult');
      assert.ok(denied && denied.role === 'toolResult' && denied.isError);
      assert.match(JSON.stringify(denied), /admission/);
      await sessions[0].abort();
      await prompts[0];
      assert.ok(finished.includes('fixture/worker-1'));
      assert.ok(!pending.has('fixture/worker-1'));
      assert.ok(pending.has('fixture/worker-2'));
      prompts.push(sessions[3].prompt('Research fixture/worker-4'));
      await waitFor(() => pending.has('fixture/worker-4'));
      assert.equal(pending.size, 2);
      for (const call of [...pending.values()]) call.release();
      await Promise.all(prompts);
      assert.equal(peak, 2);
      assert.equal(pending.size, 0);
      const summaries = [];
      for (const dir of await readdir(join(agent, 'profile-subagent-runs'))) {
        const report = JSON.parse(
          await readFile(
            join(agent, 'profile-subagent-runs', dir, 'github-result.json'),
            'utf8',
          ),
        ) as {
          status: string;
          binding: {taskId: string; sessionId: string; threadKey: string};
          usage: unknown;
        };
        const i = Number(report.binding.taskId.at(-1));
        assert.equal(report.binding.threadKey, `fixture-thread-${i}`);
        assert.equal(report.status, i === 1 ? 'failed' : 'completed');
        const delivered = sessions[i - 1].messages.find(
          m => m.role === 'toolResult',
        );
        assert.ok(delivered && delivered.role === 'toolResult');
        assert.deepEqual(delivered.usage, report.usage);
        summaries.push({
          taskId: report.binding.taskId,
          status: report.status,
          usage: report.usage,
        });
      }
      assert.equal(summaries.length, 3);
      await writeFile(
        join(root, 'results.json'),
        JSON.stringify(summaries, null, 2),
        {mode: 0o600},
      );
      passed = true;
    } finally {
      await Promise.allSettled(sessions.map(s => s.abort()));
      await Promise.allSettled(prompts);
      sessions.forEach(s => s.dispose());
      if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgent;
      const evidence = {
        passed,
        root,
        registrations,
        peak,
        requests,
        finished,
        stillPending: pending.size,
        liveModelCalls: 0,
        liveGithubCalls: 0,
        backgroundIntegration: false,
      };
      await writeFile(
        join(root, 'evidence.json'),
        JSON.stringify(evidence, null, 2),
        {mode: 0o600},
      );
      await writeFile(
        join(parent, 'capacity-latest.json'),
        JSON.stringify(evidence, null, 2),
        {mode: 0o600},
      );
    }
  },
);
