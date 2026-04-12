import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { lintFactFileContent, lintKnowledgeBase } from "../src/lint.ts";

test("lintFactFileContent accepts a valid structured fact file", () => {
  const result = lintFactFileContent(
    "PI__WORKFLOW.md",
    "# PI / WORKFLOW\n\n- PREFERS | pi install . | when=installing from source | scope=repo root\n",
  );

  assert.deepEqual(result.issues, []);
});

test("lintFactFileContent rejects a legacy freeform bullet", () => {
  const result = lintFactFileContent(
    "PI__WORKFLOW.md",
    "# PI / WORKFLOW\n\n- pi install . when installing from source\n",
  );

  assert.deepEqual(
    result.issues.map((issue) => ({ code: issue.code, line: issue.line })),
    [{ code: "INVALID_BULLET_FORMAT", line: 3 }],
  );
});

test("lintFactFileContent remains structural-only when semantic lint is not called", () => {
  const result = lintFactFileContent(
    "PI__WORKFLOW.md",
    "# PI / WORKFLOW\n\n- prefers | pi install .\n",
  );

  assert.deepEqual(result, {
    file: "PI__WORKFLOW.md",
    issues: [
      {
        code: "INVALID_RELATION",
        severity: "error",
        file: "PI__WORKFLOW.md",
        line: 3,
        message: "Relation must match ^[A-Z][A-Z0-9_]*$.",
      },
    ],
  });
  assert.equal("analysisStatus" in result, false);
  assert.equal("details" in result.issues[0], false);
});

test("lintFactFileContent reports filename heading mismatch", () => {
  const result = lintFactFileContent(
    "PI__WORKFLOW.md",
    "# PI / SETUP\n\n- PREFERS | pi install .\n",
  );

  assert.deepEqual(
    result.issues.map((issue) => ({ code: issue.code, line: issue.line })),
    [{ code: "HEADING_FILENAME_MISMATCH", line: 1 }],
  );
});

test("lintFactFileContent reports invalid heading format and unexpected prose", () => {
  const result = lintFactFileContent(
    "PI__WORKFLOW.md",
    "# Pi / WORKFLOW\n\nThis file contains prose.\n",
  );

  assert.deepEqual(
    result.issues.map((issue) => ({ code: issue.code, line: issue.line })),
    [
      { code: "INVALID_HEADING_FORMAT", line: 1 },
      { code: "UNEXPECTED_CONTENT", line: 3 },
    ],
  );
});

test("lintFactFileContent reports deterministic bullet-level syntax issues", () => {
  const result = lintFactFileContent(
    "PI__WORKFLOW.md",
    [
      "# PI / WORKFLOW",
      "",
      "- prefers | pi install .",
      "- PREFERS | pi install . | Scope=repo root",
      "- USES | ",
      "- PREFERS | pi install . | when=first | when=second",
      "- CUSTOM | canonical extension",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    result.issues.map((issue) => ({ code: issue.code, line: issue.line })),
    [
      { code: "INVALID_RELATION", line: 3 },
      { code: "INVALID_QUALIFIER", line: 4 },
      { code: "MISSING_OBJECT", line: 5 },
      { code: "DUPLICATE_QUALIFIER_KEY", line: 6 },
      { code: "UNKNOWN_RELATION", line: 7 },
    ],
  );
});

test("lintKnowledgeBase lints selected files and preserves file-selection warnings", (t) => {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rain-core-lint-"));
  t.after(() => fs.rmSync(kbRoot, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(kbRoot, "PI__WORKFLOW.md"),
    "# PI / WORKFLOW\n\n- prefers | pi install .\n",
  );
  fs.writeFileSync(
    path.join(kbRoot, "bad.md"),
    "# PI / WORKFLOW\n\n- PREFERS | pi install .\n",
  );

  const result = lintKnowledgeBase(kbRoot, {
    files: ["PI__WORKFLOW.md", "bad.md", "missing.md"],
  });

  assert.deepEqual(result.files, ["PI__WORKFLOW.md", "bad.md"]);
  assert.deepEqual(result.warnings, ["Skipped missing file: missing.md"]);
  assert.deepEqual(
    result.issues.map((issue) => ({ file: issue.file, code: issue.code, line: issue.line })),
    [
      { file: "bad.md", code: "INVALID_FILENAME", line: undefined },
      { file: "PI__WORKFLOW.md", code: "INVALID_RELATION", line: 3 },
    ],
  );
});
