import fs from "node:fs";
import { parseStructuredFactFileContent } from "./factSchema.ts";
import { normalizeWhitespace } from "./facts.ts";
import {
  lintFactFileContent,
  sortFactLintIssues,
  type FactFileLintResult,
  type FactLintIssue,
  type KnowledgeBaseLintResult,
} from "./lint.ts";
import {
  listMarkdownFiles,
  resolveMarkdownFiles,
  type ResolveMarkdownFilesInput,
} from "./markdown.ts";
import { ensureWithinRoot } from "./paths.ts";

const SEMANTIC_WARNING_CODES = Object.freeze({
  RELATION_REFINEMENT_CANDIDATE: "RELATION_REFINEMENT_CANDIDATE",
  GRAMMAR_LITERAL_ARTIFACT: "GRAMMAR_LITERAL_ARTIFACT",
});

const GRAMMAR_LITERAL_ARTIFACT_PATTERNS = Object.freeze([
  {
    name: "RELATION_SLASH_OBJECT",
    regex: /\bRELATION\s*\/\s*OBJECT\b/i,
  },
  {
    name: "KEY_VALUE_SLASH_KEY_VALUE",
    regex: /\bkey=value\s*\/\s*key=value\b/i,
  },
]);

const RELATION_REFINEMENT_FAMILIES = Object.freeze([
  {
    suggestedRelation: "USES",
    patterns: [
      {
        name: "USES_VERB",
        regex: /\buses\b/i,
      },
    ],
  },
  {
    suggestedRelation: "REQUIRES",
    patterns: [
      {
        name: "REQUIRES_VERB",
        regex: /\brequires\b/i,
      },
    ],
  },
  {
    suggestedRelation: "LOCATED_AT",
    patterns: [
      {
        name: "LOCATED_AT_PHRASE",
        regex: /\blocated at\b/i,
      },
      {
        name: "STORED_UNDER_PHRASE",
        regex: /\bstored under\b/i,
      },
      {
        name: "PATH_IS_PHRASE",
        regex: /\bpath is\b/i,
      },
    ],
  },
] as const);

export type SemanticCleanupLintOptions = {
  relationRefinement?: boolean;
  grammarLiteralArtifacts?: boolean;
};

export type SemanticLintAnalysisStatus = "analyzed" | "skipped-structurally-invalid";

function hasExplicitSelection(input?: ResolveMarkdownFilesInput): boolean {
  return (input?.files?.length ?? 0) > 0 || (input?.directories?.length ?? 0) > 0;
}

function findFirstMatchingPattern(
  text: string,
  patterns: ReadonlyArray<{ name: string; regex: RegExp }>,
): string | null {
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) return pattern.name;
  }

  return null;
}

function createSemanticIssue(
  file: string,
  line: number,
  code: string,
  message: string,
  details: Record<string, unknown>,
): FactLintIssue {
  return {
    code,
    severity: "warning",
    file,
    line,
    message,
    details,
  };
}

export function lintFactFileSemanticCleanup(
  filePath: string,
  content: string,
  options: SemanticCleanupLintOptions = {},
): FactFileLintResult & { analysisStatus: SemanticLintAnalysisStatus } {
  const structuralResult = lintFactFileContent(filePath, content);
  if (structuralResult.issues.some((issue) => issue.severity === "error")) {
    return {
      file: filePath,
      analysisStatus: "skipped-structurally-invalid",
      issues: [],
    };
  }

  const grammarLiteralArtifactsEnabled = options.grammarLiteralArtifacts ?? true;
  const relationRefinementEnabled = options.relationRefinement ?? true;
  const parsedFile = parseStructuredFactFileContent(content);
  const issues: FactLintIssue[] = [];

  for (const bullet of parsedFile.bullets) {
    if (bullet.parsed.relation !== "DEFINES") continue;

    const object = normalizeWhitespace(bullet.parsed.object);

    if (grammarLiteralArtifactsEnabled) {
      const matchedPattern = findFirstMatchingPattern(object, GRAMMAR_LITERAL_ARTIFACT_PATTERNS);
      if (matchedPattern) {
        issues.push(
          createSemanticIssue(
            filePath,
            bullet.lineNumber,
            SEMANTIC_WARNING_CODES.GRAMMAR_LITERAL_ARTIFACT,
            "Object looks like a migrated grammar literal; consider rewriting with an explicit format/object split.",
            { matchedPattern },
          ),
        );
        continue;
      }
    }

    if (!relationRefinementEnabled) continue;

    const matchedFamilies = RELATION_REFINEMENT_FAMILIES.flatMap((family) => {
      const matchedPattern = findFirstMatchingPattern(object, family.patterns);
      if (!matchedPattern) return [];

      return [{ suggestedRelation: family.suggestedRelation, matchedPattern }];
    });

    if (matchedFamilies.length !== 1) continue;

    const [match] = matchedFamilies;
    issues.push(
      createSemanticIssue(
        filePath,
        bullet.lineNumber,
        SEMANTIC_WARNING_CODES.RELATION_REFINEMENT_CANDIDATE,
        `Relation 'DEFINES' looks too generic; consider '${match.suggestedRelation}'.`,
        {
          suggestedRelation: match.suggestedRelation,
          matchedPattern: match.matchedPattern,
        },
      ),
    );
  }

  return {
    file: filePath,
    analysisStatus: "analyzed",
    issues: sortFactLintIssues(issues),
  };
}

export function lintKnowledgeBaseSemanticCleanup(
  kbRoot: string,
  input?: ResolveMarkdownFilesInput,
  options: SemanticCleanupLintOptions = {},
): KnowledgeBaseLintResult {
  const resolved = hasExplicitSelection(input)
    ? resolveMarkdownFiles(kbRoot, input ?? {})
    : { files: listMarkdownFiles(kbRoot), warnings: [] };

  const issues: FactLintIssue[] = [];
  const warnings = [...resolved.warnings];

  for (const file of resolved.files) {
    try {
      const absolutePath = ensureWithinRoot(kbRoot, file);
      if (!fs.existsSync(absolutePath)) {
        warnings.push(`Skipped missing file during semantic cleanup: ${file}`);
        continue;
      }

      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        warnings.push(`Skipped non-file path during semantic cleanup: ${file}`);
        continue;
      }

      const content = fs.readFileSync(absolutePath, "utf8");
      const result = lintFactFileSemanticCleanup(file, content, options);
      if (result.analysisStatus === "analyzed") {
        issues.push(...result.issues);
        continue;
      }

      warnings.push(`Skipped structurally invalid file during semantic cleanup: ${file}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped unreadable file during semantic cleanup: ${file} (${message})`);
    }
  }

  return {
    files: [...resolved.files],
    issues: sortFactLintIssues(issues),
    warnings,
  };
}
