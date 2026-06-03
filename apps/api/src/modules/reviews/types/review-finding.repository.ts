import type { PriorReviewEntry } from './repo-context-provider';
import { ReviewFindingInsert, ReviewFindingRecord } from './review-finding.types';

export const REVIEW_FINDING_REPOSITORY = Symbol('ReviewFindingRepository');

export interface IReviewFindingRepository {
  // Bulk insert. No-op safe on an empty array (a clean Claude review
  // emits an empty findings array, and we still want to write the parent
  // reviews row).
  insertMany(records: ReviewFindingInsert[]): void;

  // Returns findings for a single review in insertion order.
  findByReviewId(reviewId: string): ReviewFindingRecord[];

  // DB-backed source for fetchPriorReview. Joins reviews INNER JOIN
  // review_findings filtered to successfully-completed prior runs on
  // the same PR. Most-recent-first ordering by the parent review's
  // completed_at. Caller (GitHubRepoContextProvider) applies
  // file_path / rule_id filters in-memory over the returned list.
  //
  // Returns the PriorReviewEntry shape rather than a raw row union so
  // the provider doesn't need to know about JOIN columns.
  // `dismissed_at` is always null until a dismiss column lands; the
  // shape carries it for forward compat with the prior-review JSON
  // fixtures.
  findByPrNodeIdForPriorReview(prNodeId: string): PriorReviewEntry[];
}
