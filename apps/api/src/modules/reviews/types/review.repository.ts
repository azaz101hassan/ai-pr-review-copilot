import {
  ReviewCompletionPatch,
  ReviewFailurePatch,
  ReviewInsert,
  ReviewRecord,
} from './review.types';

export const REVIEW_REPOSITORY = Symbol('ReviewRepository');

export interface IReviewRepository {
  // Inserts a new review row. The 3-step lifecycle (see ReviewsService)
  // calls this with status='in_progress' BEFORE the Claude call so a
  // process death doesn't leak an unfinalised attempt — the startup
  // sweep then finalises it as 'failed'/'process_terminated'.
  insert(record: ReviewInsert): void;

  findById(id: string): ReviewRecord | undefined;

  // Listing API. Capped at 100 rows by default to keep the response
  // bounded — Day 5/6 paginates properly when a listing UI lands.
  findAll(limit?: number): ReviewRecord[];

  // Flips an `in_progress` row to `completed` with the usage stats. Used
  // inside ReviewsService's transaction so completion + finding inserts
  // commit atomically.
  markCompleted(id: string, patch: ReviewCompletionPatch): void;

  // Flips an `in_progress` row to `failed` with the error fields. Used
  // on the Anthropic-error catch path; no transaction needed because
  // there are no findings to coordinate with.
  markFailed(id: string, patch: ReviewFailurePatch): void;

  // Startup sweep. Marks any `in_progress` row whose `created_at` is
  // older than the cutoff as `failed` with the given error_code (e.g.,
  // 'process_terminated'). Returns the number of rows updated.
  sweepStaleInProgress(opts: { olderThanMs: number; errorCode: string }): number;
}
