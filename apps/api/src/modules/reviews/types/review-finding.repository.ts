import { ReviewFindingInsert, ReviewFindingRecord } from './review-finding.types';

export const REVIEW_FINDING_REPOSITORY = Symbol('ReviewFindingRepository');

export interface IReviewFindingRepository {
  // Bulk insert. No-op safe on an empty array (a clean Claude review
  // emits an empty findings array, and we still want to write the parent
  // reviews row).
  insertMany(records: ReviewFindingInsert[]): void;

  // Returns findings for a single review in insertion order.
  findByReviewId(reviewId: string): ReviewFindingRecord[];
}
