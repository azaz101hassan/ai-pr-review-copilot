import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { reviewFindings } from '../schema';
import { IReviewFindingRepository } from '@/modules/reviews/types/review-finding.repository';
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
}
