import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FACT_RELATIONS,
  STRUCTURED_FACT_SYNTAX_GUIDANCE,
  StructuredFactParseError,
  parseStructuredFactBulletText,
  parseStructuredFactFileContent,
  parseStructuredFactLine,
  renderStructuredFactBullet,
  renderStructuredFactLine,
} from "../src/factSchema.ts";

test("parseStructuredFactBulletText normalizes surrounding whitespace", () => {
  const parsed = parseStructuredFactBulletText(
    "  PREFERS  |  pi install .  | when = installing from source | scope = repo root  ",
  );

  assert.deepEqual(parsed, {
    relation: "PREFERS",
    object: "pi install .",
    qualifiers: [
      { key: "when", value: "installing from source" },
      { key: "scope", value: "repo root" },
    ],
  });
});

test("parseStructuredFactBulletText allows callers to extend the relation set", () => {
  const parsed = parseStructuredFactBulletText("ASSERTS | canonical format", {
    allowedRelations: [...DEFAULT_FACT_RELATIONS, "ASSERTS"],
  });

  assert.deepEqual(parsed, {
    relation: "ASSERTS",
    object: "canonical format",
    qualifiers: [],
  });
});

test("parseStructuredFactLine rejects bullets without a space after the dash", () => {
  assert.throws(
    () => parseStructuredFactLine("-PREFERS | pi install ."),
    (error) => error instanceof StructuredFactParseError && error.code === "INVALID_BULLET_FORMAT",
  );
});

test("parseStructuredFactFileContent returns heading identity and bullet metadata", () => {
  const parsed = parseStructuredFactFileContent(
    "# PI / WORKFLOW\n\n- PREFERS | pi install . | when=installing from source\n",
  );

  assert.equal(parsed.heading, "PI / WORKFLOW");
  assert.equal(parsed.subjectFromHeading, "PI");
  assert.equal(parsed.topicFromHeading, "WORKFLOW");
  assert.deepEqual(parsed.bullets, [
    {
      lineIndex: 2,
      lineNumber: 3,
      rawText: "- PREFERS | pi install . | when=installing from source",
      parsed: {
        relation: "PREFERS",
        object: "pi install .",
        qualifiers: [{ key: "when", value: "installing from source" }],
      },
    },
  ]);
});

test("renderStructuredFactBullet and renderStructuredFactLine produce canonical formatting", () => {
  const bullet = parseStructuredFactBulletText("PREFERS | pi install . | when = installing from source | scope = repo root");

  assert.equal(
    renderStructuredFactBullet(bullet),
    "PREFERS | pi install . | when=installing from source | scope=repo root",
  );
  assert.equal(
    renderStructuredFactLine(bullet),
    "- PREFERS | pi install . | when=installing from source | scope=repo root",
  );
});

test("STRUCTURED_FACT_SYNTAX_GUIDANCE mentions the canonical grammar and relation set", () => {
  assert.match(STRUCTURED_FACT_SYNTAX_GUIDANCE, /RELATION \| OBJECT \| key=value/);
  assert.match(STRUCTURED_FACT_SYNTAX_GUIDANCE, /PREFERS/);
});
