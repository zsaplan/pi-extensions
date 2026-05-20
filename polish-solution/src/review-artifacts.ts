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
  category: ReviewCategory;
  ordinal?: number;
  totalCategories?: number;
};

export function buildCategoryStartedArtifactEntry(
  base: ReviewArtifactEntryBaseFields,
  categoryConfig: ReviewCategoryConfig,
  ordinal: number,
  totalCategories: number,
) {
  return {
    ...base,
    entryType: 'category-started' as const,
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
) {
  return {
    ...base,
    entryType: 'reviewer-event' as const,
    ...(categoryContext ?? {}),
    event,
  };
}

export function buildCategoryFinishedArtifactEntry(
  base: ReviewArtifactEntryBaseFields,
  options: {
    category: ReviewCategory;
    ordinal: number;
    totalCategories: number;
    status: 'success' | 'error';
    result?: CategoryReviewResult;
    error?: ReviewArtifactErrorRecord;
    completedCategoryResults?: CategoryReviewResult[];
  },
) {
  return {
    ...base,
    entryType: 'category-finished' as const,
    ...options,
  };
}

export function buildConflictAnalysisArtifactEntry(
  base: ReviewArtifactEntryBaseFields,
  categoryResults: CategoryReviewResult[],
  conflicts: ReviewConflict[],
) {
  return {
    ...base,
    entryType: 'conflict-analysis' as const,
    categoryResults,
    conflicts,
  };
}
