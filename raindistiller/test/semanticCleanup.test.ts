import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { distillKnowledgeFiles } from "../src/distill.ts";
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
