import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ResultValidationError,
  ToolInputError,
  buildFactFileIndex,
  buildLookupActionOutput,
  buildLookupUsage,
  createRainmanExtension,
  ensureKnowledgeMarkdownPath,
  ensureWithinKbRoot,
  findTool,
  formatActionOutputTail,
  formatUsageSummary,
  getLookupArtifactMode,
  grepTool,
  readCitationLines,
  readTool,
  shouldNudgeRainmanLookup,
  toKbRelativePath,
  validateCitations,
  validateResult,
  type Citation,
  type VerificationResult,
} from "../src/index.ts";

type CodedError = Error & { code?: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type TestUI = {
  theme: { fg: (_color: string, value: string) => string };
  statusCalls: Array<{ key: string; value: string | undefined }>;
  workingMessageCalls: Array<string | undefined>;
  notifications: Array<{ message: string; level: string }>;
  currentStatus: string | undefined;
  currentWorkingMessage: string | undefined;
  setStatus: (key: string, value: string | undefined) => void;
  setWorkingMessage: (message?: string) => void;
  notify: (message: string, level: string) => void;
};

type TestPi = {
  events: Map<string, Array<(...args: any[]) => unknown>>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  entries: Array<{ customType: string; data: unknown }>;
  on: (event: string, handler: (...args: any[]) => unknown) => void;
  registerTool: (tool: any) => void;
  registerCommand: (name: string, command: any) => void;
  appendEntry: <T>(customType: string, data: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTestUi(): TestUI {
  return {
    theme: { fg: (_color: string, value: string) => value },
    statusCalls: [],
    workingMessageCalls: [],
    notifications: [],
    currentStatus: undefined,
    currentWorkingMessage: undefined,
    setStatus(key: string, value: string | undefined): void {
      this.statusCalls.push({ key, value });
      this.currentStatus = value;
    },
    setWorkingMessage(message?: string): void {
      this.workingMessageCalls.push(message);
      this.currentWorkingMessage = message;
    },
    notify(message: string, level: string): void {
      this.notifications.push({ message, level });
    },
  };
}

function createTestPi(): TestPi {
  return {
    events: new Map(),
    tools: new Map(),
    commands: new Map(),
    entries: [],
    on(event: string, handler: (...args: any[]) => unknown): void {
      const list = this.events.get(event) ?? [];
      list.push(handler);
      this.events.set(event, list);
    },
    registerTool(tool: any): void {
      this.tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any): void {
      this.commands.set(name, command);
    },
    appendEntry<T>(customType: string, data: T): void {
      this.entries.push({ customType, data });
    },
  };
}

function createTestContext(ui: TestUI) {
  const model = { provider: "test-provider", id: "test-model" };
  return {
    hasUI: true,
    ui,
    model,
    modelRegistry: {
      getAvailable(): Array<typeof model> {
        return [model];
      },
    },
    sessionManager: {
      getBranch(): unknown[] {
        return [];
      },
    },
    signal: undefined,
    cwd: process.cwd(),
  };
}

function createLookupUsageSummary() {
  return {
    model: "test-provider/test-model",
    turns: 1,
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: 0,
  };
}

function createLookupOutcome(question: string, kbRoot: string) {
  const usage = createLookupUsageSummary();
  return {
    result: {
      status: "answered" as const,
      data: { answer: `Answer for ${question}` },
      citations: [],
      missingInformation: [],
      warnings: [],
      meta: {
        model: usage.model!,
        kbRoot,
      },
    },
    execution: {
      model: usage.model!,
      kbRoot,
      startedAt: "2026-04-24T00:00:00.000Z",
      completedAt: "2026-04-24T00:00:01.000Z",
      elapsedMs: 1000,
      elapsed: "0:01",
      usage,
    },
    diagnostics: {
      usage,
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      toolAccess: {
        activeToolNames: ["read"],
        configuredToolNames: ["read", "submit_result"],
        systemPromptHasAvailableTools: true,
        systemPromptHasSubmitResult: true,
      },
    },
  };
}

function createMockArtifactWriter(mode: "off" | "failure" | "always", ref?: { id: string; path: string }) {
  return {
    mode,
    ref,
    appended: [] as unknown[],
    flushCalls: 0,
    discardCalls: 0,
    append(entry: unknown): Promise<void> {
      this.appended.push(entry);
      return Promise.resolve();
    },
    appendBestEffort(entry: unknown): void {
      this.appended.push(entry);
    },
    flush(): Promise<void> {
      this.flushCalls += 1;
      return Promise.resolve();
    },
    discard(): Promise<void> {
      this.discardCalls += 1;
      this.ref = undefined;
      return Promise.resolve();
    },
    getWarning(): string | undefined {
      return undefined;
    },
  };
}

function writeFact(kbRoot: string, file: string, lines: string[]): void {
  fs.writeFileSync(path.join(kbRoot, file), `${lines.join("\n")}\n`);
}

function createKb(t: test.TestContext): string {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainman-kb-"));
  t.after(() => fs.rmSync(kbRoot, { recursive: true, force: true }));

  writeFact(kbRoot, "PI__WORKFLOW.md", [
    "# PI / WORKFLOW",
    "",
    "- PREFERS | package-local verify | when=validating packages",
    "- DEFINES | rainman lookup contract | scope=public tool",
  ]);

  writeFact(kbRoot, "BAD.md", [
    "# PI / WORKFLOW",
    "",
    "- PREFERS | malformed filename still has content",
  ]);

  for (let index = 0; index < 25; index += 1) {
    const subject = `PKG${String(index).padStart(2, "0")}`;
    writeFact(kbRoot, `${subject}__TOPIC.md`, [
      `# ${subject} / TOPIC`,
      "",
      `- PREFERS | common object ${index} | scope=test`,
    ]);
  }

  return kbRoot;
}

function assertErrorCode(error: unknown, code: string): void {
  assert.ok(error instanceof Error);
  assert.equal((error as CodedError).code, code);
}

function assertThrowsCode(callback: () => unknown, code: string): void {
  assert.throws(callback, (error: unknown) => {
    assertErrorCode(error, code);
    return true;
  });
}

function answerCitation(): Citation {
  return {
    path: "/data/answer",
    file: "PI__WORKFLOW.md",
    startLine: 3,
    endLine: 3,
    quote: "- PREFERS | package-local verify | when=validating packages",
  };
}

test("path safety enforces markdown, containment, traversal rejection, and KB-relative conversion", (t) => {
  const kbRoot = createKb(t);
  const filePath = "PI__WORKFLOW.md";
  const absolutePath = path.join(kbRoot, filePath);

  assert.doesNotThrow(() => ensureKnowledgeMarkdownPath(filePath));
  assert.equal(ensureWithinKbRoot(kbRoot, filePath), fs.realpathSync.native(absolutePath));
  assert.equal(toKbRelativePath(kbRoot, absolutePath), filePath);

  assertThrowsCode(() => ensureKnowledgeMarkdownPath("PI__WORKFLOW.txt"), "NON_MARKDOWN_FILE");
  assertThrowsCode(() => ensureKnowledgeMarkdownPath("../PI__WORKFLOW.md"), "PATH_ESCAPE");
  assertThrowsCode(() => ensureKnowledgeMarkdownPath(absolutePath), "PATH_ESCAPE");
  assertThrowsCode(() => ensureWithinKbRoot(kbRoot, "../outside.md"), "PATH_ESCAPE");
  assertThrowsCode(() => toKbRelativePath(kbRoot, path.join(kbRoot, "..", "outside.md")), "PATH_ESCAPE");
});

test("KB indexing and navigation tools expose only lint-clean fact files with deterministic limits", (t) => {
  const kbRoot = createKb(t);
  const fileIndex = buildFactFileIndex(kbRoot);

  assert.ok(fileIndex.validFileSet.has("PI__WORKFLOW.md"));
  assert.equal(fileIndex.validFileSet.has("BAD.md"), false);
  assert.deepEqual(fileIndex.invalidFiles.map((entry) => entry.file), ["BAD.md"]);
  assert.match(fileIndex.warnings.join("\n"), /Skipped 1 malformed fact file/);

  const readResult = readTool(kbRoot, fileIndex, {
    filePath: "PI__WORKFLOW.md",
    offset: 3,
    limit: 1,
  });
  assert.equal(readResult.startLine, 3);
  assert.equal(readResult.endLine, 3);
  assert.equal(readResult.content, "3 | - PREFERS | package-local verify | when=validating packages");
  assert.deepEqual(readResult.structuredFacts.map((fact) => fact.relation), ["PREFERS"]);

  assertThrowsCode(() => readTool(kbRoot, fileIndex, { filePath: "BAD.md" }), "INVALID_FACT_FILE");
  assertThrowsCode(() => readTool(kbRoot, fileIndex, { filePath: "PI__WORKFLOW.md", limit: 0 }), "INVALID_LIMIT");

  assert.equal(findTool(fileIndex, { query: "PKG" }).length, 20);
  assert.equal(findTool(fileIndex, { query: "PKG", limit: 3 }).length, 3);
  assertThrowsCode(() => findTool(fileIndex, { query: "PKG", limit: 0 }), "INVALID_LIMIT");

  const grepHits = grepTool(kbRoot, fileIndex, { pattern: "common object", limit: 2 });
  assert.equal(grepHits.length, 2);
  assert.ok(grepHits.every((hit) => hit.file.startsWith("PKG")));
  assert.deepEqual(grepTool(kbRoot, fileIndex, { pattern: "", limit: 2 }), []);
  assertThrowsCode(() => grepTool(kbRoot, fileIndex, { pattern: "common", limit: 0 }), "INVALID_LIMIT");
});

test("citation validation requires existing lint-clean files, valid line ranges, and exact quotes", (t) => {
  const kbRoot = createKb(t);
  const fileIndex = buildFactFileIndex(kbRoot);
  const citation = answerCitation();

  assert.equal(readCitationLines(kbRoot, "PI__WORKFLOW.md", 3, 3), citation.quote);
  assert.doesNotThrow(() => validateCitations(kbRoot, [citation], fileIndex));

  assertThrowsCode(
    () => validateCitations(kbRoot, [{ ...citation, quote: "different" }], fileIndex),
    "QUOTE_MISMATCH",
  );
  assertThrowsCode(() => readCitationLines(kbRoot, "PI__WORKFLOW.md", 99, 99), "LINE_RANGE_OUT_OF_BOUNDS");
  assertThrowsCode(
    () => validateCitations(kbRoot, [{ ...citation, file: "BAD.md", startLine: 1, endLine: 1, quote: "# PI / WORKFLOW" }], fileIndex),
    "INVALID_CITATION_FILE",
  );
  assertThrowsCode(
    () => validateCitations(kbRoot, [{ ...citation, file: "../PI__WORKFLOW.md" }], fileIndex),
    "PATH_ESCAPE",
  );
});

test("result validation rejects uncited, unsupported, and malformed payloads", (t) => {
  const kbRoot = createKb(t);
  const fileIndex = buildFactFileIndex(kbRoot);
  const context = { kbRoot, model: "test/model", fileIndex };
  const citation = answerCitation();

  const valid = validateResult(
    {
      status: "answered",
      data: { answer: "Use package-local verify." },
      citations: [citation],
      missingInformation: [],
      warnings: [],
    },
    context,
  );
  assert.equal(valid.status, "answered");
  assert.deepEqual(valid.meta, { model: "test/model", kbRoot });

  assertThrowsCode(
    () => validateResult({ status: "answered", data: { answer: "uncited" }, citations: [], missingInformation: [], warnings: [] }, context),
    "UNCITED_FIELD",
  );

  assertThrowsCode(
    () => validateResult(
      {
        status: "answered",
        data: { answer: "ok", extra: "not part of the response contract" },
        citations: [
          citation,
          {
            path: "/data/extra",
            file: "PI__WORKFLOW.md",
            startLine: 4,
            endLine: 4,
            quote: "- DEFINES | rainman lookup contract | scope=public tool",
          },
        ],
        missingInformation: [],
        warnings: [],
      },
      context,
    ),
    "UNSUPPORTED_DATA_FIELD",
  );

  assertThrowsCode(
    () => validateResult({ status: "insufficient_evidence", data: { answer: "speculative" }, citations: [], missingInformation: [], warnings: [] }, context),
    "UNSUPPORTED_DATA_FIELD",
  );

  const conflict = validateResult(
    {
      status: "conflict",
      data: { conflicts: ["package verify", "public tool contract"] },
      citations: [
        { ...citation, path: "/data/conflicts/0" },
        {
          path: "/data/conflicts/1",
          file: "PI__WORKFLOW.md",
          startLine: 4,
          endLine: 4,
          quote: "- DEFINES | rainman lookup contract | scope=public tool",
        },
      ],
      missingInformation: [],
      warnings: [],
    },
    context,
  );
  assert.equal(conflict.status, "conflict");

  assertThrowsCode(
    () => validateResult(
      {
        status: "conflict",
        data: { conflicts: ["package verify", "public tool contract"] },
        citations: [{ ...citation, path: "/data/conflicts/0" }],
        missingInformation: [],
        warnings: [],
      },
      context,
    ),
    "UNCITED_FIELD",
  );

  assertThrowsCode(
    () => validateResult(
      {
        status: "answered",
        data: { answer: "ok" },
        citations: [citation],
        missingInformation: [123],
        warnings: [],
      } as unknown as VerificationResult,
      context,
    ),
    "INVALID_SCHEMA",
  );

  assert.ok(new ResultValidationError("TEST", "message") instanceof Error);
  assert.ok(new ToolInputError("TEST", "message") instanceof Error);
});

test("lookup nudging targets stable knowledge questions and skips live-state/current incident prompts", () => {
  assert.equal(shouldNudgeRainmanLookup("What do we know about package verification workflow?"), true);
  assert.equal(shouldNudgeRainmanLookup("Where is the source of truth repository for response review?"), true);
  assert.equal(shouldNudgeRainmanLookup("According to prior conclusions, what path owns themes?"), true);

  assert.equal(shouldNudgeRainmanLookup("What is failing right now in production?"), false);
  assert.equal(shouldNudgeRainmanLookup("Check Grafana logs for this traceback"), false);
  assert.equal(shouldNudgeRainmanLookup("run the tests"), false);
});

test("lookup usage summaries aggregate assistant message token usage", () => {
  const usage = buildLookupUsage([
    {
      role: "assistant",
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 400,
        output: 50,
        cacheRead: 600,
        cacheWrite: 10,
        totalTokens: 1060,
        cost: { total: 0.01 },
      },
    },
    {
      role: "assistant",
      usage: {
        input: 100,
        output: 25,
      },
    },
    { role: "user", usage: { input: 999 } },
  ], "fallback/model");

  assert.equal(usage.model, "fallback/model");
  assert.equal(usage.turns, 2);
  assert.equal(usage.input, 500);
  assert.equal(usage.output, 75);
  assert.equal(usage.cacheRead, 600);
  assert.equal(usage.cacheWrite, 10);
  assert.equal(usage.totalTokens, 1185);
  assert.equal(formatUsageSummary(usage), "1.2k tokens · 2 turns · ↑500 · ↓75 · R600 · W10");
});

test("lookup action output formatting tail-truncates streamed tool results", () => {
  const text = Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`).join("\n");
  assert.equal(
    formatActionOutputTail(text, 3, 1000),
    "line 18\nline 19\nline 20\n\n[showing lines 18-20 of 20]",
  );

  const output = buildLookupActionOutput("read", {
    content: [{ type: "text", text: "first\nsecond" }],
  });
  assert.equal(output, "Current action output (read):\n\n    first\n    second");
});

test("lookup artifact mode defaults to failure-only and honors env overrides", () => {
  const previous = process.env.PI_RAINMAN_DEBUG_ARTIFACTS;
  try {
    delete process.env.PI_RAINMAN_DEBUG_ARTIFACTS;
    assert.equal(getLookupArtifactMode(), "failure");
    process.env.PI_RAINMAN_DEBUG_ARTIFACTS = "always";
    assert.equal(getLookupArtifactMode(), "always");
    process.env.PI_RAINMAN_DEBUG_ARTIFACTS = "off";
    assert.equal(getLookupArtifactMode(), "off");
    process.env.PI_RAINMAN_DEBUG_ARTIFACTS = "unexpected";
    assert.equal(getLookupArtifactMode(), "failure");
  } finally {
    if (previous === undefined) {
      delete process.env.PI_RAINMAN_DEBUG_ARTIFACTS;
    } else {
      process.env.PI_RAINMAN_DEBUG_ARTIFACTS = previous;
    }
  }
});

test("rainman tool integration discards failure-only artifacts on success", async (t) => {
  const kbRoot = createKb(t);
  const ui = createTestUi();
  const pi = createTestPi();
  const artifactWriter = createMockArtifactWriter("failure", {
    id: "artifact-1",
    path: path.join(kbRoot, "artifact-1.jsonl"),
  });
  createRainmanExtension({
    getKbRoot: () => kbRoot,
    createLookupArtifactWriter: async () => artifactWriter as any,
    executeLookupQuestion: async (question) => createLookupOutcome(question, kbRoot) as any,
    now: (() => {
      let value = 1;
      return () => value++;
    })(),
  })(pi as any);

  const ctx = createTestContext(ui);
  const updates: Array<any> = [];
  const tool = pi.tools.get("rainman_lookup");
  assert.ok(tool);

  const response = await tool.execute(
    "tool-call-1",
    { question: "Where is the workflow?" },
    undefined,
    (update: unknown) => updates.push(update),
    ctx,
  );

  assert.equal(artifactWriter.flushCalls, 1);
  assert.equal(artifactWriter.discardCalls, 1);
  assert.equal(response.details.artifact, undefined);
  assert.equal(response.details.artifactFormat, undefined);
  assert.equal(pi.entries.some((entry) => entry.customType === "rainman-lookup-run"), false);
  assert.ok(updates.some((update) => update.details?.phase === "artifact-created"));
  assert.ok(updates.some((update) => update.details?.phase === "artifact-discarded"));
});

test("rainman tool integration retains diagnostics and artifact on failure", async (t) => {
  const kbRoot = createKb(t);
  const ui = createTestUi();
  const pi = createTestPi();
  const artifactWriter = createMockArtifactWriter("failure", {
    id: "artifact-2",
    path: path.join(kbRoot, "artifact-2.jsonl"),
  });
  const diagnosticError = new Error("lookup exploded") as Error & Record<string, unknown>;
  diagnosticError.lookupMessages = [{ role: "assistant", content: [{ type: "text", text: "bad" }] }];
  diagnosticError.lookupToolAccess = {
    activeToolNames: ["read"],
    configuredToolNames: ["read", "submit_result"],
    systemPromptHasAvailableTools: true,
    systemPromptHasSubmitResult: true,
  };
  diagnosticError.lookupUsage = createLookupUsageSummary();

  createRainmanExtension({
    getKbRoot: () => kbRoot,
    createLookupArtifactWriter: async () => artifactWriter as any,
    executeLookupQuestion: async () => {
      throw diagnosticError;
    },
    now: (() => {
      let value = 10;
      return () => value++;
    })(),
  })(pi as any);

  const ctx = createTestContext(ui);
  const updates: Array<any> = [];
  const tool = pi.tools.get("rainman_lookup");
  assert.ok(tool);

  await assert.rejects(
    () => tool.execute("tool-call-2", { question: "Why failed?" }, undefined, (update: unknown) => updates.push(update), ctx),
    /lookup exploded/,
  );

  assert.equal(artifactWriter.discardCalls, 0);
  assert.ok(pi.entries.some((entry) => entry.customType === "rainman-lookup-run"));
  assert.ok(updates.some((update) => update.details?.phase === "artifact-finalized"));
  const runFinishedEntry = artifactWriter.appended.find((entry: any) => entry.entryType === "run-finished") as any;
  assert.ok(runFinishedEntry);
  assert.equal(runFinishedEntry.record.status, "error");
  assert.equal(runFinishedEntry.record.diagnostics?.usage?.totalTokens, 15);
  assert.deepEqual(runFinishedEntry.record.diagnostics?.toolAccess?.activeToolNames, ["read"]);
});

test("rainman tool integration preserves remaining activity when lookups overlap", async (t) => {
  const kbRoot = createKb(t);
  const ui = createTestUi();
  const pi = createTestPi();
  const first = createDeferred<void>();
  const second = createDeferred<void>();
  const waits = new Map<string, Deferred<void>>([
    ["first", first],
    ["second", second],
  ]);

  createRainmanExtension({
    getKbRoot: () => kbRoot,
    createLookupArtifactWriter: async () => createMockArtifactWriter("off") as any,
    executeLookupQuestion: async (question, _signal, _ctx, progress) => {
      progress?.update(`running ${question}`, { phase: "integration-test" }, { includeContent: false });
      await waits.get(question)!.promise;
      return createLookupOutcome(question, kbRoot) as any;
    },
    now: (() => {
      let value = 100;
      return () => value++;
    })(),
  })(pi as any);

  const ctx = createTestContext(ui);
  const tool = pi.tools.get("rainman_lookup");
  assert.ok(tool);

  const firstRun = tool.execute("call-first", { question: "first" }, undefined, undefined, ctx);
  await Promise.resolve();
  const secondRun = tool.execute("call-second", { question: "second" }, undefined, undefined, ctx);
  await Promise.resolve();

  assert.match(ui.currentWorkingMessage ?? "", /running second/);
  second.resolve();
  await secondRun;
  assert.match(ui.currentWorkingMessage ?? "", /running first/);
  first.resolve();
  await firstRun;
  assert.equal(ui.currentWorkingMessage, undefined);
});
