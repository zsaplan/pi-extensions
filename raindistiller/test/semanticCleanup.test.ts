import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  distillKnowledgeFiles,
  type DuplicateGroup,
} from "../src/distill.ts";
import {
  extractRaincatcherFilesWritten,
  getConfiguredSemanticCleanupMode,
  isSemanticCleanupEnabled,
  parseDistillArgs,
  parseDuplicateGroupDecision,
  resolveDuplicateGroupDecision,
  tokenizeArgs,
} from "../src/index.ts";
import {
  parseSemanticCleanupProposal,
  resolveSemanticCleanupForFiles,
} from "../src/semanticCleanup.ts";

function makeKbRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeKbFile(kbRoot: string, filePath: string, content: string): void {
  const absolutePath = path.join(kbRoot, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

function makeDuplicateGroup(): DuplicateGroup {
  return {
    id: "group-1",
    kind: "exact",
    representativeFact: "- USES | deterministic duplicate fixture",
    occurrences: [
      {
        id: "occ-1",
        filePath: "CANONICAL__TARGET.md",
        heading: "CANONICAL / TARGET",
        selected: false,
        lineIndex: 2,
        lineNumber: 3,
        text: "- USES | deterministic duplicate fixture",
        normalized: "uses deterministic duplicate fixture",
        headingNormalized: "canonical target",
        tokens: ["uses", "deterministic", "duplicate", "fixture"],
        tokenSet: ["uses", "deterministic", "duplicate", "fixture"],
        trigrams: ["det", "dup", "fix"],
      },
      {
        id: "occ-2",
        filePath: "DUP__TARGET.md",
        heading: "DUP / TARGET",
        selected: true,
        lineIndex: 2,
        lineNumber: 3,
        text: "- USES | deterministic duplicate fixture",
        normalized: "uses deterministic duplicate fixture",
        headingNormalized: "dup target",
        tokens: ["uses", "deterministic", "duplicate", "fixture"],
        tokenSet: ["uses", "deterministic", "duplicate", "fixture"],
        trigrams: ["det", "dup", "fix"],
      },
    ],
    strongestPairs: [{
      leftId: "occ-1",
      rightId: "occ-2",
      similarity: {
        exactNormalized: true,
        sharedTokenCount: 4,
        tokenJaccard: 1,
        trigramJaccard: 1,
        levenshteinSimilarity: 1,
        headingJaccard: 0.5,
        composite: 1,
      },
    }],
    maxComposite: 1,
  };
}

test("tokenizeArgs preserves quoted paths and parseDistillArgs classifies command targets", () => {
  assert.deepEqual(tokenizeArgs("--file \"Subject Notes.md\" --dir 'team docs' loose.md workspace"), [
    "--file",
    "Subject Notes.md",
    "--dir",
    "team docs",
    "loose.md",
    "workspace",
  ]);

  assert.deepEqual(parseDistillArgs("--file \"Subject Notes.md\" --dir 'team docs' --no-recursive --semantic-cleanup loose.md workspace"), {
    files: ["Subject Notes.md", "loose.md"],
    directories: ["team docs", "workspace"],
    recursive: false,
    semanticCleanupOverride: true,
    warnings: [],
  });

  assert.deepEqual(parseDistillArgs(""), {
    files: [],
    directories: ["."],
    recursive: true,
    semanticCleanupOverride: null,
    warnings: [],
  });

  assert.deepEqual(parseDistillArgs("--file --dir").warnings, ["Missing path after --file", "Missing path after --dir"]);
});

test("semantic cleanup mode environment and overrides gate automatic cleanup conservatively", (t) => {
  const originalMode = process.env.RAINDISTILLER_SEMANTIC_CLEANUP_MODE;
  t.after(() => {
    if (originalMode === undefined) delete process.env.RAINDISTILLER_SEMANTIC_CLEANUP_MODE;
    else process.env.RAINDISTILLER_SEMANTIC_CLEANUP_MODE = originalMode;
  });

  process.env.RAINDISTILLER_SEMANTIC_CLEANUP_MODE = "off";
  assert.deepEqual(getConfiguredSemanticCleanupMode(), { mode: "off" });
  assert.equal(isSemanticCleanupEnabled("off", "manual", null), false);
  assert.equal(isSemanticCleanupEnabled("off", "auto", true), true);

  process.env.RAINDISTILLER_SEMANTIC_CLEANUP_MODE = "manual_only";
  assert.deepEqual(getConfiguredSemanticCleanupMode(), { mode: "manual_only" });
  assert.equal(isSemanticCleanupEnabled("manual_only", "manual", null), true);
  assert.equal(isSemanticCleanupEnabled("manual_only", "auto", null), false);
  assert.equal(isSemanticCleanupEnabled("manual_only", "manual", false), false);

  process.env.RAINDISTILLER_SEMANTIC_CLEANUP_MODE = "all";
  assert.deepEqual(getConfiguredSemanticCleanupMode(), { mode: "all" });
  assert.equal(isSemanticCleanupEnabled("all", "auto", null), true);

  process.env.RAINDISTILLER_SEMANTIC_CLEANUP_MODE = "surprise";
  const configured = getConfiguredSemanticCleanupMode();
  assert.equal(configured.mode, "manual_only");
  assert.match(configured.warning ?? "", /Invalid RAINDISTILLER_SEMANTIC_CLEANUP_MODE/);
});

test("extractRaincatcherFilesWritten ignores empty and malformed event payloads", () => {
  assert.deepEqual(extractRaincatcherFilesWritten(undefined), []);
  assert.deepEqual(extractRaincatcherFilesWritten({}), []);
  assert.deepEqual(extractRaincatcherFilesWritten({ filesWritten: [] }), []);
  assert.deepEqual(extractRaincatcherFilesWritten({ filesWritten: ["A.md", 42, null, "B.md"] }), ["A.md", "B.md"]);
});

test("parseDuplicateGroupDecision accepts JSON decisions and rejects malformed responses", () => {
  assert.deepEqual(parseDuplicateGroupDecision("```json\n{\"action\":\"keep_all\",\"reason\":\"different scope\"}\n```"), {
    action: "keep_all",
    reason: "different scope",
  });

  assert.deepEqual(parseDuplicateGroupDecision("preface {\"action\":\"dedupe\",\"keepOccurrenceId\":\"occ-1\"} trailing"), {
    action: "dedupe",
    keepOccurrenceId: "occ-1",
  });

  assert.throws(() => parseDuplicateGroupDecision("not json"), SyntaxError);
  assert.throws(() => parseDuplicateGroupDecision("{\"action\":\"merge\"}"), /invalid action/);
  assert.throws(() => parseDuplicateGroupDecision("{\"action\":\"dedupe\"}"), /without keepOccurrenceId/);
  assert.throws(() => parseDuplicateGroupDecision("{\"action\":\"keep_all\",\"reason\":5}"), /non-string reason/);
});

test("resolveDuplicateGroupDecision repairs truncated adjudication responses", async () => {
  const calls: string[] = [];
  const decision = await resolveDuplicateGroupDecision(
    makeDuplicateGroup(),
    async (request) => {
      calls.push(request.kind);
      if (request.kind === "adjudicate") {
        return '{"action":"dedupe","keepOccurrenceId":"occ-1"';
      }

      assert.match(request.parseError, /JSON|property value|Unexpected end/i);
      assert.match(request.invalidResponse, /keepOccurrenceId/);
      return '{"action":"dedupe","keepOccurrenceId":"occ-1","reason":"same fact"}';
    },
  );

  assert.deepEqual(decision, {
    action: "dedupe",
    keepOccurrenceId: "occ-1",
    reason: "same fact",
  });
  assert.deepEqual(calls, ["adjudicate", "repair"]);
});

test("resolveDuplicateGroupDecision retries adjudication after a failed repair attempt", async () => {
  let step = 0;
  const calls: string[] = [];
  const decision = await resolveDuplicateGroupDecision(
    makeDuplicateGroup(),
    async (request) => {
      calls.push(request.kind);
      step += 1;

      if (step === 1) return '{"action":"keep_all"';
      if (step === 2) return "still not json";
      if (step === 3) return '{"action":"keep_all","reason":"different scope"}';

      throw new Error(`Unexpected request at step ${step}: ${request.kind}`);
    },
  );

  assert.deepEqual(decision, {
    action: "keep_all",
    reason: "different scope",
  });
  assert.deepEqual(calls, ["adjudicate", "repair", "adjudicate"]);
});

test("parseSemanticCleanupProposal accepts fenced JSON responses", () => {
  const proposal = parseSemanticCleanupProposal([
    "```json",
    JSON.stringify({
      file: "BRITEAUTH__ARCHITECTURE.md",
      actions: [{
        lineNumber: 3,
        action: "skip",
        reason: "not confident",
      }],
    }),
    "```",
  ].join("\n"));

  assert.deepEqual(proposal, {
    file: "BRITEAUTH__ARCHITECTURE.md",
    actions: [{
      lineNumber: 3,
      action: "skip",
      reason: "not confident",
    }],
  });
});

test("resolveSemanticCleanupForFiles accepts validated relation rewrites and records backups", async (t) => {
  const kbRoot = makeKbRoot("raindistiller-semantic-accept-");
  t.after(() => fs.rmSync(kbRoot, { recursive: true, force: true }));

  const filePath = "BRITEAUTH__ARCHITECTURE.md";
  const originalContent = [
    "# BRITEAUTH / ARCHITECTURE",
    "",
    "- DEFINES | BriteAuth uses Amazon Cognito for sign-up and sign-in",
    "",
  ].join("\n");
  writeKbFile(kbRoot, filePath, originalContent);

  const result = await resolveSemanticCleanupForFiles({
    kbRoot,
    files: [filePath],
    proposeSemanticCleanup: async () => ({
      file: filePath,
      actions: [{
        lineNumber: 3,
        action: "rewrite",
        replacement: "- USES | Amazon Cognito for sign-up and sign-in",
        reason: "Uses is the more specific relation.",
      }],
    }),
  });

  assert.deepEqual(result.filesReviewed, [filePath]);
  assert.deepEqual(result.modifiedFiles, [filePath]);
  assert.equal(result.issuesFound.length, 1);
  assert.equal(result.issuesResolved.length, 1);
  assert.equal(result.issuesSkipped.length, 0);
  assert.ok(result.backupRoot);

  const fileResult = result.fileResults[0]!;
  assert.equal(fileResult.modified, true);
  assert.equal(fileResult.acceptedActions.length, 1);
  assert.equal(fileResult.acceptedActions[0]?.outcome, "accepted");
  assert.equal(fileResult.acceptedActions[0]?.appliedReplacement, "- USES | Amazon Cognito for sign-up and sign-in");
  assert.ok(fileResult.backupPath);
  assert.equal(fs.readFileSync(path.join(kbRoot, filePath), "utf8"), [
    "# BRITEAUTH / ARCHITECTURE",
    "",
    "- USES | Amazon Cognito for sign-up and sign-in",
    "",
  ].join("\n"));
  assert.equal(fs.readFileSync(fileResult.backupPath!, "utf8"), originalContent);
});

test("resolveSemanticCleanupForFiles reports skipped actions without creating backups", async (t) => {
  const kbRoot = makeKbRoot("raindistiller-semantic-skip-");
  t.after(() => fs.rmSync(kbRoot, { recursive: true, force: true }));

  const filePath = "BRITEAUTH__ARCHITECTURE.md";
  const originalContent = [
    "# BRITEAUTH / ARCHITECTURE",
    "",
    "- DEFINES | BriteAuth uses Amazon Cognito for sign-up and sign-in",
    "",
  ].join("\n");
  writeKbFile(kbRoot, filePath, originalContent);

  const result = await resolveSemanticCleanupForFiles({
    kbRoot,
    files: [filePath],
    proposeSemanticCleanup: async () => ({
      file: filePath,
      actions: [{
        lineNumber: 3,
        action: "skip",
        reason: "Need human confirmation before changing wording.",
      }],
    }),
  });

  assert.deepEqual(result.modifiedFiles, []);
  assert.equal(result.issuesFound.length, 1);
  assert.equal(result.issuesResolved.length, 0);
  assert.equal(result.issuesSkipped.length, 1);
  assert.equal(result.backupRoot, undefined);
  assert.equal(result.actionAudit.length, 1);
  assert.equal(result.actionAudit[0]?.outcome, "skipped");
  assert.equal(result.actionAudit[0]?.reason, "Need human confirmation before changing wording.");
  assert.equal(result.fileResults[0]?.backupPath, undefined);
  assert.equal(fs.readFileSync(path.join(kbRoot, filePath), "utf8"), originalContent);
});

test("resolveSemanticCleanupForFiles rejects rewrites that do not reduce semantic warnings", async (t) => {
  const kbRoot = makeKbRoot("raindistiller-semantic-reject-");
  t.after(() => fs.rmSync(kbRoot, { recursive: true, force: true }));

  const filePath = "RAIN_CORE__GRAMMAR.md";
  const originalContent = [
    "# RAIN_CORE / GRAMMAR",
    "",
    "- DEFINES | The minimal structured bullet grammar is RELATION / OBJECT / key=value / key=value",
    "",
  ].join("\n");
  writeKbFile(kbRoot, filePath, originalContent);

  const result = await resolveSemanticCleanupForFiles({
    kbRoot,
    files: [filePath],
    proposeSemanticCleanup: async () => ({
      file: filePath,
      actions: [{
        lineNumber: 3,
        action: "rewrite",
        replacement: "- DEFINES | RELATION / OBJECT / key=value / key=value",
        reason: "Still defining the grammar.",
      }],
    }),
  });

  assert.deepEqual(result.modifiedFiles, []);
  assert.equal(result.issuesFound.length, 1);
  assert.equal(result.issuesResolved.length, 0);
  assert.equal(result.issuesSkipped.length, 1);
  assert.equal(result.fileResults[0]?.modified, false);
  assert.equal(result.fileResults[0]?.skippedActions[0]?.outcome, "rejected");
  assert.match(result.warnings[0] ?? "", /did not reduce semantic warnings/i);
  assert.equal(fs.readFileSync(path.join(kbRoot, filePath), "utf8"), originalContent);
});

test("distillKnowledgeFiles ignores invalid dedupe decisions without modifying files", async (t) => {
  const kbRoot = makeKbRoot("raindistiller-invalid-dedupe-");
  t.after(() => fs.rmSync(kbRoot, { recursive: true, force: true }));

  const canonicalContent = [
    "# CANONICAL / TARGET",
    "",
    "- USES | deterministic duplicate fixture",
    "",
  ].join("\n");
  const duplicateContent = [
    "# DUP / TARGET",
    "",
    "- USES | deterministic duplicate fixture",
    "",
  ].join("\n");
  writeKbFile(kbRoot, "CANONICAL__TARGET.md", canonicalContent);
  writeKbFile(kbRoot, "DUP__TARGET.md", duplicateContent);

  const result = await distillKnowledgeFiles(
    {
      kbRoot,
      files: ["DUP__TARGET.md"],
    },
    {
      adjudicateGroup: async () => ({
        action: "dedupe",
        keepOccurrenceId: "missing-occurrence-id",
        reason: "Malformed model response fixture.",
      }),
    },
  );

  assert.equal(result.duplicatesRemoved, 0);
  assert.deepEqual(result.modifiedFiles, []);
  assert.match(result.warnings.join("\n"), /Ignored invalid dedupe decision/);
  assert.equal(fs.readFileSync(path.join(kbRoot, "DUP__TARGET.md"), "utf8"), duplicateContent);
});

test("distillKnowledgeFiles re-runs dedupe after semantic cleanup rewrites", async (t) => {
  const kbRoot = makeKbRoot("raindistiller-distill-semantic-");
  t.after(() => fs.rmSync(kbRoot, { recursive: true, force: true }));

  writeKbFile(
    kbRoot,
    "AUTH__CANONICAL.md",
    [
      "# AUTH / CANONICAL",
      "",
      "- USES | Amazon Cognito for sign-up and sign-in",
      "",
    ].join("\n"),
  );
  writeKbFile(
    kbRoot,
    "BRITEAUTH__ARCHITECTURE.md",
    [
      "# BRITEAUTH / ARCHITECTURE",
      "",
      "- DEFINES | BriteAuth uses Amazon Cognito for sign-up and sign-in",
      "",
    ].join("\n"),
  );

  const result = await distillKnowledgeFiles(
    {
      kbRoot,
      files: ["BRITEAUTH__ARCHITECTURE.md"],
    },
    {
      adjudicateGroup: async (group) => {
        if (group.kind === "near") {
          return {
            action: "keep_all",
            reason: "Wait for semantic cleanup to canonicalize first.",
          };
        }

        return null;
      },
      proposeSemanticCleanup: async (request) => ({
        file: request.file,
        actions: [{
          lineNumber: 3,
          action: "rewrite",
          replacement: "- USES | Amazon Cognito for sign-up and sign-in",
          reason: "Canonical USES relation.",
        }],
      }),
    },
  );

  assert.equal(result.semanticIssuesResolved, 1);
  assert.deepEqual(result.semanticFilesModified, ["BRITEAUTH__ARCHITECTURE.md"]);
  assert.equal(result.duplicatePasses.length, 2);
  assert.deepEqual(result.duplicatePasses.map((pass) => pass.pass), ["initial", "post_semantic_cleanup"]);
  assert.equal(result.duplicatePasses[0]?.duplicatesRemoved, 0);
  assert.equal(result.duplicatePasses[1]?.duplicatesRemoved, 1);
  assert.deepEqual(result.deletedFiles, ["BRITEAUTH__ARCHITECTURE.md"]);
  assert.ok(result.removedFactGroups.some((group) => group.pass === "post_semantic_cleanup"));
  assert.equal(fs.existsSync(path.join(kbRoot, "BRITEAUTH__ARCHITECTURE.md")), false);
});
