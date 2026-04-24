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
