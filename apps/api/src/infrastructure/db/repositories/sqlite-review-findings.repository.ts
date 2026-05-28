import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { reviewFindings, reviews } from '../schema';
import { IReviewFindingRepository } from '@/modules/reviews/types/review-finding.repository';
import type { PriorReviewEntry } from '@/modules/reviews/types/repo-context-provider';
import {
  ReviewFindingInsert,
  ReviewFindingRecord,
} from '@/modules/reviews/types/review-finding.types';

@Injectable()
export class SqliteReviewFindingsRepository implements IReviewFindingRepository {
  constructor(private readonly db: DatabaseService) {}

  insertMany(records: ReviewFindingInsert[]): void {
    if (records.length === 0) return;

    // SYNCHRONOUS ONLY — better-sqlite3's transaction(fn) commits on the
    // first await. See https://github.com/WiseLibs/better-sqlite3#transactionfunction-function---function
    this.db.transaction(() => {
      for (const record of records) {
        this.db.drizzle.insert(reviewFindings).values(record).run();
      }
    });
  }

  findByReviewId(reviewId: string): ReviewFindingRecord[] {
    return this.db.drizzle
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.review_id, reviewId))
      .orderBy(asc(reviewFindings.created_at))
      .all();
  }

  // Day-5 R8 closure: prior-review fetch for the agent loop.
  // Joins reviews INNER JOIN review_findings filtered to successfully-
  // completed prior runs only (status='completed' AND error_code IS NULL).
  // Ordering by reviews.completed_at DESC keeps the most-recent run
  // first, so when the agent loop applies its own dedup the freshest
  // verdict wins. The composite `idx_reviews_pr_node_id` index keeps
  // the filter cheap; review_findings's `idx_review_findings_review_id`
  // makes the join O(matches).
  //
  // `dismissed_at` is mapped to `null` until a future column lands —
  // the Day-5 fixtures don't have a dismiss-from-PR-UI surface yet.
  findByPrNodeIdForPriorReview(prNodeId: string): PriorReviewEntry[] {
    const rows = this.db.drizzle
      .select({
        review_id: reviews.id,
        finding_id: reviewFindings.id,
        rule_id: reviewFindings.rule_id,
        // location_hint is nullable; coalesce to empty string at read
        // time so the PriorReviewEntry shape (non-null) holds.
        location_hint: reviewFindings.location_hint,
        message: reviewFindings.message,
      })
      .from(reviews)
      .innerJoin(reviewFindings, eq(reviews.id, reviewFindings.review_id))
      .where(
        and(
          eq(reviews.pr_node_id, prNodeId),
          eq(reviews.status, 'completed'),
          isNull(reviews.error_code),
        ),
      )
      .orderBy(desc(reviews.completed_at), asc(reviewFindings.created_at))
      .all();

    return rows.map((row) => ({
      review_id: row.review_id,
      finding_id: row.finding_id,
      rule_id: row.rule_id,
      // F8 closure: location_hint is shaped like 'src/foo.ts:42'
      // (file + line), but PriorReviewEntry.file_path is filtered
      // via strict equality against the caller's CLEAN path
      // ('src/foo.ts'). The previous code put the full hint into
      // file_path, which silently broke per-file prior-review
      // filtering in R8 — the filter virtually never matched.
      // Extract the file portion (everything before the first ':')
      // so the equality holds. Empty hint → empty file_path
      // (matches nothing, which is the honest signal).
      file_path: extractFilePath(row.location_hint),
      location_hint: row.location_hint ?? '',
      message: row.message,
      dismissed_at: null,
    }));
  }
}

// Day-5 F8 closure. Slice the file portion out of a Claude-emitted
// location_hint like 'src/foo.ts:42' or 'src/foo.ts:42-50'. Returns
// empty string for null/empty hints. Tolerant of paths that contain
// colons themselves (Windows-style drive letters) by splitting on
// the LAST colon followed by a digit; for Day 5 the corpus is
// Unix-style so the first-colon split is sufficient and the future-
// proofing can land when Day-9 cross-platform tests need it.
function extractFilePath(locationHint: string | null): string {
  if (!locationHint) return '';
  const colonIdx = locationHint.indexOf(':');
  if (colonIdx === -1) return locationHint;
  return locationHint.slice(0, colonIdx);
}
