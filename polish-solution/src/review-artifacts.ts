import type {
  CategoryReviewResult,
  ReviewCategory,
  ReviewCategoryConfig,
  ReviewConflict,
} from './review-core.js';

export type ReviewArtifactEntryBaseFields = {
  version: 1;
  toolName: 'polish_solution_review';
  toolCallId: string;
  runId: string;
  timestamp: string;
};

export type ReviewArtifactErrorRecord = {
  name: string;
  message: string;
  stack?: string;
};

export type ReviewCategoryContext = {
  category?: ReviewCategory;
  ordinal?: number;
  totalCategories?: number;
};

export type CategoryStartedArtifactEntry = ReviewArtifactEntryBaseFields & {
  entryType: 'category-started';
  category: ReviewCategory;
  ordinal: number;
  totalCategories: number;
  label: string;
};

export type ReviewerEventArtifactEntry = ReviewArtifactEntryBaseFields &
  ReviewCategoryContext & {
    entryType: 'reviewer-event';
    event: unknown;
  };

export type CategoryFinishedArtifactEntry = ReviewArtifactEntryBaseFields & {
  entryType: 'category-finished';
  category: ReviewCategory;
  ordinal: number;
  totalCategories: number;
  status: 'success' | 'error';
  result?: CategoryReviewResult;
  error?: ReviewArtifactErrorRecord;
  completedCategoryResults?: CategoryReviewResult[];
};

export type ConflictAnalysisArtifactEntry = ReviewArtifactEntryBaseFields & {
  entryType: 'conflict-analysis';
  categoryResults: CategoryReviewResult[];
  conflicts: ReviewConflict[];
};

export function buildCategoryStartedArtifactEntry(
  base: ReviewArtifactEntryBaseFields,
  categoryConfig: ReviewCategoryConfig,
  ordinal: number,
  totalCategories: number,
): CategoryStartedArtifactEntry {
  return {
    ...base,
    entryType: 'category-started',
    category: categoryConfig.category,
    ordinal,
    totalCategories,
    label: categoryConfig.label,
  };
}

export function buildReviewerEventArtifactEntry(
  base: ReviewArtifactEntryBaseFields,
  event: unknown,
  categoryContext?: ReviewCategoryContext,
): ReviewerEventArtifactEntry {
  return {
    ...base,
    entryType: 'reviewer-event',
    ...(categoryContext ?? {}),
    event,
  };
}

export function buildCategoryFinishedArtifactEntry(
  base: ReviewArtifactEntryBaseFields,
  options: Omit<
    CategoryFinishedArtifactEntry,
    keyof ReviewArtifactEntryBaseFields | 'entryType'
  >,
): CategoryFinishedArtifactEntry {
  return {
    ...base,
    entryType: 'category-finished',
    ...options,
  };
}

export function buildConflictAnalysisArtifactEntry(
  base: ReviewArtifactEntryBaseFields,
  categoryResults: CategoryReviewResult[],
  conflicts: ReviewConflict[],
): ConflictAnalysisArtifactEntry {
  return {
    ...base,
    entryType: 'conflict-analysis',
    categoryResults,
    conflicts,
  };
}
