import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
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
} from '@earendil-works/pi-coding-agent';

// Packed-resource E2E: registration/filtering, existing-session reload and
// explicit skill expansion can fail independently of Markdown correctness.
// Scripted transport validates delivery, not a model's instruction compliance.
const [installed, agentDir, cwd] = process.argv.slice(2);
const manifestPath = join(installed, 'package.json');
const original = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(original);
await writeFile(
  manifestPath,
  JSON.stringify({...manifest, pi: {...manifest.pi, skills: []}}),
);
const settingsManager = SettingsManager.create(cwd, agentDir);
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
});
await loader.reload();
assert.ok(
  !loader.getSkills().skills.some(s => s.name === 'request-specialist'),
);
const runtime = await ModelRuntime.create();
let capturedSystem = '',
  capturedUser = '';
runtime.registerProvider('skill-reload-fixture', {
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'fixture',
  models: [
    {
      id: 'scripted',
      name: 'Skill reload fixture',
      reasoning: false,
      input: ['text'],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 128000,
      maxTokens: 16000,
    },
  ],
  streamSimple(model, context) {
    capturedSystem = getCurrentSystemPrompt(context.messages);
    capturedUser = JSON.stringify(
      context.messages.filter(m => m.role === 'user'),
    );
    const message: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      content: [{type: 'text', text: 'SKILL_DELIVERED'}],
      stopReason: 'stop',
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
    stream.push({type: 'done', reason: 'stop', message});
    stream.end();
    return stream;
  },
});
const {session} = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime: runtime,
  model: runtime.getModel('skill-reload-fixture', 'scripted'),
  thinkingLevel: 'off',
  tools: ['read'],
  settingsManager,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
});
try {
  assert.ok(!session.systemPrompt.includes('<name>request-specialist</name>'));
  // Model an installed package update while the user's settings stay unchanged.
  await writeFile(manifestPath, original);
  await session.reload();
  const {skills, diagnostics} = loader.getSkills();
  assert.ok(
    !diagnostics.some(d => d.path?.startsWith(join(installed, 'skills'))),
  );
  const matching = skills.filter(s => s.name === 'request-specialist');
  assert.equal(matching.length, 1);
  const skill = matching[0];
  assert.equal(
    skill.filePath,
    join(installed, 'skills/request-specialist/SKILL.md'),
  );
  assert.equal(skill.disableModelInvocation, false);
  for (const name of ['CAPABILITIES.md', 'REQUEST_TEMPLATE.md'])
    assert.ok(
      (await readFile(join(dirname(skill.filePath), name), 'utf8')).trim(),
    );
  await session.prompt('/skill:request-specialist REQUEST_ARGUMENT_MARKER');
  assert.ok(capturedSystem.includes(skill.description));
  assert.ok(capturedSystem.includes(skill.filePath));
  assert.ok(capturedUser.includes('REQUEST_ARGUMENT_MARKER'));
  assert.ok(capturedUser.includes('# Request a specialist'));
  assert.ok(capturedUser.includes(skill.filePath));
  assert.equal(session.getLastAssistantText(), 'SKILL_DELIVERED');
  assert.ok(!session.messages.some(m => m.role === 'toolResult'));
  console.log(
    JSON.stringify({
      passed: true,
      absentBeforeManifestReload: true,
      skills: skills.map(s => ({name: s.name, path: s.filePath})),
      advertisedAfterReload: true,
      explicitCommandExpanded: true,
      relativeReferencesReadable: true,
      paidModelCalls: 0,
      requestActuallyDrafted: false,
    }),
  );
} finally {
  session.dispose();
  await writeFile(manifestPath, original);
}
