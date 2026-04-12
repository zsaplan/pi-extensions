import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  lintFactFileSemanticCleanup,
  lintKnowledgeBaseSemanticCleanup,
} from "../src/semanticLint.ts";

test("lintFactFileSemanticCleanup marks structurally valid files as analyzed", () => {
  const result = lintFactFileSemanticCleanup(
    "PI__WORKFLOW.md",
    "# PI / WORKFLOW\n\n- PREFERS | pi install .\n",
  );

  assert.equal(result.analysisStatus, "analyzed");
  assert.deepEqual(result.issues, []);
});

test("lintFactFileSemanticCleanup skips structurally invalid files", () => {
  const result = lintFactFileSemanticCleanup(
    "PI__WORKFLOW.md",
    "# PI / WORKFLOW\n\n- prefers | pi install .\n",
  );

  assert.equal(result.analysisStatus, "skipped-structurally-invalid");
  assert.deepEqual(result.issues, []);
});

test("lintFactFileSemanticCleanup flags USES refinement candidates", () => {
  const result = lintFactFileSemanticCleanup(
    "BRITEAUTH__ARCHITECTURE.md",
    [
      "# BRITEAUTH / ARCHITECTURE",
      "",
      "- DEFINES | BriteAuth uses Amazon Cognito for sign-up and sign-in",
      "",
    ].join("\n"),
  );

  assert.equal(result.analysisStatus, "analyzed");
  assert.deepEqual(result.issues, [
    {
      code: "RELATION_REFINEMENT_CANDIDATE",
      severity: "warning",
      file: "BRITEAUTH__ARCHITECTURE.md",
      line: 3,
      message: "Relation 'DEFINES' looks too generic; consider 'USES'.",
      details: {
        suggestedRelation: "USES",
        matchedPattern: "USES_VERB",
      },
    },
  ]);
});

test("lintFactFileSemanticCleanup flags REQUIRES refinement candidates", () => {
  const result = lintFactFileSemanticCleanup(
    "BRITEAUTH__DEPENDENCIES.md",
    [
      "# BRITEAUTH / DEPENDENCIES",
      "",
      "- DEFINES | BriteAuth requires each user to have a mapped identity",
      "",
    ].join("\n"),
  );

  assert.deepEqual(result.issues, [
    {
      code: "RELATION_REFINEMENT_CANDIDATE",
      severity: "warning",
      file: "BRITEAUTH__DEPENDENCIES.md",
      line: 3,
      message: "Relation 'DEFINES' looks too generic; consider 'REQUIRES'.",
      details: {
        suggestedRelation: "REQUIRES",
        matchedPattern: "REQUIRES_VERB",
      },
    },
  ]);
});

test("lintFactFileSemanticCleanup flags LOCATED_AT refinement candidates", () => {
  const result = lintFactFileSemanticCleanup(
    "RAINMAN__SOURCE_LOCATION.md",
    [
      "# RAINMAN / SOURCE_LOCATION",
      "",
      "- DEFINES | Rainman source code is located at /Users/zach/zsaplan/pi-extensions/rainman",
      "",
    ].join("\n"),
  );

  assert.deepEqual(result.issues, [
    {
      code: "RELATION_REFINEMENT_CANDIDATE",
      severity: "warning",
      file: "RAINMAN__SOURCE_LOCATION.md",
      line: 3,
      message: "Relation 'DEFINES' looks too generic; consider 'LOCATED_AT'.",
      details: {
        suggestedRelation: "LOCATED_AT",
        matchedPattern: "LOCATED_AT_PHRASE",
      },
    },
  ]);
});

test("lintFactFileSemanticCleanup flags grammar literal artifacts", () => {
  const result = lintFactFileSemanticCleanup(
    "RAIN_CORE__GRAMMAR.md",
    [
      "# RAIN_CORE / GRAMMAR",
      "",
      "- DEFINES | The minimal structured bullet grammar is RELATION / OBJECT / key=value / key=value with uppercase relations",
      "",
    ].join("\n"),
  );

  assert.deepEqual(result.issues, [
    {
      code: "GRAMMAR_LITERAL_ARTIFACT",
      severity: "warning",
      file: "RAIN_CORE__GRAMMAR.md",
      line: 3,
      message: "Object looks like a migrated grammar literal; consider rewriting with an explicit format/object split.",
      details: {
        matchedPattern: "RELATION_SLASH_OBJECT",
      },
    },
  ]);
});

test("lintFactFileSemanticCleanup suppresses ambiguous multi-family refinement matches", () => {
  const result = lintFactFileSemanticCleanup(
    "RAIN_CORE__DESIGN_DECISION.md",
    [
      "# RAIN_CORE / DESIGN_DECISION",
      "",
      "- DEFINES | Explicit polarity should be omitted initially and represented through relations such as REQUIRES and USES",
      "",
    ].join("\n"),
  );

  assert.equal(result.analysisStatus, "analyzed");
  assert.deepEqual(result.issues, []);
});

test("lintKnowledgeBaseSemanticCleanup aggregates analyzed files and warns on skipped invalid files", (t) => {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rain-core-semantic-lint-"));
  t.after(() => fs.rmSync(kbRoot, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(kbRoot, "ZETA__ONE.md"),
    "# ZETA / ONE\n\n- DEFINES | Zeta uses shared helpers for linting\n",
  );
  fs.writeFileSync(
    path.join(kbRoot, "ALPHA__ONE.md"),
    "# ALPHA / ONE\n\n- DEFINES | The grammar is RELATION / OBJECT / key=value / key=value\n",
  );
  fs.writeFileSync(
    path.join(kbRoot, "BROKEN__ONE.md"),
    "# BROKEN / ONE\n\n- defines | broken bullet\n",
  );

  const result = lintKnowledgeBaseSemanticCleanup(kbRoot, {
    files: ["ZETA__ONE.md", "ALPHA__ONE.md", "BROKEN__ONE.md", "missing.md"],
  });

  assert.deepEqual(result.files, ["ALPHA__ONE.md", "BROKEN__ONE.md", "ZETA__ONE.md"]);
  assert.deepEqual(
    result.issues.map((issue) => ({ file: issue.file, code: issue.code, line: issue.line })),
    [
      { file: "ALPHA__ONE.md", code: "GRAMMAR_LITERAL_ARTIFACT", line: 3 },
      { file: "ZETA__ONE.md", code: "RELATION_REFINEMENT_CANDIDATE", line: 3 },
    ],
  );
  assert.deepEqual(result.warnings, [
    "Skipped missing file: missing.md",
    "Skipped structurally invalid file during semantic cleanup: BROKEN__ONE.md",
  ]);
});
