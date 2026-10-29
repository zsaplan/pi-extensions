import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from '@earendil-works/pi-coding-agent';
import type {OutputBudget} from './review-core.js';

export const DEFAULT_DIFF_BUDGET: OutputBudget = {
  maxBytes: DEFAULT_MAX_BYTES * 3,
  maxLines: DEFAULT_MAX_LINES * 3,
};

export const LARGE_DIFF_BUDGET: OutputBudget = {
  maxBytes: 384 * 1024,
  maxLines: 10_000,
};
