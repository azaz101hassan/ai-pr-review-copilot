import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { reviews } from '../schema';
import { IReviewRepository } from '@/modules/reviews/types/review.repository';
import {
  ReviewCompletionPatch,
  ReviewFailurePatch,
  ReviewInsert,
  ReviewRecord,
} from '@/modules/reviews/types/review.types';

@Injectable()
export class SqliteReviewsRepository implements IReviewRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(record: ReviewInsert): void {
    this.db.drizzle.insert(reviews).values(record).run();
  }

  findById(id: string): ReviewRecord | undefined {
    return this.db.drizzle.select().from(reviews).where(eq(reviews.id, id)).get();
  }

  findAll(limit = 100): ReviewRecord[] {
    return this.db.drizzle
      .select()
      .from(reviews)
      .orderBy(desc(reviews.created_at))
      .limit(limit)
      .all();
  }

  markCompleted(id: string, patch: ReviewCompletionPatch): void {
    this.db.drizzle
      .update(reviews)
      .set({
        status: 'completed',
        completed_at: patch.completed_at,
        input_tokens: patch.input_tokens,
        output_tokens: patch.output_tokens,
        cache_creation_input_tokens: patch.cache_creation_input_tokens,
        cache_read_input_tokens: patch.cache_read_input_tokens,
        // Drizzle's `json` mode handles serialization. Skip the SET
        // for both undefined AND null — otherwise drizzle-orm may
        // serialize `null` as the literal JSON string "null" in a
        // `mode: 'json'` text column, which breaks `WHERE
        // tool_calls_json IS NULL` queries in Day-6 eval. Skipping
        // leaves the column at its schema default (turn_count = 0,
        // tool_calls_json = SQL NULL).
        ...(patch.turn_count !== undefined && patch.turn_count !== null
          ? { turn_count: patch.turn_count }
          : {}),
        ...(patch.tool_calls !== undefined && patch.tool_calls !== null
          ? { tool_calls_json: patch.tool_calls }
          : {}),
      })
      .where(eq(reviews.id, id))
      .run();
  }

  markFailed(id: string, patch: ReviewFailurePatch): void {
    this.db.drizzle
      .update(reviews)
      .set({
        status: 'failed',
        completed_at: patch.completed_at,
        error_status: patch.error_status,
        error_code: patch.error_code,
        ...(patch.turn_count !== undefined && patch.turn_count !== null
          ? { turn_count: patch.turn_count }
          : {}),
        ...(patch.tool_calls !== undefined && patch.tool_calls !== null
          ? { tool_calls_json: patch.tool_calls }
          : {}),
      })
      .where(eq(reviews.id, id))
      .run();
  }

  sweepStaleInProgress(opts: { olderThanMs: number; errorCode: string }): number {
    const cutoff = new Date(Date.now() - opts.olderThanMs);
    const now = new Date();
    const result = this.db.drizzle
      .update(reviews)
      .set({
        status: 'failed',
        error_code: opts.errorCode,
        completed_at: now,
      })
      .where(
        and(
          eq(reviews.status, 'in_progress'),
          lt(reviews.created_at, cutoff),
        ),
      )
      .run();
    return Number(result.changes);
  }
}
