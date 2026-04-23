import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { KB_ROOT_ENV_VAR } from "@zsaplan/rain-core";
import {
  appendFactsToDisk,
  buildExtractionPrompt,
  buildFilesWrittenEvent,
  buildHarvestPrompt,
  extractMessageText,
  extractTextParts,
  looksSecretish,
  parseFacts,
  redactSecrets,
  shouldKeepStructuredFact,
  snippet,
} from "../src/index.ts";

function withKbRoot(t: TestContext, kbRoot: string): void {
  const previous = process.env[KB_ROOT_ENV_VAR];
  process.env[KB_ROOT_ENV_VAR] = kbRoot;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[KB_ROOT_ENV_VAR];
    } else {
      process.env[KB_ROOT_ENV_VAR] = previous;
    }
  });
}

test("redactSecrets removes obvious provider tokens and key assignments", () => {
  const input = [
    "openai=sk-abcdefghijklmnopqrstuvwxyz",
    "github=ghp_abcdefghijklmnopqrstuvwxyz",
    "aws=AKIA1234567890ABCDEF",
    "GOOGLE_API_KEY: AIzaabcdefghijklmnopqrstuvwxyz",
    "MY_PASSWORD=hunter2",
  ].join("\n");

  const redacted = redactSecrets(input);

  assert(!redacted.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert(!redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert(!redacted.includes("AKIA1234567890ABCDEF"));
  assert(!redacted.includes("AIzaabcdefghijklmnopqrstuvwxyz"));
  assert(!redacted.includes("hunter2"));
  assert.match(redacted, /MY_PASSWORD=\[REDACTED\]/);
});

test("secret-ish candidate facts are rejected before persistence", () => {
  assert.equal(looksSecretish("TOKEN=abc123"), true);
  assert.equal(shouldKeepStructuredFact("PREFERS | safe docs | scope=repo"), true);
  assert.equal(shouldKeepStructuredFact("PREFERS | TOKEN=abc123 | scope=repo"), false);

  const facts = parseFacts(JSON.stringify([
    {
      subject: "PI",
      topic: "SECRETS",
      bullet: "PREFERS | use token=abc123 | scope=tests",
    },
  ]));

  assert.deepEqual(facts, []);
});

test("message text extraction keeps text parts only and redacts direct content", () => {
  assert.equal(
    extractTextParts([
      { type: "text", text: "first" },
      { type: "image", text: "not text" },
      { type: "text", text: "second" },
    ]),
    "first\nsecond",
  );

  assert.equal(
    extractMessageText({ content: "MY_SECRET=value should not survive" }),
    "MY_SECRET=[REDACTED] should not survive",
  );
});

test("prompt construction redacts and truncates captured messages and tools", () => {
  const longResult = `prefix ${"x".repeat(2000)} sk-abcdefghijklmnopqrstuvwxyz suffix`;
  const prompt = buildExtractionPrompt(
    [{ role: "user", content: "Use API_KEY=abc123 but do not store it" }],
    [{ toolName: "bash", args: { command: "echo ghp_abcdefghijklmnopqrstuvwxyz" }, result: longResult, isError: false }],
  );

  assert(!prompt.includes("API_KEY=abc123"));
  assert(!prompt.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert(!prompt.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert(prompt.includes("[REDACTED]"));
  assert(prompt.length < longResult.length);
  assert(prompt.includes("…"));

  const compact = snippet({ output: longResult }, 120);
  assert(compact.length <= 120);
  assert(!compact.includes("sk-abcdefghijklmnopqrstuvwxyz"));
});

test("parseFacts accepts fenced JSON, split topic identity, canonicalization, and dedupes", () => {
  const facts = parseFacts(`\`\`\`json
[
  {"topic":"pi--workflow","bullet":"PREFERS | pi install . | when=installing from source | scope=repo root"},
  {"topic":"BRITE_CORE__deployment","bullet":"REQUIRES | root verify | when=before release"},
  {"topic":"BRITE_CORE__deployment","fact":"REQUIRES | root verify | when=before release"},
  {"subject":"bad","topic":"grammar","bullet":"WRONG | not allowed | scope=test"}
]
\`\`\``);

  assert.equal(facts.length, 2);
  assert.equal(facts[0]?.subject, "GENERAL");
  assert.equal(facts[0]?.topic, "PI_WORKFLOW");
  assert.equal(facts[0]?.bullet.relation, "PREFERS");
  assert.equal(facts[1]?.subject, "BRITE_CORE");
  assert.equal(facts[1]?.topic, "DEPLOYMENT");
});

test("appendFactsToDisk writes package-owned KB files and skips duplicates", async (t) => {
  const kbRoot = await mkdtemp(join(tmpdir(), "raincatcher-test-"));
  withKbRoot(t, kbRoot);
  t.after(async () => {
    await rm(kbRoot, { recursive: true, force: true });
  });

  const facts = parseFacts(JSON.stringify([
    {
      subject: "pi",
      topic: "workflow",
      bullet: "PREFERS | pi install . | when=installing from source | scope=repo root",
    },
  ]));

  const first = await appendFactsToDisk(facts);
  assert.equal(first.factsWritten, 1);
  assert.equal(first.filesWritten.length, 1);
  assert.equal(first.filesWritten[0], join(kbRoot, "PI__WORKFLOW.md"));

  const content = await readFile(join(kbRoot, "PI__WORKFLOW.md"), "utf8");
  assert.equal(
    content,
    "# PI / WORKFLOW\n\n- PREFERS | pi install . | when=installing from source | scope=repo root\n",
  );

  const second = await appendFactsToDisk(facts);
  assert.deepEqual(second, { filesWritten: [], factsWritten: 0 });
});

test("appendFactsToDisk refuses to append to malformed existing fact files", async (t) => {
  const kbRoot = await mkdtemp(join(tmpdir(), "raincatcher-test-"));
  withKbRoot(t, kbRoot);
  t.after(async () => {
    await rm(kbRoot, { recursive: true, force: true });
  });

  await appendFactsToDisk(parseFacts(JSON.stringify([
    {
      subject: "PI",
      topic: "WORKFLOW",
      bullet: "PREFERS | first fact | scope=repo",
    },
  ])));

  const target = join(kbRoot, "PI__WORKFLOW.md");
  await rm(target, { force: true });
  await writeFile(target, "# PI / WORKFLOW\n\n- legacy freeform prose\n", "utf8");

  const result = await appendFactsToDisk(parseFacts(JSON.stringify([
    {
      subject: "PI",
      topic: "WORKFLOW",
      bullet: "PREFERS | second fact | scope=repo",
    },
  ])));

  assert.deepEqual(result, { filesWritten: [], factsWritten: 0 });
  assert.equal(await readFile(target, "utf8"), "# PI / WORKFLOW\n\n- legacy freeform prose\n");
});

test("files-written event payload shape remains compatible with raindistiller", () => {
  const payload = buildFilesWrittenEvent(
    { filesWritten: ["/kb/PI__WORKFLOW.md"], factsWritten: 2 },
    "/kb",
  );

  assert.deepEqual(payload, {
    kbRoot: "/kb",
    filesWritten: ["/kb/PI__WORKFLOW.md"],
    factsWritten: 2,
  });
});

test("harvest prompt redacts and bounds branch entries", () => {
  const prompt = buildHarvestPrompt([
    { type: "message", message: { role: "bashExecution", command: "echo MY_TOKEN=abc123", output: "done sk-abcdefghijklmnopqrstuvwxyz" } },
    { type: "compaction", summary: "summary PASSWORD=secret" },
    { type: "branch_summary", summary: "branch ghp_abcdefghijklmnopqrstuvwxyz" },
  ]);

  assert(!prompt.includes("MY_TOKEN=abc123"));
  assert(!prompt.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert(!prompt.includes("PASSWORD=secret"));
  assert(!prompt.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert(prompt.length <= 24_000);
});
