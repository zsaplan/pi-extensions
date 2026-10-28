import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import {
  discoverAndLoadExtensions,
  getAgentDir,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

type ArtifactRecord = {
  cwd: string;
  sessionCwd: string;
  requestedWorktreePath?: string;
  status: string;
  scope?: {
    repoRoot: string;
    branch: string;
    changedFiles: string[];
    diff: string;
  };
};

// Boundary failures: review the session's decoy checkout, fall back after an
// invalid target, misresolve relative paths, or bypass reviewer-control checks.
// Search failures: use the live index, spend the budget on repeated tree IDs,
// miss frozen untracked files, or silently accept genuinely oversized output.
test(
  'native review tool keeps explicit/default targets and artifacts scoped',
  {timeout: 120_000},
  async () => {
    const sourcePackage = fileURLToPath(new URL('../', import.meta.url));
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'polish-target-')),
    );
    const agent = join(root, 'agent');
    const evidenceParent = join(sourcePackage, 'tmp/worktree-target');
    await mkdir(agent);
    await mkdir(evidenceParent, {recursive: true});
    const evidenceDir = await mkdtemp(join(evidenceParent, 'run-'));
    const savedEnv = Object.fromEntries(
      ['PI_CODING_AGENT_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(
        key => [key, process.env[key]],
      ),
    );
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.GIT_CONFIG_GLOBAL =
      process.platform === 'win32' ? 'NUL' : '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        {cwd, encoding: 'utf8'},
      ).trim();
    const observations: unknown[] = [];
    let passed = false;
    let modelCalls = 0;
    let inspectedReads = 0;
    let inspectedSearches = 0;
    let mutateOnFirstRequest: string | undefined;
    const searchLines = Array.from(
      {length: 600},
      () => `GREP_MATCH ${'x'.repeat(40)}`,
    );
    const searchContent = `${searchLines.join('\n')}\n`;
    const expectedSearch = `${searchLines
      .map((line, index) => `search.txt:${index + 1}:${line}`)
      .join('\n')}\n`;
    assert.ok(Buffer.byteLength(expectedSearch) < 50 * 1024);
    assert.ok(
      Buffer.byteLength(expectedSearch) + searchLines.length * 41 > 50 * 1024,
    );
    const model: Model<'openai-completions'> = {
      id: 'scripted',
      name: 'Scoped review fixture',
      provider: 'polish-target-fixture',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1',
      reasoning: false,
      input: ['text'],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 128000,
      maxTokens: 16000,
    };
    const provider: Parameters<ExtensionAPI['registerProvider']>[1] = {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: 'fixture-only',
      models: [
        {
          id: model.id,
          name: model.name,
          reasoning: false,
          input: ['text'],
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
      ],
      streamSimple(activeModel, context) {
        modelCalls++;
        assert.doesNotMatch(
          JSON.stringify(context.messages),
          /SESSION_ONLY|LIVE_INDEX_ONLY/,
        );
        if (mutateOnFirstRequest) {
          writeFileSync(
            join(mutateOnFirstRequest, 'search.txt'),
            'LIVE_INDEX_ONLY\n',
          );
          git(mutateOnFirstRequest, 'add', 'search.txt');
          mutateOnFirstRequest = undefined;
        }
        const results = context.messages.filter(
          message => message.role === 'toolResult',
        );
        const has = (name: string) =>
          results.some(result => result.toolName === name);
        const read = results.find(result => result.toolName === 'read_file');
        if (read) {
          assert.match(JSON.stringify(read), /TARGET_ONLY/);
          if (!has('grep_repo')) inspectedReads++;
        }
        const searches = results.filter(
          result => result.toolName === 'grep_repo',
        );
        const searchText = (index: number) =>
          searches[index].content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('\n');
        if (searches[0]) {
          assert.equal(searches[0].isError, false);
          assert.equal(searchText(0), expectedSearch);
          assert.match(
            (searches[0].details as {snapshotTree: string}).snapshotTree,
            /^[a-f0-9]{40}$/,
          );
        }
        if (searches[1]) {
          assert.equal(searches[1].isError, false);
          assert.equal(searchText(1), 'new.txt:1:target untracked\n');
        }
        if (searches[2]) {
          assert.equal(searches[2].isError, false);
          assert.equal(searchText(2), 'No matches found under "search.txt".');
        }
        for (const result of searches.slice(1, 3)) {
          assert.equal(
            (result.details as {snapshotTree: string}).snapshotTree,
            (searches[0].details as {snapshotTree: string}).snapshotTree,
          );
        }
        if (searches[3]) {
          assert.equal(searches[3].isError, true);
          assert.match(searchText(3), /grep_repo output is too large/);
          inspectedSearches += searches.length;
        }
        const searchRequests: Array<Record<string, string>> = [
          {pattern: 'GREP_MATCH'},
          {pattern: 'target untracked', path: 'new.txt'},
          {pattern: 'NO_MATCH', path: 'search.txt'},
          {pattern: 'OVERSIZED_MATCH', path: 'oversized.txt'},
        ];
        const name = !has('git_status')
          ? 'git_status'
          : !has('git_diff')
            ? 'git_diff'
            : !has('read_file')
              ? 'read_file'
              : searches.length < searchRequests.length
                ? 'grep_repo'
                : 'submit_review';
        const message: AssistantMessage = {
          role: 'assistant',
          api: activeModel.api,
          provider: activeModel.provider,
          model: activeModel.id,
          timestamp: Date.now(),
          stopReason: 'toolUse',
          content: [
            {
              type: 'toolCall',
              id: randomUUID(),
              name,
              arguments:
                name === 'read_file'
                  ? {path: 'app.txt'}
                  : name === 'grep_repo'
                    ? searchRequests[searches.length]
                    : name === 'submit_review'
                      ? {
                          status: 'approve',
                          summary: 'Scripted scope check only.',
                          findings: [],
                        }
                      : {},
            },
          ],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
          },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({type: 'start', partial: message});
        stream.push({type: 'done', reason: 'toolUse', message});
        stream.end();
        return stream;
      },
    };

    const probe = async (
      label: string,
      cwd: string,
      worktreePath: string | undefined,
      extensionPath = join(sourcePackage, 'src/index.ts'),
    ) => {
      assert.equal(getAgentDir(), agent);
      const loaded = await discoverAndLoadExtensions(
        [extensionPath],
        cwd,
        agent,
      );
      assert.deepEqual(loaded.errors, []);
      const saved: Array<{artifactPath: string}> = [];
      loaded.runtime.getThinkingLevel = () => 'low';
      loaded.runtime.appendEntry = (_type, data) =>
        saved.push(data as {artifactPath: string});
      const tool = loaded.extensions[0].tools.get(
        'polish_solution_review',
      )!.definition;
      const updates: string[] = [];
      const ctx = {
        cwd,
        hasUI: false,
        model,
        modelRegistry: {
          getAvailable: () => [model],
          getRegisteredNativeProvider: () => undefined,
          getRegisteredProviderConfig: () => provider,
        },
      } as unknown as Parameters<typeof tool.execute>[4];
      let output: unknown;
      let error: unknown;
      try {
        output = await tool.execute(
          randomUUID(),
          worktreePath === undefined ? {} : {worktreePath},
          undefined,
          update =>
            updates.push(
              ...update.content
                .filter(part => part.type === 'text')
                .map(part => part.text),
            ),
          ctx,
        );
      } catch (caught) {
        error = caught;
      }
      assert.equal(saved.length, 1);
      const artifact = await readFile(saved[0].artifactPath, 'utf8');
      await writeFile(join(evidenceDir, `${label}.jsonl`), artifact);
      const entries = artifact
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      const record = entries.at(-1).record as ArtifactRecord;
      assert.equal(record.sessionCwd, cwd);
      assert.equal(record.requestedWorktreePath, worktreePath);
      observations.push({
        label,
        artifact: `${label}.jsonl`,
        cwd: record.cwd,
        sessionCwd: record.sessionCwd,
        requestedWorktreePath: record.requestedWorktreePath,
        status: record.status,
        scope: record.scope,
        error: error instanceof Error ? error.message : undefined,
      });
      return {output, error, record, updates};
    };

    try {
      const main = join(root, 'main');
      const target = join(root, 'target worktree');
      const outside = join(root, 'outside');
      await mkdir(main);
      await mkdir(outside);
      git(main, 'init', '-b', 'main');
      await writeFile(join(main, 'app.txt'), 'base\n');
      await writeFile(join(main, 'decoy.txt'), 'base\n');
      await writeFile(join(main, 'search.txt'), searchContent);
      await writeFile(
        join(main, 'oversized.txt'),
        `OVERSIZED_MATCH ${'x'.repeat(80)}\n`.repeat(800),
      );
      git(main, 'add', '.');
      git(main, 'commit', '-m', 'fixture baseline');
      git(main, 'worktree', 'add', '-b', 'feature', target);
      await writeFile(join(main, 'decoy.txt'), 'SESSION_ONLY\n');
      await writeFile(join(target, 'app.txt'), 'TARGET_ONLY\n');
      await writeFile(join(target, 'new.txt'), 'target untracked\n');
      const before = {
        main: git(main, 'status', '--porcelain'),
        target: git(target, 'status', '--porcelain'),
      };

      for (const [label, cwd, selected] of [
        ['explicit', main, target],
        ['relative-from-nongit', outside, '../target worktree'],
        ['default', target, undefined],
      ] as const) {
        const beforeReads = inspectedReads;
        const beforeSearches = inspectedSearches;
        mutateOnFirstRequest = target;
        const {output, error, record, updates} = await probe(
          label,
          cwd,
          selected,
        );
        await writeFile(join(target, 'search.txt'), searchContent);
        git(target, 'add', 'search.txt');
        assert.equal(error, undefined);
        assert.equal(inspectedReads - beforeReads, 5);
        assert.equal(inspectedSearches - beforeSearches, 20);
        assert.equal(record.status, 'success');
        assert.equal(record.scope?.repoRoot, target);
        assert.equal(record.scope?.branch, 'feature');
        assert.deepEqual(record.scope?.changedFiles, ['app.txt', 'new.txt']);
        assert.match(record.scope!.diff, /TARGET_ONLY/);
        assert.doesNotMatch(record.scope!.diff, /SESSION_ONLY/);
        assert.ok(
          updates.some(
            text => text.includes(target) && text.includes('feature'),
          ),
        );
        const result = output as {content: Array<{type: string; text: string}>};
        const visible = JSON.parse(result.content[0].text);
        assert.deepEqual(visible.scope, {
          repoRoot: target,
          branch: 'feature',
          baseRef: 'main',
        });
        assert.equal(visible.status, 'approve');
        assert.equal(visible.category_results.length, 5);
      }

      for (const [label, selected, expected] of [
        [
          'missing',
          join(root, 'does-not-exist'),
          /could not find a git repository/,
        ],
        ['nongit', outside, /could not find a git repository/],
        ['blank', '', /worktreePath must name a directory/],
        ['whitespace', ' \t ', /worktreePath must name a directory/],
      ] as const) {
        const beforeCalls = modelCalls;
        const {output, error, record} = await probe(label, main, selected);
        assert.match(String(error), expected);
        assert.equal(output, undefined);
        assert.equal(record.status, 'error');
        assert.equal(record.scope, undefined);
        assert.equal(modelCalls, beforeCalls);
      }

      const self = join(root, 'self-review');
      await mkdir(self);
      await cp(join(sourcePackage, 'src'), join(self, 'src'), {
        recursive: true,
      });
      await cp(join(sourcePackage, 'skills'), join(self, 'skills'), {
        recursive: true,
      });
      await cp(join(sourcePackage, 'package.json'), join(self, 'package.json'));
      await writeFile(join(self, '.gitignore'), 'node_modules/\n');
      await symlink(
        resolve(sourcePackage, '../node_modules'),
        join(self, 'node_modules'),
        'dir',
      );
      git(self, 'init', '-b', 'main');
      git(self, 'add', '.');
      git(self, 'commit', '-m', 'fixture reviewer baseline');
      await writeFile(
        join(self, 'skills/polish-solution/SKILL.md'),
        'changed reviewer policy\n',
      );
      const selfResult = await probe(
        'self-review',
        outside,
        self,
        join(self, 'src/index.ts'),
      );
      assert.match(String(selfResult.error), /reviewer-control files/);
      assert.equal(selfResult.record.scope, undefined);
      assert.equal(
        await readFile(join(main, 'decoy.txt'), 'utf8'),
        'SESSION_ONLY\n',
      );
      assert.equal(
        await readFile(join(target, 'app.txt'), 'utf8'),
        'TARGET_ONLY\n',
      );
      assert.deepEqual(
        {
          main: git(main, 'status', '--porcelain'),
          target: git(target, 'status', '--porcelain'),
        },
        before,
      );
      passed = true;
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await writeFile(
        join(evidenceDir, 'evidence.json'),
        JSON.stringify(
          {
            passed,
            fixtureRoot: root,
            modelCalls,
            inspectedReads,
            inspectedSearches,
            liveModelCalls: 0,
            scriptedReviewerApprovalOnly: true,
            observations,
          },
          null,
          2,
        ),
      );
      console.log(`Worktree target evidence: ${evidenceDir}`);
    }
  },
);
